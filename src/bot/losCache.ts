// The bot's in-memory LOS rating cache.
//
// Extracted from bot.ts so the one rule that matters can be tested: HOW OLD a
// rating may be before it is refreshed. bot.ts owns the transport (the bulk
// lookup, the debounced roster prefetch); this owns nothing but the entries and
// their ages.
//
// The rule exists because ratings move under the bot's feet. A lava lobby plays
// a game and re-forms with the same people, and every one of them now has a new
// LOS — but the store only learns the game from a scraped replay minutes after
// it ends, so there is no event the bot can invalidate on. A short maximum age
// on the paths that decide or report a matchup catches the update whenever it
// lands; serving any age the cache happened to hold does not (2026-09-07 23:59:
// a `.balance` 34s after the previous game was ingested balanced on the ratings
// from before it and announced 50/50 teams the website scored 38.3/61.7).

/** One player's cached rating: the lookup's answer, or null for "not rated". */
export interface LosCacheEntry<T> {
  info: T | null;
  fetchedAt: number;
}

/** Lowercased lookup key for a lobby name. */
export const losKey = (name: string): string => name.trim().toLowerCase();

/**
 * Ratings by lowercased name, with ages. `T` is the lookup's player shape
 * (`LosPlayerInfo` in the bot); the cache never reads into it.
 */
export class LosCache<T> {
  private readonly entries = new Map<string, LosCacheEntry<T>>();

  /** Prune to this many entries, oldest first, after a write. */
  constructor(private readonly max: number) {}

  get size(): number {
    return this.entries.size;
  }

  /** Whether `name` has ever been resolved (a "not rated" answer counts). */
  has(name: string): boolean {
    return this.entries.has(losKey(name));
  }

  /** The cached rating for `name`, or null/undefined when unknown or unrated. */
  get(name: string): T | null | undefined {
    return this.entries.get(losKey(name))?.info;
  }

  /**
   * Which of `names` must be looked up again: never resolved, or resolved more
   * than `maxAgeMs` ago. `now` is injectable for tests.
   */
  namesToRefresh(names: string[], maxAgeMs: number, now = Date.now()): string[] {
    return names.filter((n) => {
      const e = this.entries.get(losKey(n));
      return !e || now - e.fetchedAt > maxAgeMs;
    });
  }

  /**
   * Record one bulk lookup: every name asked for gets an entry, including the
   * ones the lookup did not answer for — "not rated" is an answer, and caching
   * it is what keeps an unrated player from being re-fetched forever.
   */
  remember(names: string[], found: (name: string) => T | undefined, now = Date.now()): void {
    for (const n of names) this.entries.set(losKey(n), { info: found(n) ?? null, fetchedAt: now });
    if (this.entries.size <= this.max) return;
    const oldest = [...this.entries.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    for (const [key] of oldest.slice(0, this.entries.size - this.max)) this.entries.delete(key);
  }
}
