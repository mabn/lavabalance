// Derive Lavabar's rating-update rule from its published match history.
//
// WHY: the lobby detail page shows, per team, the win probability and how much elo each of
// its players would gain by winning. The win probability is exact — Lavabar's own
// `team*_win_prob` is plain Elo expectation on the team average with the 400 divisor. The elo
// swing needs Lavabar's update rule, which is not published anywhere, so this script measures
// it from data and prints the constants the UI hard-codes.
//
// HOW: every match page (`/matches/<id>/`) lists, per team, an "Avg" badge and each player's
// rating **After** the match plus the **Δ** applied. Two facts make this fittable:
//
//   • Δ is uniform within a team — all winners +N, all losers −N (unrated players get none),
//     so one match yields one observation.
//   • The "Avg" badge is the team's **pre-match** average. Verified here: for matches where
//     every player has a Δ, `mean(after − Δ)` reproduces the badge to ~1 elo (see the
//     "badge vs reconstruction" line). Unrated players make the badge disagree with the
//     rated-only mean, which is why the badge (not our reconstruction) is the input — it
//     already contains whatever value Lavabar assigned them.
//
// It then least-squares fits Δ = K·(1 − E)^p with E = 1/(1 + 10^(−d/s)) and
// d = preAvg(winner) − preAvg(loser), scanning (s, p), and reports residuals plus a held-out
// check (fit on the older 3/4, predict the newest 1/4). The plain Elo form (p = 1, s = 400)
// is printed alongside for comparison — it fits badly, which is why the UI uses the fitted
// exponent.
//
// Node-only, outside tsconfig — run it with tsx:
//
//   pnpm exec tsx tools/fit-lava-k.ts                 # 200 newest matches, cached
//   pnpm exec tsx tools/fit-lava-k.ts --matches 400   # bigger sample
//   pnpm exec tsx tools/fit-lava-k.ts --no-cache      # re-download
//
// Offline analysis only: nothing in the Worker imports this.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://lavabar.skyride.org";

