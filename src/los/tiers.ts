// Rank tiers: what a visitor who is not an admin sees in place of LOS.
//
// Fixed cutoffs on the SHOWN (rookie-handicapped) LOS, fitted to the live
// population on 2026-11-01 (703 active players with 10+ games): the bottom
// half is one tier on purpose — most of it is players who play a few games and
// never come back, so splitting it says nothing. No special badge for the top
// players: they are Diamond like everyone else, and only the ranking page shows
// their order. Re-fit the cutoffs whenever ALGO_VERSION changes.
//
// A player's CURRENT tier is stored (players.tier) and moves with hysteresis:
// promotion happens at the cutoff, demotion only once the shown LOS has fallen
// DEMOTE_MARGIN below it, so a player sitting on a boundary does not flip back
// and forth game to game. A tier for a past moment (a game roster's "before")
// has no history to lean on and is the plain cutoff tier.

export const TIER_KEYS = ["placing", "bronze", "silver", "gold", "platinum", "diamond"] as const;
export type Tier = (typeof TIER_KEYS)[number];

/** Rated games before a player leaves "placing". */
export const PLACING_GAMES = 5;

/** Shown-LOS lower bound of each tier from bronze up (bronze has none). */
export const TIER_CUTOFFS: Readonly<Record<Exclude<Tier, "placing" | "bronze">, number>> = {
  silver: 12,
  gold: 16,
  platinum: 21,
  diamond: 28,
};

/** How far below a tier's cutoff the shown LOS must fall before a demotion. */
export const DEMOTE_MARGIN = 1.5;

/** Tier index (0 = placing … 5 = diamond) of a shown LOS, no hysteresis. */
export function tierIndexOf(shownLos: number, games: number): number {
  if (!(games >= PLACING_GAMES)) return 0;
  if (shownLos >= TIER_CUTOFFS.diamond) return 5;
  if (shownLos >= TIER_CUTOFFS.platinum) return 4;
  if (shownLos >= TIER_CUTOFFS.gold) return 3;
  if (shownLos >= TIER_CUTOFFS.silver) return 2;
  return 1;
}

/**
 * The tier index after a rating change, given the stored one: up as soon as the
 * cutoff is reached, down only to the tier `shownLos + DEMOTE_MARGIN` reaches.
 * `prev` null (a new player) means no history.
 */
export function nextTierIndex(prev: number | null, shownLos: number, games: number): number {
  const plain = tierIndexOf(shownLos, games);
  if (prev == null || plain === 0) return plain;
  return Math.max(plain, Math.min(prev, tierIndexOf(shownLos + DEMOTE_MARGIN, games)));
}

export function tierOfIndex(i: number | null | undefined): Tier | null {
  return i == null ? null : (TIER_KEYS[i] ?? null);
}

/** Plain tier of a shown LOS (null when there is no rating). */
export function tierOf(shownLos: number | null, games: number): Tier | null {
  return shownLos == null ? null : TIER_KEYS[tierIndexOf(shownLos, games)];
}

/**
 * Every LOS figure the API can carry. A response to a visitor who is not an
 * admin has these nulled wherever they appear (stripLos); the tier fields
 * stay. Counts (games, wins), names, ranks and the win chance are not ratings
 * and are kept.
 */
export const LOS_KEYS: ReadonlySet<string> = new Set([
  "los",
  "mu",
  "sigma",
  "leaderboardRating",
  "losBefore",
  "losAfter",
  "losDelta",
  "muBefore",
  "sigmaBefore",
  "muAfter",
  "sigmaAfter",
  "losChange7d",
  "losRaw",
  "losHandicap",
  "avgLosBefore",
  "avg",
]);

/** A deep copy of `body` with every LOS_KEYS field set to null — the public
 * view. Nulled rather than dropped so the shape stays the admin one: a reader
 * already treats a null rating as withheld (a private profile's row). */
export function stripLos<T>(body: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = LOS_KEYS.has(k) ? null : walk(x);
      return out;
    }
    return v;
  };
  return walk(body) as T;
}
