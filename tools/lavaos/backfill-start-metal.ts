// Backfill games.start_metal_storage on a deployed LOS store, so the
// start-metal rule (src/lavaos/lava.ts, ALGO_VERSION 4) can be applied by a
// rebase.
//
//   pnpm run lavaos:backfill-start-metal -- --url https://lavabalance.fogofwar.dev --dry
//   pnpm run lavaos:backfill-start-metal -- --url https://lavabalance.fogofwar.dev
//
// Rows stored before the column have no value, and rebase refuses while any
// game since the rule's cutoff lacks one (it would otherwise drop them all as
// if played on the wrong storage). The store fills the column from a
// DUPLICATE upload of the same game (backfillGameFacts), so this lists every
// stored game since the cutoff (GET /api/games, newest first), fetches its
// verbatim detail from api.bar-rts.com and re-POSTs it to /api/games. Nothing
// else changes: a duplicate never touches the fold. Every game must come back
// "duplicate" — anything else aborts, since it would mean a game entered the
// fold here.
//
// Idempotent (a filled column is never overwritten): re-run to resume. Then
// rebase from the first game on or after the cutoff.

import { parseArgs } from "node:util";
import { START_METAL_RULE_FROM } from "../../src/lavaos/lava";

const { values: args } = parseArgs({
  allowPositionals: true, // pnpm passes the "--" separator through
  options: {
    url: { type: "string", default: "http://localhost:8787" },
    from: { type: "string", default: START_METAL_RULE_FROM },
    batch: { type: "string", default: "20" },
    dry: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(
    `Usage: pnpm run lavaos:backfill-start-metal -- [options]

Options:
  --url URL      the LOS service (default: http://localhost:8787 — wrangler dev)
  --from ISO     oldest start time to backfill (default: ${START_METAL_RULE_FROM})
  --batch N      games per upload (default: 20)
  --dry          list and fetch, print each game's start metal storage, upload nothing`,
  );
  process.exit(0);
}

const base = args.url.replace(/\/$/, "");
const batchSize = Math.max(1, Number(args.batch) || 20);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url).catch((e) => e as Error);
    if (!(res instanceof Error) && res.ok) return res.json();
    if (attempt === 3) throw new Error(`GET ${url}: ${res instanceof Error ? res.message : res.status}`);
    await sleep(2000 * attempt);
  }
}

// Every stored game since --from, oldest first (upload order is irrelevant
// for duplicates, but the earliest id is what the rebase starts from).
const stored: { id: string; startTime: string }[] = [];
for (let page = 1; ; page++) {
  const d = await getJson(`${base}/api/games?page=${page}&limit=100`);
  const games = d.games as { id: string; startTime: string }[];
  stored.push(...games.filter((g) => g.startTime >= args.from!));
  if (games.length === 0 || games[games.length - 1].startTime < args.from!) break;
}
stored.sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id));
console.log(`${stored.length} stored games since ${args.from}`);
if (stored.length === 0) process.exit(0);

const tally = new Map<string, number>();
let sent = 0;
for (let i = 0; i < stored.length; i += batchSize) {
  const details: any[] = [];
  for (const g of stored.slice(i, i + batchSize)) {
    const r = await getJson(`https://api.bar-rts.com/replays/${g.id}`);
    const v = String(r.gameSettings?.startmetalstorage ?? "none");
    tally.set(v, (tally.get(v) ?? 0) + 1);
    if (args.dry || v !== "4000") console.log(`${g.startTime} ${g.id} startmetalstorage=${v}`);
    details.push(r);
    await sleep(150);
  }
  if (args.dry) continue;
  const res = await fetch(`${base}/api/games`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(details),
  });
  if (!res.ok) throw new Error(`POST /api/games: ${res.status} ${await res.text()}`);
  const out = (await res.json()) as { duplicate: string[] };
  if (out.duplicate.length !== details.length) {
    throw new Error(`expected only duplicates, got ${JSON.stringify(out)}`);
  }
  sent += details.length;
  console.log(`backfilled ${sent}/${stored.length}`);
}

console.log(`start metal storage: ${[...tally].map(([v, n]) => `${v}×${n}`).join(", ")}`);
console.log(`next: rebase from ${stored[0].id} (${stored[0].startTime}), "Re-run LOS from here" on /games`);
