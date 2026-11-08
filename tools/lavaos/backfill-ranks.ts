// Backfill game_players.bar_rank on the DEPLOYED LOS store, by running SQL
// straight against its Durable Object.
//
//   export CLOUDFLARE_API_TOKEN=...            # or CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL
//   pnpm run lavaos:backfill-ranks -- --dry     # what it would fill, writes nothing
//   pnpm run lavaos:backfill-ranks              # fill them
//   pnpm run lavaos:backfill-ranks -- --sql "SELECT COUNT(*) FROM game_players"
//
// WHY THIS EXISTS: the chevron (BAR's per-game experience badge — see
// game_players.bar_rank in docs/lavaos-cloudflare-data-model.md) started being
// recorded when the column shipped. Every game stored before that has NULL, and
// nothing inside the service can repair it: only an upload carries the field,
// and re-uploading a stored game is a no-op by design (uploadSync answers
// "duplicate" and returns). So the repair has to come from outside, with the
// chevrons re-read from the source the upload had — the verbatim
// api.bar-rts.com replay detail.
//
// WHY SQL RATHER THAN THE SERVICE'S OWN API: no route updates a stored game,
// and adding one would mean a deploy plus a permanently open write path (the LOS
// routes carry no auth) for a job that runs once. The Durable Object's SQLite is
// reachable directly:
//
//   POST /accounts/<account>/workers/durable_objects/namespaces/<ns>/query
//
// on api.cloudflare.com/client/v4, with an ordinary account API token. That route
// is UNDOCUMENTED — absent from Cloudflare's published OpenAPI schema — so its
// contract is taken from what the dashboard's own SQL console sends:
//
//   {"queries":[{"sql":"select 1"}],"durable_object_id":"<64-hex>"}
//
// The OBJECT ID is required and is the part that is easy to miss: a namespace
// holds many objects, so naming only the namespace is a 400 ("Bad request", with
// nothing saying which field is absent). It is discovered through the DOCUMENTED
// objects endpoint rather than pasted, since only one object in this namespace
// holds data — the singleton. probe() still tries variants around the known
// shape and prints what the server said when all fail, because an undocumented
// route can change under us: the fix is then one entry in QUERY_SHAPES.
//
// NO BOUND PARAMETERS: an undocumented route may or may not bind them, and a
// shape that silently ignored a params array would send `?` through as a
// literal. Values are inlined instead, which is safe here because every one is
// checked against a shape that cannot carry SQL — a lowercase-hex game id and
// two small integers (sqlHexId / sqlInt below). Anything else is dropped.
//
// SAFE TO RE-RUN: every write is `... WHERE bar_rank IS NULL`, so a row that
// already has a chevron is never touched and a half-finished run resumes by
// running again. It never inserts, never deletes, and writes no column but
// bar_rank.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    account: { type: "string" },
    namespace: { type: "string" },
    object: { type: "string" },
    class: { type: "string", default: "LosDO" },
    data: { type: "string", default: "data" },
    api: { type: "string", default: "https://api.bar-rts.com" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "4" },
    sql: { type: "string" },
    cf: { type: "string", default: "https://api.cloudflare.com/client/v4" },
    dry: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(
    `Usage: pnpm run lavaos:backfill-ranks -- [options]

Fills game_players.bar_rank for games stored before the column existed, reading
each chevron from the verbatim BAR replay detail (a local day file when there is
one, else the BAR API) and writing it straight to the Durable Object's SQLite.

Auth (one of):
  CLOUDFLARE_API_TOKEN            account API token
  CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL

Options:
  --account ID        Cloudflare account id (default: $CLOUDFLARE_ACCOUNT_ID)
  --namespace ID      DO namespace id (default: found by --class)
  --object ID         DO object id to query (default: the namespace's only one)
  --class NAME        DO class to find the namespace by (default: LosDO)
  --data DIR          scraped day files to prefer over the API (default: data)
  --api URL           BAR API base (default: https://api.bar-rts.com)
  --limit N           stop after N games (default: all of them)
  --concurrency N     parallel detail fetches and writes (default: 4)
  --sql "SELECT ..."  run one statement, print the result, exit (the escape hatch)
  --cf URL            Cloudflare API base (override for testing against a stub)
  --dry               report what would be filled, write nothing
  --verbose           print every request and raw reply`,
  );
  process.exit(0);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const account = args.account ?? process.env.CLOUDFLARE_ACCOUNT_ID;
