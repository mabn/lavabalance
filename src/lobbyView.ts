// What the API says about a lobby's ratings — the LOS model.
//
// The detail view (/api/lobbies/:id) rates players by LOS — the OpenSkill rating
// over the LAVA lobby's own games, served by the separate lavaos Worker
// (src/losRatings.ts resolves a roster in one bulk lookup). This module applies
// those ratings to a source-built lobby once, in the route:
//   • each player gets `los` / `losGames` / `losUserId` (null when LOS has never
//     rated their current name) — and a PRIVATE profile has its `los` withheld
//     with `losPrivate: true`, while `teamStats` below still counts their real
//     rating, since that is the match's number and not theirs;
//   • per-ally `teamStats` carry the mean LOS (unrated players counted as
//     `UNRATED_LOS`, a debutant's effective rating) and — for a straight
//     two-team lobby — each side's OpenSkill win probability (`predictWin`
//     over per-player mu/sigma, rookie handicap included, exactly the
//     predictor the LOS fold itself is calibrated with).
//
// `shapeScores` (POST /api/scores, the Lavabar bulk-score relay) is unrelated to
// the LOS view and unchanged: the bot's chat commands still use Lavabar elos.

import { losEffectiveRating, predictWin, rookieHandicap } from "./lavaos/lava";
import { MU, SIGMA, type Rating } from "./lavaos/openskill";
import { losOf, shownLosOf } from "./los/losGames";
import type { LosRating, LosRatings } from "./losRatings";
import { tierOf, type Tier } from "./los/tiers";

/** A debutant's rating as the fold sees it (mu discounted by the game-0 rookie handicap). */
const UNRATED_RATING: Rating = losEffectiveRating({ mu: MU, sigma: SIGMA }, 0);

/**
 * LOS assumed for a player with no rated lava game — the LOS of `UNRATED_RATING`
 * (≈3.7). Must match `UNRATED_LOS` in ui.ts, which explains it in the (?) hint.
 */
export const UNRATED_LOS = losOf(UNRATED_RATING.mu, UNRATED_RATING.sigma);

/** The subset of a lobby player this module cares about, as every source builds it. */
export interface LosPlayer {
  name: string;
  spectator: boolean;
  ally: number;
}

/** A lobby, as far as this module cares. */
export interface LosLobby {
  players: LosPlayer[];
}

/** Per-ally aggregate over the roster's LOS ratings. */
export interface TeamStat {
  ally: number;
  /** Number of non-spectator players on this team. */
  players: number;
  /** Mean LOS, unrated players counted as `UNRATED_LOS`. Null for an empty team. */
  avg: number | null;
  /** How many of them had no LOS rating and were counted as `UNRATED_LOS`. */
  assumed: number;
  /**
   * This team's chance to win, from OpenSkill `predictWin` over every player's
   * mu/sigma (rookie-handicapped; unrated = a debutant). Two-team lobbies only —
   * null otherwise.
   */
  winProb: number | null;
}

function ratingFor(ratings: LosRatings, name: string): LosRating | null {
  return ratings[name.trim().toLowerCase()] ?? null;
}

/** The mu/sigma a player feeds into predictWin: their handicapped state, or a debutant's. */
function effectiveRating(r: LosRating | null): Rating {
  return r ? losEffectiveRating(r, r.games) : UNRATED_RATING;
}

/** The LOS a rated player is SHOWN with: rookie handicap applied. */
function shownLos(r: LosRating): number {
  return shownLosOf(r.mu, r.sigma, r.games);
}

/**
 * Aggregate each ally team: mean LOS + (two-team lobbies) the OpenSkill win
 * probability. Spectators are excluded (they're not in the roster tables and
 * don't play).
 */
export function teamStats(players: LosPlayer[], ratings: LosRatings): TeamStat[] {
  const byAlly = new Map<number, LosPlayer[]>();
  for (const p of players) {
    if (p.spectator) continue;
    const list = byAlly.get(p.ally);
    if (list) list.push(p);
    else byAlly.set(p.ally, [p]);
  }
  const allies = [...byAlly.keys()].sort((a, b) => a - b);
  const stats = allies.map((ally) => {
    const team = byAlly.get(ally)!;
    let sum = 0;
    let assumed = 0;
    for (const p of team) {
      const r = ratingFor(ratings, p.name);
      sum += r ? shownLos(r) : UNRATED_LOS;
      if (!r) assumed++;
    }
    return {
      ally,
      players: team.length,
      avg: team.length ? sum / team.length : null,
      assumed,
      winProb: null as number | null,
    };
  });

  // Head-to-head odds only make sense for exactly two non-empty teams.
  if (stats.length === 2 && stats.every((s) => s.players > 0)) {
    const probs = predictWin(
      allies.map((ally) =>
        byAlly.get(ally)!.map((p) => effectiveRating(ratingFor(ratings, p.name))),
      ),
    );
    stats.forEach((s, i) => (s.winProb = probs[i]));
  }
  return stats;
}

