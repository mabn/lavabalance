// Compute "lava OS" (LOS) — BAR's OpenSkill rating, applied only to lava
// games — from the per-day JSON files written by tools/scrape.ts. Offline:
// reads only local files, never the API.
//
//   pnpm run los -- [--data data] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//                  [--out data/los.json] [--min-games 1]
//
// Games are processed in startTime order; each rateable lava game updates its
// 16 players exactly the way Teiserver's MatchRatingLib does (see
// src/openskill.ts). LOS = max(mu - sigma, 0), same as BAR's displayed OS.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultRating, rate, ratingValue, leaderboardRating } from "../../src/lavaos/openskill";
import { isLavaGame, losEffectiveRating, rookieHandicap, unrateableReason } from "../../src/lavaos/lava";
import type { ReplayDetail } from "../../src/lavaos/types";

const { values: args } = parseArgs({
  options: {
    data: { type: "string", default: "data" },
    from: { type: "string" },
    to: { type: "string" },
    out: { type: "string", default: "data/los.json" },
    "min-games": { type: "string", default: "1" },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(
    `Usage: pnpm run los -- [options]

Options:
  --data DIR          directory with scraped YYYY-MM-DD.json files (default: data)
  --from YYYY-MM-DD   first day to include (default: earliest file)
  --to YYYY-MM-DD     last day to include (default: latest file)
  --out FILE          write the full leaderboard as JSON (default: data/los.json)
  --min-games N       only print players with at least N lava games (default: 1)`,
  );
  process.exit(0);
}
const minGames = Math.max(1, Number(args["min-games"]) || 1);

interface PlayerState {
  userId: number;
  name: string;
  mu: number;
  sigma: number;
  games: number;
  wins: number;
  lastPlayed: string;
  /** BAR's own OS as shown in the player's most recent lava replay (may be
   * stale — lava games are unranked and don't update it). Null when the
   * replay carried no skill value. */
  barOs: number | null;
}

const parseBarOs = (skill: string | null): number | null => {
  if (skill == null) return null;
  const v = Number(String(skill).replace(/[[\]]/g, ""));
  return Number.isFinite(v) ? v : null;
};

const dayFiles = (await readdir(args.data))
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .filter((f) => {
    const day = f.slice(0, 10);
    return (!args.from || day >= args.from) && (!args.to || day <= args.to);
  })
  .sort();

if (dayFiles.length === 0) {
  console.error(`no day files in ${args.data}/ for the requested range`);
  process.exit(1);
}

const games: ReplayDetail[] = [];
const seen = new Set<string>();
for (const f of dayFiles) {
  for (const r of JSON.parse(await readFile(join(args.data, f), "utf8")) as ReplayDetail[]) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      games.push(r);
    }
  }
}
games.sort((a, b) => a.startTime.localeCompare(b.startTime));

const players = new Map<number, PlayerState>();
const skipped = new Map<string, number>();
let rated = 0;

for (const game of games) {
  if (!isLavaGame(game)) continue;
  const reason = unrateableReason(game);
  if (reason) {
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
    continue;
  }

  const teams = game.AllyTeams.filter((t) => t.Players.length > 0);
  // winners first — team order is the placement order the model expects
  teams.sort((a, b) => Number(b.winningTeam) - Number(a.winningTeam));

  const states = teams.map((t) =>
    t.Players.map((p) => {
      let s = players.get(p.userId);
      if (!s) {
        s = { userId: p.userId, ...defaultRating(), name: p.name, games: 0, wins: 0, lastPlayed: "", barOs: null };
        players.set(p.userId, s);
      }
      return s;
    }),
  );

  // rate on rookie-discounted mus; the update delta lands on the real mu
  // (updated.mu is relative to the discounted input, so add the handicap back)
  const updated = rate(states.map((team) => team.map((s) => losEffectiveRating(s, s.games))));

  states.forEach((team, i) =>
    team.forEach((s, j) => {
      s.mu = updated[i][j].mu + rookieHandicap(s.games);
      s.sigma = updated[i][j].sigma;
      s.games++;
      if (i === 0) s.wins++;
      s.name = teams[i].Players[j].name;
      s.lastPlayed = game.startTime;
      s.barOs = parseBarOs(teams[i].Players[j].skill) ?? s.barOs;
    }),
  );
  rated++;
}

const leaderboard = [...players.values()]
  .map((s) => ({
    userId: s.userId,
    name: s.name,
    los: ratingValue(s),
    mu: s.mu,
    sigma: s.sigma,
    leaderboardRating: leaderboardRating(s),
    games: s.games,
    wins: s.wins,
    losses: s.games - s.wins,
    lastPlayed: s.lastPlayed,
    barOs: s.barOs,
  }))
  .sort((a, b) => b.los - a.los);

const range = `${dayFiles[0].slice(0, 10)}..${dayFiles[dayFiles.length - 1].slice(0, 10)}`;
console.log(
  `${range}: ${games.length} games scanned, ${rated} lava games rated, ${players.size} players`,
);
for (const [reason, n] of [...skipped].sort((a, b) => b[1] - a[1])) {
  console.log(`  skipped ${n} lava games: ${reason}`);
}

console.log(
  `\n rank  ${"name".padEnd(24)} ${"LOS".padStart(6)}  ${"mu".padStart(6)} ${"sigma".padStart(5)}  games  wins-losses  ${"last game".padEnd(10)}  ${"BAR OS".padStart(6)}`,
);
let shown = 0;
for (const [i, p] of leaderboard.entries()) {
  if (p.games < minGames) continue;
  shown++;
  console.log(
    ` ${String(i + 1).padStart(4)}  ${p.name.padEnd(24)} ${p.los.toFixed(2).padStart(6)}  ` +
      `${p.mu.toFixed(2).padStart(6)} ${p.sigma.toFixed(2).padStart(5)}  ${String(p.games).padStart(5)}  ${`${p.wins}-${p.losses}`.padEnd(11)}  ` +
      `${p.lastPlayed.slice(0, 10)}  ${(p.barOs == null ? "-" : p.barOs.toFixed(2)).padStart(6)}`,
  );
}
if (shown < leaderboard.length) {
  console.log(` (${leaderboard.length - shown} more with fewer than ${minGames} games)`);
}

await writeFile(
  args.out,
  JSON.stringify({ range, ratedGames: rated, generatedAt: new Date().toISOString(), players: leaderboard }, null, 1),
);
console.log(`\nwrote ${leaderboard.length} players to ${args.out}`);
