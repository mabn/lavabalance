// Scrape lava games into per-day JSON files.
//
//   pnpm run scrape -- --from 2026-08-01 --to 2026-08-30
//
// Game DISCOVERY uses onetricklava.com (the lava community's own game index):
// GET /api/games?sort=started&order=desc&limit=100&offset=N returns
// {total, games:[{id, start_time, ...}]} newest-first, lava games only —
// ~40/day instead of the ~600/day the full bar-rts Supreme Isthmus list
// carries, which is what makes this fast. Offsets shift as new games finish,
// so: binary-search offsets for the date range boundaries (start of the
// from-day, end of the to-day), then walk pages stepping 90 — the 10-game
// overlap between consecutive pages absorbs shifts — and dedupe by id.
//
// Game CONTENT still comes from api.bar-rts.com: each discovered id is
// fetched as GET /replays/:id and the verbatim details (sorted by startTime)
// are written to <out>/<day>.json, exactly the format the old full-map
// scraper produced (los.ts and friends are unchanged). NOTE: day files now
// contain only the lava lobby's games, not every Supreme Isthmus game.
//
// Politeness is unchanged: connection reuse, small delays, retries with
// backoff, and a latency watchdog that pauses then aborts if either API
// slows down. Existing day files are skipped, so re-running resumes.

import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ReplayDetail } from "../../src/lavaos/types";

const RTS_API = "https://api.bar-rts.com";
const OTL_API = "https://onetricklava.com";
const PAGE_LIMIT = 100;
const PAGE_STEP = 90; // 10-game overlap between pages absorbs offset shifts
const RETRY_DELAYS_MS = [2000, 4000, 8000];
const WATCHDOG_WINDOW = 10;
const WATCHDOG_PAUSE_MS = 30_000;

interface OtlGame {
  id: string;
  start_time: string;
}
interface OtlPage {
  total: number;
  games: OtlGame[];
}

const { values: args } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string" },
    out: { type: "string", default: "data" },
    force: { type: "boolean", default: false },
    concurrency: { type: "string", default: "2" },
    delay: { type: "string", default: "150" },
    "max-latency": { type: "string", default: "500" },
    help: { type: "boolean", default: false },
  },
});