if (!account) fail("no account id: pass --account or set $CLOUDFLARE_ACCOUNT_ID");

const authHeaders = ((): Record<string, string> => {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (token) return { authorization: `Bearer ${token}` };
  const key = process.env.CLOUDFLARE_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL;
  if (key && email) return { "x-auth-key": key, "x-auth-email": email };
  return fail(
    "no credentials: set $CLOUDFLARE_API_TOKEN, or $CLOUDFLARE_API_KEY with $CLOUDFLARE_EMAIL",
  );
})();

const CF = args.cf.replace(/\/$/, "");
const limit = args.limit ? Number(args.limit) : Infinity;
const concurrency = Math.max(1, Number(args.concurrency));

// BAR ships eight chevron levels (0..7); the bound is loose for the same reason
// as parseBarRank in src/los/losGames.ts — a level added later is worth keeping.
// 0 is a REAL level (an account with under five hours) and must survive as 0.
const BAR_RANK_MAX = 15;

const barRankOf = (rank: unknown): number | null =>
  typeof rank === "number" && Number.isInteger(rank) && rank >= 0 && rank <= BAR_RANK_MAX
    ? rank
    : null;

/** A game id as a SQL literal, or null if it is not one. Replay ids are
 * lowercase hex, which cannot carry a quote, a comment or a statement break —
 * which is what makes inlining it sound. */
function sqlHexId(id: unknown): string | null {
  return typeof id === "string" && /^[0-9a-f]{1,64}$/i.test(id) ? `'${id.toLowerCase()}'` : null;
}

/** An integer as a SQL literal, or null. */
function sqlInt(n: unknown): string | null {
  return typeof n === "number" && Number.isSafeInteger(n) ? String(n) : null;
}

// ---------------------------------------------------------------- the API

/** One Cloudflare API call, unwrapped from the standard envelope. */
async function cf(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${CF}/accounts/${account}${path}`;
  if (args.verbose) console.error(`-> ${init?.method ?? "GET"} ${url}`);
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...authHeaders, ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (args.verbose) console.error(`<- ${res.status} ${text.slice(0, 500)}`);
  let body: { success?: boolean; errors?: unknown[]; result?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${res.status} from ${path}: ${text.slice(0, 300)}`);
  }
  if (!res.ok || body.success === false) {
    // This API reports errors two ways — objects with a message, and (on the
    // query route) bare strings like "Bad request" — so read both rather than
    // mapping .message over strings and printing a row of "undefined".
    const why =
      (body.errors ?? [])
        .map((e) => (typeof e === "string" ? e : ((e as { message?: string })?.message ?? "")))
        .filter(Boolean)
        .join("; ") || text.slice(0, 300);
    throw new Error(`${res.status} from ${path}: ${why}`);
  }
  return body.result;
}

/** The namespace the LOS store lives in. Listing namespaces is a DOCUMENTED
 * endpoint, so this both discovers the id and — when one is passed — proves it
 * is the right database before a single row is written. */