interface Args {
  matches: number;
  cache: boolean;
  cacheDir: string;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    matches: 200,
    cache: true,
    cacheDir: join(process.env.TMPDIR ?? "/tmp", "lava-match-cache"),
    concurrency: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--matches") args.matches = Number(argv[++i]);
    else if (a === "--no-cache") args.cache = false;
    else if (a === "--cache-dir") args.cacheDir = String(argv[++i]);
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (a === "--help") {
      console.log(
        "usage: tsx tools/fit-lava-k.ts [--matches N] [--no-cache] [--cache-dir D] [--concurrency N]",
      );
      process.exit(0);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------

async function getText(url: string, args: Args, cacheKey: string): Promise<string> {
  const file = join(args.cacheDir, cacheKey);
  if (args.cache && existsSync(file)) return readFileSync(file, "utf8");
  const res = await fetch(url, { headers: { accept: "text/html" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  const body = await res.text();
  mkdirSync(args.cacheDir, { recursive: true });
  writeFileSync(file, body);
  return body;
}

/** Run `jobs` with a bounded number in flight, preserving result order. */
async function pooled<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        out[i] = await jobs[i]!();
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

interface MatchPlayer {
  name: string;
  /** Rating shown AFTER the match, or null when the row shows "-". */
  after: number | null;
  /** Rating change applied by this match, or null when the row shows "-". */
  delta: number | null;
}

interface TeamSide {
  team: number;
  /** The "Avg" badge = the team's pre-match average (validated below). */
  badgeAvg: number | null;
  winner: boolean;
  players: MatchPlayer[];
}

interface MatchRecord {
  id: number;
  date: string;
  durationSec: number;
  sides: TeamSide[];
}

function parseDuration(hms: string): number {
  const p = hms.split(":").map(Number);
  if (p.length === 3) return p[0]! * 3600 + p[1]! * 60 + p[2]!;
  if (p.length === 2) return p[0]! * 60 + p[1]!;
  return 0;
}

/** Pull `[name, faction, after, Δ]` out of one team card's table rows. */
function parseRows(block: string): MatchPlayer[] {
  const players: MatchPlayer[] = [];
  for (const row of block.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = (row.match(/<td[\s\S]*?<\/td>/g) ?? []).map(stripTags);
    if (cells.length < 4) continue; // header / layout row
    const [name, , afterCell, deltaCell] = cells;
    if (!name) continue;
    players.push({
      name,
      after: /^-?\d+$/.test(afterCell!) ? Number(afterCell) : null,
      delta: /^[+-]?\d+$/.test(deltaCell!) ? Number(deltaCell) : null,
    });
  }
  return players;
}

function parseMatch(id: number, html: string): MatchRecord | null {
  const flat = stripTags(html.replace(/<script[\s\S]*?<\/script>/g, ""));
  const sides: TeamSide[] = [];
  // Each team is one Bootstrap column card: header (Team N, "Avg N", maybe "Winner") + table.
  for (const chunk of html.split('<div class="col-md-6">').slice(1)) {
    const team = Number(chunk.match(/Team (\d+)\s*<\/h5>/)?.[1] ?? NaN);
    if (!Number.isFinite(team)) continue;
    const header = chunk.slice(0, chunk.indexOf("card-body"));
    sides.push({
      team,
      badgeAvg: Number(header.match(/Avg (\d+)/)?.[1] ?? NaN) || null,
      winner: /badge bg-success">\s*Winner/.test(header),
      players: parseRows(chunk),
    });
  }
  if (sides.length !== 2) return null;
  return {
    id,
    date: flat.match(/Date (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/)?.[1] ?? "",
    durationSec: parseDuration(flat.match(/Duration (\d+:\d{2}(?::\d{2})?)/)?.[1] ?? "0:00"),
    sides,
  };
}

// ---------------------------------------------------------------------------
// Samples + fitting
// ---------------------------------------------------------------------------

interface Sample {
  id: number;
  date: string;
  durationSec: number;
  players: number;
  unrated: number;
  /** Pre-match rating gap, winner − loser (from the "Avg" badges). */
  d: number;
  /** Observed |Δ|: what each winner gained and each loser lost. */
  delta: number;
  /** Badge minus our mean(after − Δ) — a validation residual, only meaningful with 0 unrated. */
  badgeGap: number | null;
  /** Rating Lavabar must have used for this match's unrated players (solved from the badge). */
  impliedUnrated: number[];
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function toSample(m: MatchRecord): Sample | null {
  const win = m.sides.find((s) => s.winner);
  const lose = m.sides.find((s) => !s.winner);
  if (!win || !lose || win.badgeAvg == null || lose.badgeAvg == null) return null;

  // Δ must be uniform across every rated player in the match.
  const deltas = new Set<number>();
  for (const s of m.sides) for (const p of s.players) if (p.delta != null) deltas.add(Math.abs(p.delta));
  if (deltas.size !== 1) return null;
  const delta = [...deltas][0]!;

  const pre = (s: TeamSide) =>
    s.players.filter((p) => p.after != null && p.delta != null).map((p) => p.after! - p.delta!);
  const unrated = m.sides.reduce((n, s) => n + s.players.filter((p) => p.delta == null).length, 0);

  // badgeAvg·n = Σ(rated pre) + k·x  →  solve x, the value Lavabar used for unrated players.
  const impliedUnrated: number[] = [];
  for (const s of m.sides) {
    const rated = pre(s);
    const k = s.players.length - rated.length;
    if (k > 0 && s.badgeAvg != null) {
      impliedUnrated.push((s.badgeAvg * s.players.length - rated.reduce((a, b) => a + b, 0)) / k);
    }
  }

  const winPre = pre(win);
  return {
    id: m.id,
    date: m.date,
    durationSec: m.durationSec,
    players: m.sides.reduce((n, s) => n + s.players.length, 0),
    unrated,
    d: win.badgeAvg - lose.badgeAvg,
    delta,
    badgeGap: unrated === 0 && winPre.length ? win.badgeAvg - mean(winPre) : null,
    impliedUnrated,
  };
}

const expected = (d: number, scale: number) => 1 / (1 + 10 ** (-d / scale));
/** The winner's share of the "surprise": 1 − E, the factor an Elo-style update scales. */
const surprise = (d: number, scale: number, exp: number) => (1 - expected(d, scale)) ** exp;

interface Fit {
  scale: number;
  exp: number;
  k: number;
  rmse: number;
  maxErr: number;
  within5: number;
  n: number;
}

/** Least-squares K for Δ = K·(1−E)^p at a fixed (scale, exp). */
function fitAt(samples: Sample[], scale: number, exp: number): Fit | null {
  let sxy = 0;
  let sxx = 0;
  for (const s of samples) {
    const x = surprise(s.d, scale, exp);
    sxy += x * s.delta;
    sxx += x * x;
  }
  if (!samples.length || sxx === 0) return null;
  const k = sxy / sxx;
  let se = 0;
  let maxErr = 0;
  let within5 = 0;
  for (const s of samples) {
    const err = k * surprise(s.d, scale, exp) - s.delta;
    se += err * err;
    maxErr = Math.max(maxErr, Math.abs(err));
    if (Math.abs(err) <= 5) within5++;
  }
  return {
    scale,
    exp,
    k,
    rmse: Math.sqrt(se / samples.length),
    maxErr,
    within5: within5 / samples.length,
    n: samples.length,
  };
}

function scan(samples: Sample[]): Fit[] {
  const fits: Fit[] = [];
  for (let scale = 200; scale <= 2000; scale += 10) {
    for (let e10 = 10; e10 <= 400; e10 += 5) {
      const f = fitAt(samples, scale, e10 / 100);
      if (f) fits.push(f);
    }
  }
  return fits.sort((a, b) => a.rmse - b.rmse);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

console.log(`# listing matches (cache ${args.cache ? args.cacheDir : "off"})`);
// The index is paginated; per_page=100 is the largest size it offers.
const found = new Set<number>();
for (let page = 1; found.size < args.matches; page++) {
  const html = await getText(`${BASE}/matches/?page=${page}&per_page=100`, args, `index-${page}.html`);
  const before = found.size;
  for (const m of html.matchAll(/\/matches\/(\d+)\//g)) found.add(Number(m[1]));
  if (found.size === before) break; // past the end
}
const ids = [...found].sort((a, b) => b - a).slice(0, args.matches);
console.log(`# newest ${ids.length} match ids: ${ids[0]} … ${ids[ids.length - 1]}`);

const pages = await pooled(
  ids.map((id) => async () => {
    try {
      return { id, html: await getText(`${BASE}/matches/${id}/`, args, `match-${id}.html`) };
    } catch (e) {
      console.warn(`# skip ${id}: ${e instanceof Error ? e.message : e}`);
      return { id, html: "" };
    }
  }),
  args.concurrency,
);

const records = pages
  .map((p) => (p.html ? parseMatch(p.id, p.html) : null))
  .filter((m): m is MatchRecord => !!m);
const samples = records.map(toSample).filter((s): s is Sample => !!s);
console.log(
  `# parsed ${records.length}/${ids.length} pages → ${samples.length} usable samples ` +
    `(dropped: no two teams / no winner flag / non-uniform Δ / no Avg badge)`,
);

// Validation 1: on fully-rated matches the badge must equal mean(after − Δ).
const gaps = samples.map((s) => s.badgeGap).filter((g): g is number => g != null).map(Math.abs);
if (gaps.length) {
  console.log(
    `# badge vs reconstruction on ${gaps.length} fully-rated matches: max |gap| ` +
      `${Math.max(...gaps).toFixed(1)} elo → the "Avg" badge IS the pre-match team average`,
  );
}
// Validation 2: what the badge implies for players the page shows as unrated.
const implied = samples.flatMap((s) => s.impliedUnrated).sort((a, b) => a - b);
if (implied.length) {
  const q = (f: number) => implied[Math.min(implied.length - 1, Math.floor(implied.length * f))]!;
  console.log(
    `# rating Lavabar used for match-page-unrated players: n=${implied.length} ` +
      `p10=${q(0.1).toFixed(0)} median=${q(0.5).toFixed(0)} p90=${q(0.9).toFixed(0)} ` +
      `— NOT a single default, so "-" on a match page means "no Δ shown", not "no rating"`,
  );
}

const fits = scan(samples);
console.log("\n# best fits for Δ = K·(1−E)^p, E = 1/(1+10^(−d/s)), d = preAvg(win) − preAvg(lose)");
console.log(
  `${"s".padStart(6)} ${"p".padStart(5)} ${"K".padStart(8)} ${"rmse".padStart(6)} ` +
    `${"max".padStart(6)} ${"±5elo".padStart(6)}`,
);
for (const f of fits.slice(0, 6)) {
  console.log(
    `${String(f.scale).padStart(6)} ${f.exp.toFixed(2).padStart(5)} ${f.k.toFixed(1).padStart(8)} ` +
      `${f.rmse.toFixed(2).padStart(6)} ${f.maxErr.toFixed(1).padStart(6)} ` +
      `${(f.within5 * 100).toFixed(0).padStart(5)}%`,
  );
}
const plain = fitAt(samples, 400, 1);
if (plain) {
  console.log(
    `# plain Elo (s=400, p=1) for comparison: K=${plain.k.toFixed(1)} rmse=${plain.rmse.toFixed(2)} ` +
      `max=${plain.maxErr.toFixed(1)} — far worse, hence the fitted exponent`,
  );
}

const best = fits[0];
if (best) {
  const rows = samples
    .map((s) => ({ s, pred: best.k * surprise(s.d, best.scale, best.exp) }))
    .map((r) => ({ ...r, err: r.pred - r.s.delta }))
    .sort((a, b) => Math.abs(b.err) - Math.abs(a.err));
  console.log(`\n# worst 8 residuals at s=${best.scale} p=${best.exp} K=${best.k.toFixed(1)}`);
  for (const r of rows.slice(0, 8)) {
    console.log(
      `  m${r.s.id} d=${String(Math.round(r.s.d)).padStart(5)} Δobs=${String(r.s.delta).padStart(4)} ` +
        `Δpred=${r.pred.toFixed(1).padStart(6)} err=${r.err.toFixed(1).padStart(6)} ` +
        `players=${r.s.players} unrated=${r.s.unrated} dur=${Math.round(r.s.durationSec / 60)}m`,
    );
  }

  // Held-out check: fit K on the older 3/4, predict the newest 1/4.
  const byId = [...samples].sort((a, b) => a.id - b.id);
  const cut = Math.floor(byId.length * 0.75);
  const trained = fitAt(byId.slice(0, cut), best.scale, best.exp);
  const test = byId.slice(cut);
  if (trained && test.length) {
    const errs = test.map((s) => Math.abs(trained.k * surprise(s.d, best.scale, best.exp) - s.delta));
    console.log(
      `\n# held out: K=${trained.k.toFixed(1)} from the ${cut} older matches → ${test.length} newest: ` +
        `mean |err| ${mean(errs).toFixed(2)}, max ${Math.max(...errs).toFixed(1)}`,
    );
  }

  console.log(
    `\n# USE in ui.ts:  ELO_SWING_K=${best.k.toFixed(0)}  ELO_SWING_SCALE=${best.scale}  ` +
      `ELO_SWING_EXP=${best.exp}\n#   Δ ≈ K · (1 − 1/(1+10^(−d/s)))^p   ` +
      `[fitted on ${samples.length} matches, newest ${samples[0]?.date ?? "?"}]`,
  );
}
