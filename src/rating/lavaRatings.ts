// Lavabar rating scraper (the autobalancer's skill source, replacing Teiserver's).
//
// There is no JSON API, so we scrape the public search page
// `https://lavabar.skyride.org/players/?q=<name>`, which renders a small HTML table of
// matching players, and pick the row whose name matches exactly.
//
// This module is pure transport + parsing: `fetchPlayerRating(name)` resolves ONE name to
// its rating (or null when there's no such player), with a per-request timeout and a single
// retry. Caching lives elsewhere — the `RatingsDO` Durable Object (src/rating/ratingsDO.ts)
// owns a persistent SQLite cache and the batch/refresh policy, so this file stays a thin,
// easily unit-tested fetcher with no in-memory state.

/** Lavabar stats for a single player. */
export interface PlayerRating {
  /** Lavabar's internal player id, from the result link (e.g. /players/5106/). */
  playerId: number;
  /** Lavabar's headline rating (the integer "Rating" badge, e.g. 4407). */
  rating: number;
  wins: number;
  losses: number;
  games: number;
  /** Win fraction in [0, 1] (e.g. 0.708 for the "70.8%" the site shows). */
  winRate: number;
}

/**
 * What the RatingsDO serves per player — the two-column model. `rating` is the PUBLIC rating
 * (what Lavabar's own site shows; the search-page scrape writes it) and is the only value the
 * UI may display. `ratingHidden` is the elo the BALANCE endpoint reports (the `rating_hidden`
 * column): it is used for team averages / win chance / elo swing, and shown only with
 * `?show_hidden_score=true`. A player the balance endpoint rates but the public site doesn't
 * is thereby hidden BY DATA — no operator list to maintain or lose.
 */
export interface StoredRating {
  /** Lavabar's public player id (from the scrape), 0 when unknown. */
  playerId: number;
  /** Public rating, or null when the public site doesn't rate this player. */
  rating: number | null;
  /** Balance-endpoint elo, or null when never fetched / unknown there. */
  ratingHidden: number | null;
  wins: number;
  losses: number;
  games: number;
  winRate: number;
}

/** Default per-request timeout. */
export const REQUEST_TIMEOUT_MS = 5000;

const BASE_URL = "https://lavabar.skyride.org/players/";

export interface FetchRatingOptions {
  /** Per-request timeout in millis (default 5000). */
  timeoutMs?: number;
  /** Injectable fetch, for tests. Defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
}

/**
 * Resolve a single player name to their Lavabar rating, or null if the name doesn't match
 * a known player. Each attempt has a `timeoutMs` deadline (AbortController) and is retried
 * once on failure (timeout, network, non-2xx). Throws only if BOTH attempts fail — the
 * caller decides how to treat that (the DO simply skips writing the entry).
 */
export async function fetchPlayerRating(
  name: string,
  opts: FetchRatingOptions = {},
): Promise<PlayerRating | null> {
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  // Bind to globalThis: Workers' global `fetch` throws "Illegal invocation" if it's
  // invoked as a method (with `this` set to anything but the global scope).
  const fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
  const url = `${BASE_URL}?q=${encodeURIComponent(name)}`;
  try {
    return parsePlayerSearch(await fetchOnce(fetchFn, url, timeoutMs), name);
  } catch (err) {
    // Single retry on any failure (timeout, network, non-2xx).
    console.warn(`LavaRatings: retrying ${name} after error:`, err);
    return parsePlayerSearch(await fetchOnce(fetchFn, url, timeoutMs), name);
  }
}

/** One fetch attempt with a `timeoutMs` deadline; returns the response body. */
async function fetchOnce(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  // Distinguish our deadline from any other abort so the error says "timed out" rather
  // than the opaque "The operation was aborted".
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // Trace the outgoing request/response to Lavabar (always on — the URL carries only a
  // public player name, no secrets) so rating lookups are observable, mirroring the
  // teiserver scraper's →/← logging.
  console.log(`→ lavabar GET ${url}`);
  const started = Date.now();
  try {
    const res = await fetchFn(url, {
      headers: { accept: "text/html" },
      signal: controller.signal,
    });
    console.log(
      `← lavabar GET ${url} ${res.status} ${res.statusText} (${Date.now() - started}ms)`,
    );
    if (!res.ok) {
      throw new Error(`lavabar GET ${url} responded ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } catch (err) {
    if (timedOut) throw new Error(`lavabar GET ${url} timed out after ${timeoutMs}ms`);
    if (err instanceof Error && err.message.startsWith("lavabar ")) throw err;
    throw new Error(
      `lavabar GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Normalize a name for cache keys / exact matching (case-insensitive, trimmed). */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Parse a Lavabar player-search page and return the stats for the row whose player
 * name matches `name` exactly (case-insensitive), or null if there's no such row.
 *
 * The search renders one `<tr class="search-row">` per match; each row carries the
 * name in an anchor, the rating in a badge, and W / L / Games / Win-Rate cells.
 * Exported for unit testing.
 */
export function parsePlayerSearch(html: string, name: string): PlayerRating | null {
  const target = normalizeName(name);
  const rows = html.match(/<tr class="search-row">[\s\S]*?<\/tr>/g);
  if (!rows) return null;

  for (const row of rows) {
    const rowName = matchGroup(row, /fw-bold">\s*([^<]+?)\s*<\/a>/);
    if (rowName && rowName.trim().toLowerCase() === target) {
      return parseRow(row);
    }
  }
  return null;
}

function parseRow(row: string): PlayerRating | null {
  const playerId = numberAt(row, /href="\/players\/(\d+)\//);
  const rating = numberAt(row, /badge[^>]*>\s*([\d,]+)\s*<\/span>/);
  const wins = numberAt(row, /text-success fw-bold">\s*(\d+)\s*<\/td>/);
  const losses = numberAt(row, /text-danger fw-bold">\s*(\d+)\s*<\/td>/);
  const games = numberAt(row, /<td class="text-center">\s*(\d+)\s*<\/td>/);
  const winPct = numberAt(row, /([\d.]+)%/);

  if (
    playerId === null ||
    rating === null ||
    wins === null ||
    losses === null ||
    games === null
  ) {
    return null;
  }

  // Prefer the site's printed win-rate; fall back to W/Games when it's absent.
  const winRate =
    winPct !== null ? winPct / 100 : games > 0 ? wins / games : 0;

  return { playerId, rating, wins, losses, games, winRate };
}

function matchGroup(s: string, re: RegExp): string | null {
  const m = s.match(re);
  return m ? m[1] : null;
}

function numberAt(s: string, re: RegExp): number | null {
  const raw = matchGroup(s, re);
  if (raw === null) return null;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