async function findNamespace(): Promise<string> {
  const list = (await cf("/workers/durable_objects/namespaces")) as
    | { id: string; name?: string; class?: string; script?: string }[]
    | null;
  const all = list ?? [];
  if (args.namespace) {
    const named = all.find((n) => n.id === args.namespace);
    if (!named) {
      fail(
        `namespace ${args.namespace} is not among this account's ${all.length} namespaces — wrong account?`,
      );
    }
    if (named.class && named.class !== args.class) {
      fail(`namespace ${args.namespace} holds class ${named.class}, not ${args.class}`);
    }
    return named.id;
  }
  const matches = all.filter((n) => n.class === args.class);
  if (matches.length === 0) {
    const seen = all.map((n) => `${n.class ?? "?"} (${n.script ?? "?"})`).join(", ") || "none";
    fail(`no namespace with class ${args.class} in this account. Found: ${seen}`);
  }
  if (matches.length > 1) {
    fail(
      `${matches.length} namespaces hold class ${args.class} — name one with --namespace: ` +
        matches.map((n) => `${n.id} (${n.script ?? "?"})`).join(", "),
    );
  }
  console.log(
    `namespace ${matches[0].id} — class ${args.class}, script ${matches[0].script ?? "?"}`,
  );
  return matches[0].id;
}

/** WHICH object in the namespace to query. A namespace holds one object per id
 * the Worker ever addressed, and the query route needs to be told which — the
 * whole reason a namespace-only request is a bare "Bad request". Listing them is
 * DOCUMENTED, and the LOS store is a singleton (`idFromName("singleton")`), so
 * exactly one object should hold data; anything else is reported rather than
 * guessed at, since querying the wrong object would read an empty database and
 * report nothing to backfill. */
async function findObject(namespace: string): Promise<string> {
  if (args.object) return args.object;
  const list = (await cf(`/workers/durable_objects/namespaces/${namespace}/objects?limit=100`)) as
    | { id: string; hasStoredData?: boolean }[]
    | null;
  const all = list ?? [];
  const withData = all.filter((o) => o.hasStoredData !== false);
  if (withData.length === 1) {
    console.log(`object ${withData[0].id}`);
    return withData[0].id;
  }
  if (withData.length === 0) {
    fail(
      `no object with stored data in namespace ${namespace} — nothing has written to it yet?` +
        (all.length ? ` (${all.length} object(s) listed, all empty)` : ""),
    );
  }
  fail(
    `${withData.length} objects hold data in namespace ${namespace} — name one with --object:\n` +
      withData.map((o) => `  ${o.id}`).join("\n"),
  );
}

/** Request shapes for the undocumented query route. The FIRST is what the
 * dashboard's SQL console actually sends; the rest are near-variants kept only
 * so a change to the route costs one probe rather than a debugging session.
 * probe() settles on whichever the server accepts and every later call reuses
 * it. */
const QUERY_SHAPES: { name: string; body: (sql: string, objectId: string) => unknown }[] = [
  { name: "queries+durable_object_id", body: (sql, id) => ({ queries: [{ sql }], durable_object_id: id }) },
  { name: "queries+object_id", body: (sql, id) => ({ queries: [{ sql }], object_id: id }) },
  { name: "query+durable_object_id", body: (sql, id) => ({ query: sql, durable_object_id: id }) },
  { name: "sql+durable_object_id", body: (sql, id) => ({ sql, durable_object_id: id }) },
];

let shape: (typeof QUERY_SHAPES)[number] | null = null;
let namespaceId = "";
let objectId = "";

/** Pull rows out of whatever the query route answers with. The envelope is
 * Cloudflare's, but the payload inside it is undocumented, so this accepts the
 * handful of shapes such endpoints use (D1-style {results}, a bare array, a
 * per-statement array) and reports anything else as a surprise rather than
 * guessing. */
