// LOS rating resolution for the lobby detail view: one bulk RPC to the
// singleton LosDO (the LOS store, src/los/ — same Worker since the lavaos
// merge). Replaces the old Lavabar (skyride) resolution for the two-team UI —
// src/rating/ still exists for the bot's chat commands.
//
// Degrades instead of failing: any problem is logged and answered with an
// empty map, so the roster still renders — just unrated — rather than turning
// the whole lobby view into a 502.

import { losStub } from "./los";
import type { Tier } from "./los/tiers";

/** One player's LOS rating, as the detail view needs it. */
export interface LosRating {
  /** Stable BAR account id. */
  userId: number;
  /** Shown LOS = max(mu − rookieHandicap(games) − sigma, 0). */
  los: number;
  mu: number;
  sigma: number;
  /** Rated lava games played. */
  games: number;
  wins: number;
  /** Current rank tier (stored, with hysteresis). */
  tier?: Tier | null;
  /** True when an admin has hidden this profile. The rating above is still the
   * REAL one — the bot balances on it — so a display surface has to blank it
   * itself (finalizeLobby does, for the lobby view). */
  privateProfile: boolean;
}

export type LosRatings = Record<string, LosRating>; // keyed by lowercased name

/**
 * Resolve LOS ratings for the given lobby names (one bulk DO RPC, keyed by
 * lowercased name; names LOS has never rated are simply absent). Returns {}
 * for an empty name list or on failure (logged).
 */
export async function fetchLosRatings(env: Env, names: string[]): Promise<LosRatings> {
  const wanted = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))];
  if (wanted.length === 0) return {};
  try {
    const { players } = await losStub(env).playersByNames(wanted);
    const out: LosRatings = {};
    for (const [key, p] of Object.entries(players)) {
      out[key] = {
        userId: p.userId,
        los: p.los,
        mu: p.mu,
        sigma: p.sigma,
        games: p.games,
        wins: p.wins,
        tier: p.tier,
        privateProfile: p.privateProfile === true,
      };
    }
    return out;
  } catch (err) {
    console.warn(
      `LosDO playersByNames failed (serving roster unrated): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {};
  }
}
