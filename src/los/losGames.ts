// Pure logic for the LOS service (docs/lavaos-cloudflare-data-model.md):
// per-game upload classification and the rating fold. No I/O, no
// `cloudflare:workers` import, so it unit-tests in the Node pool and the
// same fold can be replayed offline against `tools/lavaos/los.ts` output.
//
// The fold MUST stay byte-identical to tools/lavaos/los.ts — that CLI over
// the same day files is the service's verification oracle. Any change to
// the update rule goes into src/lavaos/ and both consumers together.

import {
  eligibilityReason,
  isLavaGame,
  losEffectiveRating,
  predictWin,
  onRatedMap,
  rookieHandicap,
  startMetalReason,
  startMetalStorage,
} from "../lavaos/lava";
import { rate, MU, SIGMA } from "../lavaos/openskill";
import type { ReplayDetail } from "../lavaos/types";

/**
 * Version of the rating algorithm this build folds with. Stored in `meta`;
 * changing the rule (rookie-handicap re-fit, τ, eligibility) means bumping
 * this and re-uploading from a reset — the stored ratings are a projection
 * under one version.
 */
export const ALGO_VERSION = "4"; // 4: only 4000 start metal storage counts from 2026-10-01 (lava.ts); 3: rookie handicap refit with full refolds, 2026-09-27 (lava.ts); 2: rookie handicap curve, 2026-09-16

/** One participant of a stored game (input shape for the fold + storage). */
export interface GamePlayerInput {
  userId: number;
  /** Lobby name at game time (names change; userId doesn't). */
  name: string;
  faction: string | null;
  /** Lobby-shown BAR OS, parsed from the bracketed "[30.9]" string. */
  barSkill: number | null;
  /** BAR's chevron level at the time of THIS game (0..7) — the lobby
   * server's coarse experience badge, which under BAR's "Role" rank method
   * buckets in-game hours (0: <5h, 1: 5h, 2: 15h, 3: 100h, 4: 250h,
   * 5: 1000h), with 6 and 7 reserved for contributors and tournament
   * winners. Null when the replay states none. It is the only reading of a
   * player's BAR-wide experience anything here can get: it is stamped per
   * game, so a stored row keeps what the player was then — unlike the
   * `players` table's own numbers, which are always current. Note 0 is a
   * real level, so it must never stand in for "unknown". */
  barRank: number | null;
  /** 0|1 — position of the player's team (see extractGame). */
  team: number;
  won: boolean;
}

/** A rateable lava game reduced to what the fold and the tables need. */
export interface GameInput {
  id: string;
  startTime: string;
  durationMs: number;
  map: string;
  engineVersion: string | null;
  gameVersion: string | null;
  /** 0|1 — which team (by the convention below) won. */
  winnerTeam: number;
  /** The `startmetalstorage` modoption, null when the replay carries none.
   * Stored on the games row so a rebase can re-judge the start-metal rule. */
  startMetalStorage: number | null;
  players: GamePlayerInput[];
  /** The lobby info barreplay rode on the upload (extractLobby), stored
   * verbatim as JSON on the games row; null when the upload carried none. */
  lobby: Record<string, unknown> | null;
}

/** Per-game upload verdicts that never store anything. */
export type DroppedVerdict =
  | { kind: "rejected" } // not a lava game
  | { kind: "skipped"; reason: string }; // lava, but eligibility excludes it

export type Classified =
  | DroppedVerdict
  | {
      kind: "ok";
      game: GameInput;
      /** False when the game ran off the rated map (any lava game not on
       * Supreme Isthmus) or fails the start-metal rule: stored UNRANKED
       * (status "ignored") by the caller, never fed to the fold. Every other
       * eligibility rule still applied. */
      rateable: boolean;
      /** Why it is not rateable (off-map wins when both hold); null when it is. */
      unranked: "off-map" | "start metal storage" | null;
    };