function rowsOf(result: unknown): Record<string, unknown>[] | null {
  const isObj = (r: unknown): r is Record<string, unknown> =>
    typeof r === "object" && r !== null && !Array.isArray(r);

  // ONE statement's payload -> rows. Two row shapes exist and only one is
  // self-describing: objects keyed by column name, and the POSITIONAL
  // {columns, rows} the dashboard console uses, whose arrays must be zipped
  // against the column names. Handing those arrays back unzipped is not a
  // visible failure — every field lookup simply reads undefined, so the run
  // reports the right number of games and no work to do.
  const statementRows = (v: unknown): Record<string, unknown>[] | null => {
    if (isObj(v) && Array.isArray(v.columns) && Array.isArray(v.rows)) {
      const cols = v.columns.map(String);
      return (v.rows as unknown[]).map((row) =>
        Array.isArray(row)
          ? Object.fromEntries(cols.map((c, i) => [c, row[i]]))
          : (row as Record<string, unknown>),
      );
    }
    const list = Array.isArray(v)
      ? v
      : isObj(v) && Array.isArray(v.results)
        ? v.results
        : isObj(v) && Array.isArray(v.rows)
          ? v.rows
          : null;
    if (list === null) return null;
    return list.every(isObj) ? (list as Record<string, unknown>[]) : null;
  };

  // The request sends a LIST of queries, so the reply may carry one result per
  // statement. Unwrap that level first and read each statement's rows THROUGH
  // the same reader — an unwrap that returns its payload unchecked is what let
  // positional rows through as arrays.
  const outer = Array.isArray(result)
    ? result
    : isObj(result) && Array.isArray(result.results)
      ? result.results
      : null;
  const wraps = (r: unknown): boolean =>
    isObj(r) && (Array.isArray(r.results) || Array.isArray(r.rows) || Array.isArray(r.columns));
  if (outer !== null && outer.length > 0 && outer.every(wraps)) {
    const out: Record<string, unknown>[] = [];
    for (const statement of outer) {
      const rows = statementRows(statement);
      if (rows === null) return null;
      out.push(...rows);
    }
    return out;
  }
  return statementRows(result);
}

async function query(sql: string): Promise<Record<string, unknown>[]> {
  if (!shape) throw new Error("query() before probe()");
  const result = await cf(`/workers/durable_objects/namespaces/${namespaceId}/query`, {
    method: "POST",
    body: JSON.stringify(shape.body(sql, objectId)),
  });
  const rows = rowsOf(result);
  if (rows === null) {
    throw new Error(
      `the query route answered in a shape this script does not know:\n` +
        `${JSON.stringify(result).slice(0, 600)}\n` +
        `Teach rowsOf() that shape (tools/lavaos/backfill-ranks.ts).`,
    );
  }
  return rows;
}

const firstValue = (rows: Record<string, unknown>[]): number =>
  rows.length ? Number(Object.values(rows[0])[0] ?? 0) : 0;

/** Settle on a request shape with a harmless read, and prove the store is the
 * one expected. Every shape failing is the interesting case, so each server
 * reply is printed rather than collapsed into "it did not work". */