/**
 * Finish a single-lobby response: attach the per-ally `teamStats` and each
 * player's LOS fields (`los` is the SHOWN, rookie-handicapped LOS, rounded for
 * the wire; null when LOS has never rated the name). `losRaw` is max(μ−σ, 0)
 * without the handicap and `losHandicap` the rookie mu discount the balancer and
 * predictWin apply (0 once established) — the UI's (?) hint explains the gap.
 */
export function finalizeLobby<L extends LosLobby>(
  lobby: L,
  ratings: LosRatings,
  opts: { includePrivate?: boolean } = {},
): Omit<L, "players"> & {
  teamStats: TeamStat[];
  players: (L["players"][number] & {
    los: number | null;
    losRaw: number | null;
    losGames: number | null;
    losUserId: number | null;
    losHandicap: number | null;
    losPrivate: boolean;
    tier: Tier | null;
    losOrder: number;
  })[];
} {
  const players = lobby.players.map((p) => {
    const r = ratingFor(ratings, p.name);
    // A private profile keeps its identity and its game count — what the public
    // games list already tells anyone — and loses the RATING, exactly as the
    // game page's roster does. `losUserId` stays so the name still links.
    const hide = r != null && r.privateProfile && opts.includePrivate !== true;
    return {
      ...p,
      los: r && !hide ? Math.round(shownLos(r) * 100) / 100 : null,
      losRaw: r && !hide ? Math.round(losOf(r.mu, r.sigma) * 100) / 100 : null,
      losGames: r ? r.games : null,
      losUserId: r ? r.userId : null,
      losHandicap: r && !hide ? rookieHandicap(r.games) : null,
      // Tells the page a null `los` means "withheld", not "never rated" — the
      // two look nothing alike to a reader and must not render the same.
      losPrivate: hide,
      // What a visitor who is not an admin sees in place of `los`.
      tier: r && !hide ? (r.tier ?? tierOf(shownLos(r), r.games)) : null,
    };
  });
  // Each player's place in the lobby by the DISPLAYED LOS (strongest = 0; the
  // never-rated count as UNRATED_LOS, a withheld rating goes last, ties by
  // name) — the same order an admin's page sorts its rosters in. It survives the
  // visitor's LOS stripping, so a visitor's rosters keep the LOS order without
  // the numbers.
  const shown = (p: (typeof players)[number]) =>
    p.losPrivate ? -Infinity : p.los == null ? UNRATED_LOS : p.los;
  const order = players
    .map((_, i) => i)
    .sort((a, b) => shown(players[b]) - shown(players[a]) || players[a].name.localeCompare(players[b].name));
  const losOrder = new Array<number>(players.length);
  order.forEach((idx, pos) => (losOrder[idx] = pos));
  const ordered = players.map((p, i) => ({ ...p, losOrder: losOrder[i] }));
  // teamStats is computed from the FULL ratings, before any of that: the team
  // average and the win chance are properties of the MATCH, the same for whoever
  // is looking. Averaging what a visitor can see would quietly count a hidden
  // player as a debutant and both move the number and leak their rating by the
  // difference — the same trap as the game page's avgLosBefore.
  return { ...lobby, teamStats: teamStats(lobby.players, ratings), players: ordered };
}

/**
 * Shape the bulk-score answer (`POST /api/scores`) from the stored two-column
 * Lavabar records: a publicly-rated player gets their full public record; a
 * hidden-only player is `{"hidden": true}` — elo attached only when `showHidden`.
 */
export function shapeScores(
  stored: Record<
    string,
    {
      playerId: number;
      rating: number | null;
      ratingHidden: number | null;
      wins: number;
      losses: number;
      games: number;
      winRate: number;
    }
  >,
  showHidden = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, r] of Object.entries(stored)) {
    if (r.rating != null) {
      out[key] = {
        playerId: r.playerId,
        rating: r.rating,
        wins: r.wins,
        losses: r.losses,
        games: r.games,
        winRate: r.winRate,
      };
    } else if (r.ratingHidden != null) {
      out[key] = showHidden ? { hidden: true, rating: r.ratingHidden } : { hidden: true };
    }
  }
  return out;
}