/**
 * The lobby info an upload carries beyond the verbatim BAR detail —
 * barreplay's lava sync attaches `lobbyName` + `lobbyDetails` (the party
 * roster among them) as extra top-level fields when its teiserver poll
 * matched a lobby onto the game. Collected into one object stored verbatim
 * (JSON on the games row); null when the upload carries neither key, which
 * is every upload not from that sync.
 */
export function extractLobby(replay: ReplayDetail): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (replay.lobbyName != null) out.lobbyName = replay.lobbyName;
  if (replay.lobbyDetails != null) out.lobbyDetails = replay.lobbyDetails;
  return Object.keys(out).length ? out : null;
}

// BAR ships eight chevron levels (0..7). The bound is loose so a level added
// later is stored rather than dropped on the way in; anything that is not a
// level at all — the API's own null, or a shape it never promised — is null.
const BAR_RANK_MAX = 15;

const parseBarRank = (rank: number | null | undefined): number | null => {
  if (typeof rank !== "number" || !Number.isInteger(rank)) return null;
  return rank >= 0 && rank <= BAR_RANK_MAX ? rank : null;
};

const parseBarOs = (skill: string | null): number | null => {
  if (skill == null) return null;
  const v = Number(String(skill).replace(/[[\]]/g, ""));
  return Number.isFinite(v) ? v : null;
};

/**
 * Classify one uploaded replay: not lava → rejected; lava but failing the
 * map-independent eligibility rules → skipped (with the reason); otherwise
 * the extracted `GameInput`, marked `rateable` only when it ran on the rated
 * map — an off-map lava game is kept, unranked. The order-vs-fold-head
 * decision (rated vs ignored) is the caller's — it needs the database.
 *
 * Team convention: `team` ∈ {0, 1} is the position of the player's team in
 * the game's non-empty AllyTeams sorted by the ALLY-TEAM-LEVEL `allyTeamId`
 * (0/1 in the data). The player-level `allyTeamId` is an API-internal row
 * id — never used.
 */
export function classifyReplay(replay: ReplayDetail): Classified {
  if (!isLavaGame(replay)) return { kind: "rejected" };
  const reason = eligibilityReason(replay);
  if (reason) return { kind: "skipped", reason };

  // eligibilityReason passed: exactly 2 non-empty teams, 8 players each, no
  // AIs, exactly one winner.
  const teams = replay.AllyTeams.filter((t) => t.Players.length > 0).sort(
    (a, b) => a.allyTeamId - b.allyTeamId,
  );
  const players: GamePlayerInput[] = [];
  teams.forEach((t, ti) => {
    for (const p of t.Players) {
      players.push({
        userId: p.userId,
        name: p.name,
        faction: p.faction ?? null,
        barSkill: parseBarOs(p.skill),
        barRank: parseBarRank(p.rank),
        team: ti,
        won: t.winningTeam,
      });
    }
  });
  const storage = startMetalStorage(replay);
  const unranked = !onRatedMap(replay)
    ? "off-map"
    : startMetalReason(replay.startTime, storage)
      ? "start metal storage"
      : null;
  return {
    kind: "ok",
    rateable: unranked === null,
    unranked,
    game: {
      id: replay.id,
      startTime: replay.startTime,
      durationMs: replay.durationMs,
      map: replay.Map.scriptName,
      engineVersion: replay.engineVersion ?? null,
      gameVersion: replay.gameVersion ?? null,
      winnerTeam: teams.findIndex((t) => t.winningTeam),
      startMetalStorage: storage,
      players,
      lobby: extractLobby(replay),
    },
  };
}

/** The fold's running state for one player (a `players` table row). */
export interface PlayerState {
  userId: number;
  name: string;
  mu: number;
  sigma: number;
  games: number;
  wins: number;
  firstPlayed: string;
  lastPlayed: string;
  barOs: number | null;
}

