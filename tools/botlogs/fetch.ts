// Fetch the bot container's logs (its stdout) for the past N hours from the
// Cloudflare Workers Observability API and print them as structured JSON.
//
//   pnpm run bot:logs -- --hours 3 > logs.json
//   pnpm run bot:logs -- --hours 24 --ndjson | jq 'select(.level == "error")'
//
// `wrangler tail` never shows container stdout; the dashboard's Logs view and
// this API do (dataset "containers"). Read-only: needs CLOUDFLARE_API_TOKEN with
// Workers Observability read (and Containers read, to find the application by
// name). The account is CLOUDFLARE_ACCOUNT_ID, or the token's only account.
//
// Output: one record per line, oldest first, shaped by tools/botlogs/parse.ts —
//   {ts, level, kind: "event", msg, …fields}   logEvent / status / logError lines
//   {ts, level, kind: "chat", chat, where?, from, via?, text}   SAID* chat lines
//                                              (via = the host relaying in-game chat)
//   {ts, level, kind: "line", text}            everything else printed plainly
// each with `container` (short instance id; a change = a restart) and `id`.

import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { toRecords, type ObservabilityEvent } from "./parse";

const API = "https://api.cloudflare.com/client/v4";
/** The query endpoint's own cap on `limit`. */
const PAGE_LIMIT = 2000;
/** Below this a window that still overflows is not split further. */
const MIN_WINDOW_MS = 1000;

// `pnpm run bot:logs -- --hours 3` hands us the "--" itself, and parseArgs
// would read every option after it as a positional.
const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();

const { values: args } = parseArgs({
  args: argv,
  options: {
    hours: { type: "string", default: "1" },
    since: { type: "string" },
    until: { type: "string" },
    app: { type: "string", default: "lavabalance-botcontainer" },
    account: { type: "string" },
    ndjson: { type: "boolean", default: false },
    out: { type: "string", short: "o" },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(`Usage: pnpm run bot:logs -- [options]

Options:
  --hours N       how far back to fetch (default 1; fractions allowed)
  --since ISO     start time instead of --hours (e.g. 2026-11-13T22:00Z)
  --until ISO     end time (default: now)
  --app NAME|ID   container application (default: lavabalance-botcontainer)
  --account ID    Cloudflare account (default: CLOUDFLARE_ACCOUNT_ID, else the token's only account)
  --ndjson        one JSON object per line instead of a JSON array
  -o, --out FILE  write to FILE instead of stdout

Env: CLOUDFLARE_API_TOKEN (Workers Observability read + Containers read).`);
  process.exit(0);
}

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) fail("CLOUDFLARE_API_TOKEN is not set");

function fail(msg: string): never {
  console.error(`bot:logs: ${msg}`);
  process.exit(1);
}

async function cf<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: { success?: boolean; result?: T; errors?: unknown } | undefined;
  try {
    json = JSON.parse(text);
  } catch {
    /* reported below */
  }
  if (!res.ok || !json?.success) {
    const why = json?.errors ? JSON.stringify(json.errors) : text.slice(0, 300);
    throw new Error(`cloudflare ${method} ${path} returned ${res.status}: ${why}`);
  }
  return json.result as T;
}

async function resolveAccount(): Promise<string> {
  const given = args.account ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (given) return given;
  const accounts = await cf<{ id: string; name: string }[]>("GET", "/accounts");
  if (accounts.length !== 1) {
    fail(`the token sees ${accounts.length} accounts; pass --account (${accounts.map((a) => `${a.id} ${a.name}`).join(", ")})`);
  }
  return accounts[0]!.id;
}

async function resolveApp(account: string): Promise<string> {
  const app = args.app!;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(app)) return app;
  const apps = await cf<{ id: string; name: string }[]>("GET", `/accounts/${account}/containers/applications`);
  const hit = apps.find((a) => a.name === app);
  if (!hit) fail(`no container application named "${app}" (have: ${apps.map((a) => a.name).join(", ") || "none"})`);
  return hit.id;
}

/** One query over [from, to]; a full page means the window was truncated. */
async function queryWindow(account: string, appId: string, from: number, to: number): Promise<ObservabilityEvent[]> {
  const result = await cf<{ events?: { events?: ObservabilityEvent[] } }>(
    "POST",
    `/accounts/${account}/workers/observability/telemetry/query`,
    {
      queryId: "bot-logs",
      view: "events",
      limit: PAGE_LIMIT,
      timeframe: { from, to },
      parameters: {
        datasets: ["containers"],
        filters: [
          { key: "$metadata.type", operation: "eq", type: "string", value: "cf-container" },
          { key: "$metadata.service", operation: "eq", type: "string", value: appId },
        ],
      },
    },
  );
  return result.events?.events ?? [];
}

/** Every event in [from, to], halving any window that hits the page cap. */
async function fetchRange(account: string, appId: string, from: number, to: number): Promise<ObservabilityEvent[]> {
  const events = await queryWindow(account, appId, from, to);
  if (events.length < PAGE_LIMIT) return events;
  if (to - from <= MIN_WINDOW_MS) {
    console.error(`bot:logs: warning: over ${PAGE_LIMIT} lines within ${new Date(from).toISOString()}+${to - from}ms, some dropped`);
    return events;
  }
  const mid = Math.floor((from + to) / 2);
  return [...(await fetchRange(account, appId, from, mid)), ...(await fetchRange(account, appId, mid + 1, to))];
}

function parseTime(s: string, flag: string): number {
  const t = Date.parse(s);
  if (Number.isNaN(t)) fail(`${flag}: not a date: ${s}`);
  return t;
}

async function main(): Promise<void> {
  const to = args.until ? parseTime(args.until, "--until") : Date.now();
  let from: number;
  if (args.since) from = parseTime(args.since, "--since");
  else {
    const hours = Number(args.hours);
    if (!(hours > 0)) fail(`--hours: expected a positive number, got ${args.hours}`);
    from = to - hours * 3600_000;
  }
  if (from >= to) fail("the start time is not before the end time");

  const account = await resolveAccount();
  const appId = await resolveApp(account);

  // Hour-sized windows keep most queries under the page cap (the bot writes
  // ~500 lines an hour while a lobby is active); busier ones are split.
  const events: ObservabilityEvent[] = [];
  for (let start = from; start < to; start += 3600_000) {
    events.push(...(await fetchRange(account, appId, start, Math.min(start + 3600_000 - 1, to))));
  }
  const records = toRecords(events);

  const text = args.ndjson
    ? records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "")
    : JSON.stringify(records, null, 2) + "\n";
  if (args.out) {
    writeFileSync(args.out, text);
    console.error(`bot:logs: ${records.length} lines → ${args.out}`);
  } else process.stdout.write(text);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