async function probe(): Promise<void> {
  const failures: string[] = [];
  for (const candidate of QUERY_SHAPES) {
    shape = candidate;
    try {
      const rows = await query(`SELECT COUNT(*) AS n FROM game_players`);
      console.log(`query route ok (${candidate.name} shape) — ${firstValue(rows)} game_players rows`);
      return;
    } catch (err) {
      failures.push(`  ${candidate.name}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  shape = null;
  fail(
    `the Durable Object query route refused every request shape:\n${failures.join("\n")}\n\n` +
      `A bare "Bad request" names no field, and the usual cause is the OBJECT:\n` +
      `  object   ${objectId}\n` +
      `  namespace ${namespaceId}\n` +
      `Check that id against the dashboard's SQL console (--object overrides it).\n` +
      `Otherwise the route is undocumented and may simply have changed: re-run\n` +
      `with --verbose for the raw replies, then add the working shape to\n` +
      `QUERY_SHAPES in tools/lavaos/backfill-ranks.ts.`,
  );
}

// ------------------------------------------------------------ the chevrons

interface DetailPlayer {
  userId: number;
  rank?: number | null;
}
interface ReplayDetail {
  id: string;
  AllyTeams?: { Players?: DetailPlayer[] }[];
}

/** userId -> chevron, for every player the detail states a level for. An empty
 * map means the source knows the game but recorded no ranks at all. */
function ranksOf(detail: ReplayDetail): Map<number, number> {
  const out = new Map<number, number>();
  for (const team of detail.AllyTeams ?? []) {
    for (const p of team.Players ?? []) {
      const rank = barRankOf(p?.rank);
      if (rank !== null && typeof p?.userId === "number") out.set(p.userId, rank);
    }
  }
  return out;
}

/** Index the scraped day files by game id. They hold the same verbatim details
 * the BAR API serves, already on disk, so a corpus covering the backlog turns
 * thousands of API fetches into none. A missing directory just means no index. */
async function loadDayFiles(): Promise<Map<string, ReplayDetail>> {
  const byId = new Map<string, ReplayDetail>();
  let files: string[];
  try {
    files = (await readdir(args.data)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    console.log(`no day files at ${args.data}/ — every chevron comes from the BAR API`);
    return byId;
  }
  for (const f of files.sort()) {
    const day = JSON.parse(await readFile(join(args.data, f), "utf8")) as ReplayDetail[];
    for (const detail of day) if (detail?.id) byId.set(detail.id, detail);
  }
  console.log(`indexed ${byId.size} replay details from ${files.length} day files in ${args.data}/`);
  return byId;
}

async function fetchDetail(id: string): Promise<ReplayDetail | null> {
  try {
    const res = await fetch(`${args.api.replace(/\/$/, "")}/replays/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return (await res.json()) as ReplayDetail;
  } catch {
    return null;
  }
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// ------------------------------------------------------------------- main

namespaceId = await findNamespace();
objectId = await findObject(namespaceId);
await probe();

if (args.sql) {
  console.log(JSON.stringify(await query(args.sql), null, 2));
  process.exit(0);
}

// The work list: games holding at least one player with no chevron. Oldest
// first, so a --limit run walks the backlog from the end nothing else will ever
// touch again and repeated runs make steady progress.
const pending = await query(
  `SELECT game_id, COUNT(*) AS missing, MIN(start_time) AS start_time
     FROM game_players
    WHERE bar_rank IS NULL
    GROUP BY game_id
    ORDER BY start_time, game_id`,
);
if (pending.length === 0) {
  console.log("every stored game already carries its chevrons — nothing to backfill");
  process.exit(0);
}
// Every row lacking the column it was asked for is a CONTRACT mismatch, not a
// store full of odd data — and it is silent otherwise: the count is right, the
// fields all read undefined, and the run ends "no chevrons to write" having
// looked at nothing. Check it once, against the row itself.
if (sqlHexId(pending[0].game_id) === null) {
  fail(
    `the query route answered rows this script cannot read — the first one is:\n` +
      `  ${JSON.stringify(pending[0]).slice(0, 300)}\n\n` +
      `Expected a game_id/missing/start_time per row. Re-run with --verbose to\n` +
      `see the raw reply, then teach rowsOf() that shape.`,
  );
}
const work = pending.slice(0, limit === Infinity ? undefined : limit);
const rowsPending = pending.reduce((n, r) => n + Number(r.missing ?? 0), 0);
console.log(
  `${pending.length} games missing chevrons (${rowsPending} player rows)` +
    (work.length < pending.length ? `; this run takes the oldest ${work.length}` : ""),
);

const dayFiles = await loadDayFiles();

// Read every chevron first, so the writes are one predictable pass and a
// failure while reading costs nothing but the reading.
const perGame = new Map<string, Map<number, number>>();
const counts = { fromFiles: 0, fromApi: 0, noRanks: 0, unreachable: 0, malformed: 0 };
let read = 0;

await pool(work, concurrency, async (row) => {
  const gameId = String(row.game_id);
  if (sqlHexId(gameId) === null) {
    counts.malformed++;
    return;
  }
  let detail = dayFiles.get(gameId);
  const source = detail ? "file" : "api";
  if (!detail) detail = (await fetchDetail(gameId)) ?? undefined;
  read++;
  if (read % 200 === 0) console.log(`  ...read ${read}/${work.length} games`);
  if (!detail) {
    counts.unreachable++;
    return;
  }
  const ranks = ranksOf(detail);
  if (ranks.size === 0) {
    // The source knows the game and states no rank for anybody. Nothing here
    // can fix that, so the game stays on the pending list for good — which is
    // why the summary reports it rather than leaving the count unexplained.
    counts.noRanks++;
    return;
  }
  if (source === "file") counts.fromFiles++;
  else counts.fromApi++;
  perGame.set(gameId, ranks);
});

const chevrons = [...perGame.values()].reduce((n, m) => n + m.size, 0);
console.log(
  `read ${counts.fromFiles} games from day files, ${counts.fromApi} from the API; ` +
    `${counts.noRanks} state no chevrons, ${counts.unreachable} could not be read` +
    (counts.malformed ? `, ${counts.malformed} had an unusable id` : ""),
);

if (perGame.size === 0) {
  console.log("no chevrons to write");
  process.exit(0);
}

/** ONE statement per game rather than per player: all sixteen rows share a
 * game_id, so a CASE over user_id carries the whole roster in a single call —
 * the difference between ~5k round trips and ~80k. */
function updateFor(gameId: string, ranks: Map<number, number>): string | null {
  const id = sqlHexId(gameId);
  if (id === null) return null;
  const arms: string[] = [];
  const ids: string[] = [];
  for (const [userId, rank] of ranks) {
    const u = sqlInt(userId);
    const r = sqlInt(rank);
    if (u === null || r === null) continue;
    arms.push(`WHEN ${u} THEN ${r}`);
    ids.push(u);
  }
  if (arms.length === 0) return null;
  return (
    `UPDATE game_players SET bar_rank = CASE user_id ${arms.join(" ")} END ` +
    `WHERE game_id = ${id} AND bar_rank IS NULL AND user_id IN (${ids.join(",")})`
  );
}

if (args.dry) {
  console.log(`--dry: would write ${chevrons} chevrons across ${perGame.size} games`);
  let shown = 0;
  for (const [gameId, ranks] of perGame) {
    if (shown++ >= 3) break;
    console.log(`  ${updateFor(gameId, ranks)}`);
  }
  if (perGame.size > 3) console.log(`  ... and ${perGame.size - 3} more statements`);
  process.exit(0);
}

// IS NULL on every write: a row that already has a chevron is never touched, so
// re-running is free and a run interrupted halfway simply resumes.
let sent = 0;
let failed = 0;
const games = [...perGame.entries()];
await pool(games, concurrency, async ([gameId, ranks]) => {
  const sql = updateFor(gameId, ranks);
  if (sql === null) return;
  try {
    await query(sql);
    sent++;
  } catch (err) {
    failed++;
    console.error(`  ${gameId}: ${(err as Error).message.split("\n")[0]}`);
  }
  if ((sent + failed) % 200 === 0) console.log(`  ...wrote ${sent + failed}/${games.length}`);
});

// What was SENT, not what changed: the write is `IS NULL`-guarded and the route
// reports no row count, so a game re-attempted because one of its players has no
// chevron in the source counts here while changing nothing. The remaining count
// below is the honest measure, and it is read back rather than computed.
const left = await query(`SELECT COUNT(*) AS n FROM game_players WHERE bar_rank IS NULL`);
const remaining = firstValue(left);
console.log(
  `done — ${sent} game${sent === 1 ? "" : "s"} written${failed ? `, ${failed} failed` : ""}; ` +
    `${remaining} player row${remaining === 1 ? "" : "s"} still without a chevron` +
    (remaining > 0
      ? ` (a row whose replay states no rank stays here for good — re-running cannot shrink it further)`
      : ""),
);