/** One player's rating transition in one rated game (a `game_players` row). */
export interface Transition {
  userId: number;
  /** The player's nth rated lava game, 1-based. */
  gameNumber: number;
  muBefore: number;
  sigmaBefore: number;
  muAfter: number;
  sigmaAfter: number;
}

/**
 * Apply one rated game to the fold — the exact update tools/lavaos/los.ts
 * performs: teams winners-first into `rate()`, inputs discounted by the
 * rookie handicap (`losEffectiveRating` on the player's PRIOR game count),
 * the update delta landing on the real mu (handicap added back).
 *
 * `lookup` resolves a player's current state (undefined = never rated);
 * returns the transitions plus the updated states. Mutates nothing it was
 * given — updated states are fresh objects.
 */
export function applyRatedGame(
  game: GameInput,
  lookup: (userId: number) => PlayerState | undefined,
): { transitions: Transition[]; states: PlayerState[] } {
  // Winners first — team order is the placement order the model expects.
  // filter() preserves each team's within-team player order (teams are
  // contiguous runs in game.players), matching the CLI's stable sort.
  const teams = [game.players.filter((p) => p.won), game.players.filter((p) => !p.won)];

  const states = teams.map((team) =>
    team.map((p): PlayerState => {
      const s = lookup(p.userId);
      if (s) return { ...s };
      return {
        userId: p.userId,
        name: p.name,
        mu: MU,
        sigma: SIGMA,
        games: 0,
        wins: 0,
        firstPlayed: game.startTime,
        lastPlayed: game.startTime,
        barOs: null,
      };
    }),
  );

  const updated = rate(states.map((team) => team.map((s) => losEffectiveRating(s, s.games))));

  const transitions: Transition[] = [];
  states.forEach((team, i) =>
    team.forEach((s, j) => {
      const before = { mu: s.mu, sigma: s.sigma };
      s.mu = updated[i][j].mu + rookieHandicap(s.games);
      s.sigma = updated[i][j].sigma;
      s.games++;
      if (i === 0) s.wins++;
      s.name = teams[i][j].name;
      s.lastPlayed = game.startTime;
      s.barOs = teams[i][j].barSkill ?? s.barOs;
      transitions.push({
        userId: s.userId,
        gameNumber: s.games,
        muBefore: before.mu,
        sigmaBefore: before.sigma,
        muAfter: s.mu,
        sigmaAfter: s.sigma,
      });
    }),
  );
  return { transitions, states: states.flat() };
}

/** Displayed LOS — same as BAR's shown OS: max(mu − sigma, 0). */
export function losOf(mu: number, sigma: number): number {
  return Math.max(mu - sigma, 0);
}

/**
 * The LOS every page, API answer and bot message SHOWS: losOf over the
 * rookie-handicapped μ, i.e. max(μ − rookieHandicap(games) − σ, 0), where
 * `games` is the number of rated lava games behind this μ/σ (the state after a
 * player's game N has games = N). Equal to losOf once a player is past the
 * handicap window. The stored `players.los` column (what the leaderboard is
 * ordered by) stays the raw losOf.
 */
export function shownLosOf(mu: number, sigma: number, games: number): number {
  return losOf(mu - rookieHandicap(games), sigma);
}

/** Leaderboard rating — max(mu − 3sigma, 0). */
export function leaderboardOf(mu: number, sigma: number): number {
  return Math.max(mu - 3 * sigma, 0);
}

/**
 * Pre-game win probability per team (index-aligned with the input), from the
 * stored `_before` ratings + `game_number`: the same rookie-handicapped
 * inputs the fold rated with (`gameNumber − 1` prior games). Computed on
 * read, never stored — a change to predictWin re-scores every past game.
 */
export function predictTeams(
  teams: { muBefore: number; sigmaBefore: number; gameNumber: number }[][],
): number[] {
  return predictWin(
    teams.map((team) =>
      team.map((p) =>
        losEffectiveRating({ mu: p.muBefore, sigma: p.sigmaBefore }, p.gameNumber - 1),
      ),
    ),
  );
}