if (args.help || !args.from || !args.to) {
  console.log(
    `Usage: pnpm run scrape -- --from YYYY-MM-DD --to YYYY-MM-DD [options]

Options:
  --from YYYY-MM-DD   first UTC day to fetch (inclusive)
  --to YYYY-MM-DD     last UTC day to fetch (inclusive)
  --out DIR           output directory (default: data)
  --force             refetch days whose file already exists (and today)
  --concurrency N     parallel detail fetches (default: 2)
  --delay MS          pause between requests per worker (default: 150)
  --max-latency MS    abort when the rolling mean request time stays above
                      this (default: 500)`,
  );
  process.exit(args.help ? 0 : 1);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
for (const [flag, v] of [
  ["--from", args.from],
  ["--to", args.to],
] as const) {
  if (!DAY_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    console.error(`${flag} must be a valid YYYY-MM-DD date, got "${v}"`);
    process.exit(1);
  }
}
if (args.from > args.to) {
  console.error(`--from ${args.from} is after --to ${args.to}`);
  process.exit(1);
}
const concurrency = Math.max(1, Number(args.concurrency) || 1);
const delayMs = Math.max(0, Number(args.delay) || 0);
const maxLatencyMs = Math.max(1, Number(args["max-latency"]) || 500);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** UTC day math on "YYYY-MM-DD" strings. */
function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const todayUtc = new Date().toISOString().slice(0, 10);
// range boundaries: [start of from-day, start of the day after to-day)
const rangeStart = `${args.from}T00:00:00.000Z`;
const rangeEnd = `${nextDay(args.to)}T00:00:00.000Z`;

// --- latency watchdog (shared across both APIs): rolling mean of the last
// WATCHDOG_WINDOW request durations; one pause-and-recheck, then abort.
const durations: number[] = [];
let watchdogTripped = false;

async function checkWatchdog(): Promise<void> {
  if (durations.length < WATCHDOG_WINDOW) return;
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
  if (mean <= maxLatencyMs) return;
  if (watchdogTripped) {
    console.error(
      `abort: mean request time ${mean.toFixed(0)}ms > ${maxLatencyMs}ms even after a ${WATCHDOG_PAUSE_MS / 1000}s pause. ` +
        `Completed day files are valid; re-run the same command later to resume.`,
    );
    process.exit(2);
  }
  watchdogTripped = true;
  console.warn(
    `watchdog: mean request time ${mean.toFixed(0)}ms > ${maxLatencyMs}ms — pausing ${WATCHDOG_PAUSE_MS / 1000}s`,
  );
  durations.length = 0;
  await sleep(WATCHDOG_PAUSE_MS);
}

async function fetchJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      const elapsed = Date.now() - started;
      if (res.ok) {
        durations.push(elapsed);
        if (durations.length > WATCHDOG_WINDOW) durations.shift();
        await checkWatchdog();
        return (await res.json()) as T;
      }
      // 429/5xx are retryable; other 4xx mean the request itself is wrong.
      if (res.status !== 429 && res.status < 500) {
        throw new Error(`GET ${url} returned ${res.status} (not retryable)`);
      }
      if (attempt >= RETRY_DELAYS_MS.length) {
        throw new Error(`GET ${url} returned ${res.status} after ${attempt + 1} attempts`);
      }
      console.warn(`GET ${url} → ${res.status}, retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("GET ")) throw err;
      if (attempt >= RETRY_DELAYS_MS.length) {
        throw new Error(`GET ${url} failed after ${attempt + 1} attempts: ${err}`);
      }
      console.warn(`GET ${url} failed (${err}), retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s`);
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

async function otlPage(offset: number, limit: number): Promise<OtlPage> {
  return fetchJson<OtlPage>(
    `${OTL_API}/api/games?sort=started&order=desc&limit=${limit}&offset=${offset}`,
  );
}

/** start_time at an offset, or null when the offset is past the last game. */
async function timeAt(offset: number): Promise<string | null> {
  const page = await otlPage(offset, 1);
  return page.games[0]?.start_time ?? null;
}

/** Smallest offset whose game started BEFORE `boundary` (list is desc, so
 * times decrease as offset grows). Returns `total` when none is older. */
async function findOffset(boundary: string, total: number): Promise<number> {
  let lo = 0; // invariant candidates: time(lo) may be >= boundary
  let hi = total; // time(hi) treated as older-than-everything
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const t = await timeAt(mid);
    if (t === null || t < boundary) hi = mid;
    else lo = mid + 1;
    await sleep(delayMs);
  }
  return lo;
}

/** Discover all game ids in [rangeStart, rangeEnd) via onetricklava:
 * binary-search the boundary offsets, then walk pages stepping PAGE_STEP,
 * deduplicating the 10-game overlap. Returns ids grouped by UTC day. */
async function discoverIds(): Promise<Map<string, string[]>> {
  const total = (await otlPage(0, 1)).total;
  const startOffset = await findOffset(rangeEnd, total); // first game older than range end
  const endOffset = await findOffset(rangeStart, total); // first game older than range start
  console.log(
    `onetricklava: ${total} games total; range offsets [${startOffset}, ${endOffset}) ≈ ${endOffset - startOffset} games`,
  );

  const byDay = new Map<string, Set<string>>();
  let added = 0;
  for (let offset = startOffset; ; offset += PAGE_STEP) {
    const page = await otlPage(offset, PAGE_LIMIT);
    let pastRange = false;
    for (const g of page.games) {
      if (g.start_time >= rangeEnd) continue; // newer than range (offsets shifted)
      if (g.start_time < rangeStart) {
        pastRange = true;
        break;
      }
      const day = g.start_time.slice(0, 10);
      const set = byDay.get(day) ?? byDay.set(day, new Set()).get(day)!;
      if (!set.has(g.id)) {
        set.add(g.id);
        added++;
      }
    }
    if (pastRange || page.games.length < PAGE_LIMIT) break;
    await sleep(delayMs);
  }
  console.log(`discovered ${added} games across ${byDay.size} days`);
  return new Map([...byDay].map(([day, set]) => [day, [...set]]));
}

async function fetchDetails(ids: string[]): Promise<ReplayDetail[]> {
  const details: ReplayDetail[] = new Array(ids.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= ids.length) return;
      details[i] = await fetchJson<ReplayDetail>(`${RTS_API}/replays/${ids[i]}`);
      if (++done % 100 === 0) console.log(`  ${done}/${ids.length} details`);
      await sleep(delayMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  return details;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function scrapeDay(day: string, ids: string[], outFile: string): Promise<void> {
  const started = Date.now();
  const details = await fetchDetails(ids);
  details.sort((a, b) => a.startTime.localeCompare(b.startTime));
  const json = JSON.stringify(details);
  const tmp = `${outFile}.tmp`;
  await writeFile(tmp, json);
  await rename(tmp, outFile);
  console.log(
    `${day}: wrote ${details.length} games, ${(json.length / 1e6).toFixed(1)}MB ` +
      `in ${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
}

await mkdir(args.out, { recursive: true });
console.log(`scraping lava games from ${args.from} to ${args.to} into ${args.out}/`);

// figure out which days actually need fetching before spending any requests
const neededDays = new Set<string>();
for (let day = args.from; day <= args.to; day = nextDay(day)) {
  if (!args.force && (await exists(join(args.out, `${day}.json`)))) {
    console.log(`${day}: exists, skipping`);
    continue;
  }
  if (day >= todayUtc && !args.force) {
    console.warn(`${day}: not a completed UTC day yet, skipping (use --force to fetch anyway)`);
    continue;
  }
  neededDays.add(day);
}
if (neededDays.size === 0) {
  console.log("nothing to do");
  process.exit(0);
}

const idsByDay = await discoverIds();
for (const day of [...neededDays].sort()) {
  // a day can legitimately have zero lava games; write an empty file so the
  // day reads as completed and re-runs skip it
  await scrapeDay(day, idsByDay.get(day) ?? [], join(args.out, `${day}.json`));
}
console.log("done");
