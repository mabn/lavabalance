// RatingsDO — a singleton Durable Object that owns the Lavabar player-rating cache.
//
// Why a dedicated DO: resolving a lobby's ratings means one Lavabar HTTP fetch per
// uncached player. Doing that inside the request-serving Worker (or the TeiserverDO /
// Dispatcher) piled those fetches onto an invocation that already makes other subrequests,
// and a busy lobby blew past Cloudflare's per-invocation subrequest limit ("Too many
// subrequests by single Worker invocation"). Concentrating every rating fetch in this one
// DO isolates them on their own invocation budget, and — more importantly — the cache is
// **persistent** (SQLite in DO storage) so cold fetches are rare: callers almost always
// read straight from the table.
//
// THE TWO-COLUMN MODEL. Two upstream sources write DISJOINT columns of the same row:
//
//   • the public search-page scrape (rating/lavaRatings.ts) owns `rating` + the stats
//     columns — the player's PUBLIC rating, the only value the UI may display;
//   • the balance endpoint (rating/lavaScores.ts, via `putScores`) owns `rating_hidden` —
//     the elo Lavabar's balancer uses, which covers players the public site doesn't rate.
//
// A player with `rating_hidden` but no `rating` is hidden BY DATA: their elo feeds team
// averages / win chance / elo swing, but nothing is displayable (unless the caller passes
// ?show_hidden_score=true). No operator list, no config — earlier designs kept losing a
// runtime hidden list to state wipes, and the two-column model cannot lose anything: it is
// simply what each source said.
//
// Cache model for the scrape (stale-while-revalidate, never blocking the caller):
//   • `get(names)` does ONE bulk SELECT and returns whatever is stored. It never fetches on
//     the request path; missing/stale names are scraped in the BACKGROUND (ctx.waitUntil),
//     so a brand-new player's public rating appears on a later poll.
//   • A row is re-scraped when it's missing, or last fetched more than `refreshMs` ago.
//     "Last fetched" is tracked in memory (`checkedAt`); after eviction we fall back to the
//     row's `updated_at`.
//   • `updated_at` records when the SCRAPE's view last changed (diff-only writes, no upsert).
//   • The scrape's DELETE + re-INSERT always carries `rating_hidden` through untouched —
//     the columns belong to different sources and must never clobber each other.
//   • `putScores` (balance) updates ONLY `rating_hidden`, creating a bare row when the
//     scrape has never seen the name (with `updated_at = 0`, so the background scrape picks
//     the name up on the next poll and fills the public side in).

import { DurableObject } from "cloudflare:workers";
import { SqlAccounting, trackSqlOnPrototype, type SqlStatsReport } from "../sqlStats";
import {
  fetchPlayerRating,
  normalizeName,
  REQUEST_TIMEOUT_MS,
  type PlayerRating,
  type StoredRating,
} from "./lavaRatings";

/** Background-refresh threshold: a row scraped longer ago than this is refreshed. */
const DEFAULT_REFRESH_MS = 15 * 60 * 1000;

/**
 * Cap on how many names a single background refresh will fetch, bounding the subrequests
 * one invocation makes even on a cold cache. Names left over keep their stale `checkedAt`
 * and are picked up by the next poll's refresh.
 */
const MAX_FETCH_PER_REFRESH = 64;

/**
 * Cloudflare's Durable Object SQLite caps the number of bound parameters in a single
 * statement at 100. A bulk `IN (...)` SELECT or multi-row INSERT that exceeds this throws
 * "too many SQL variables", so every batched statement is split into chunks that stay
 * under the limit (see `chunk`). The INSERT binds 10 columns per row, so its chunk size is
 * `floor(100 / 10)` rows.
 */
const SQL_MAX_BIND_PARAMS = 100;
const INSERT_COLS_PER_ROW = 10;
const MAX_INSERT_ROWS = Math.floor(SQL_MAX_BIND_PARAMS / INSERT_COLS_PER_ROW);

/**
 * Resolved ratings keyed by NORMALIZED name (`normalizeName`: trimmed + lowercased), so
 * callers look up with `resolved[normalizeName(playerName)]`. A name is present when EITHER
 * column has a value; a name absent from the cache (or negative on both sides) is omitted.
 */
export type RatingsResult = Record<string, StoredRating>;

/** A row of the `ratings` table, decoded into JS shapes (camelCase, nullables). */
interface RatingRow {
  name: string;
  /** 1 = the SCRAPE found a public rating; 0 = scraped and not found (or never scraped). */
  found: number;
  playerId: number | null;
  rating: number | null;
  wins: number | null;
  losses: number | null;
  games: number | null;
  winRate: number | null;
  /** epoch millis when the scrape's view of this row last changed (0 = never scraped). */
  updatedAt: number;
  /** The balance endpoint's elo, or null when never fetched there. */
  ratingHidden: number | null;
}

/** The result of scraping one name (null value = a confirmed "no public rating"). */
interface FetchResult {
  key: string;
  value: PlayerRating | null;
}

export class RatingsDO extends DurableObject<Env> {
  /** SQL row-cost accounting per method (src/sqlStats.ts): in memory, served by
   * sqlStatsReport. Declared first so it exists before any wrapped method runs. */
  private readonly sqlStats: SqlAccounting;
  private readonly sql: SqlStorage;
  private readonly refreshMs: number;
  private readonly timeoutMs: number;
  /** Names with a background scrape in flight, so overlapping refreshes don't duplicate it. */
  private readonly inflight = new Set<string>();
  /** In-memory "last scrape attempt" per name, throttling refreshes to once per refreshMs. */
  private readonly checkedAt = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Installed before the first statement so ensureSchema is in the tally too.
    this.sqlStats = new SqlAccounting(ctx.storage.sql);
    this.sql = ctx.storage.sql;
    this.refreshMs = env.RATING_CACHE_REFRESH_MS ?? DEFAULT_REFRESH_MS;
    this.timeoutMs = REQUEST_TIMEOUT_MS;
    // SqlStorage.exec is synchronous, so the schema is ready before any RPC runs.
    this.ensureSchema();
  }

  /**
   * Create the table if it's new and bring an older one up to date. Runs on every
   * instantiation, so it must be idempotent; a wrong answer here throws in the CONSTRUCTOR
   * (failing every rating request), hence the guarded ALTER.
   */
  private ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ratings (
        name          TEXT PRIMARY KEY,
        found         INTEGER NOT NULL,
        player_id     INTEGER,
        rating        INTEGER,
        wins          INTEGER,
        losses        INTEGER,
        games         INTEGER,
        win_rate      REAL,
        updated_at    INTEGER NOT NULL,
        rating_hidden INTEGER
      )
    `);
    // Migration for instances created before `rating_hidden` existed. (Old instances may
    // also carry a legacy `hidden` column from the operator-list era; it is simply ignored.)
    const hasCol = [
      ...this.sql.exec(`SELECT 1 FROM pragma_table_info('ratings') WHERE name = 'rating_hidden'`),
    ].length;
    if (!hasCol) {
      console.log("RatingsDO: adding the rating_hidden column to an existing ratings table");
      try {
        this.sql.exec(`ALTER TABLE ratings ADD COLUMN rating_hidden INTEGER`);
      } catch (e) {
        console.error(`RatingsDO: adding the rating_hidden column failed: ${e}`);
      }
    }
  }

  /** What each method has cost in SQLite rows since this instance started — GET /api/sqlstats. */
  sqlStatsReport(): SqlStatsReport {
    return this.sqlStats.report();
  }

  /**
   * Resolve a batch of player names against the cache. Returns every name either column has
   * a value for, and triggers a background scrape of missing/stale names so public ratings
   * fill in on a later call. Never blocks on an upstream fetch.
   */
  async get(names: string[]): Promise<RatingsResult> {
    const keys = [...new Set(names.map(normalizeName).filter((k) => k.length > 0))];
    if (keys.length === 0) return {};

    const rows = this.selectMany(keys);
    const now = Date.now();
    const out: RatingsResult = {};
    const stale: string[] = [];
    for (const key of keys) {
      const row = rows.get(key);
      if (row && (row.found || row.ratingHidden != null)) out[key] = rowToRating(row);
      // Throttle by the in-memory last-scrape time; after eviction fall back to updated_at
      // (0 for rows the balance endpoint created — so the scrape picks them up promptly).
      const last = this.checkedAt.get(key) ?? row?.updatedAt ?? 0;
      if (!row || now - last >= this.refreshMs) stale.push(key);
    }

    if (stale.length) this.ctx.waitUntil(this.refresh(stale, now));
    return out;
  }

  /**
   * Record the balance endpoint's elos (keyed by normalized name) into `rating_hidden` —
   * and NOTHING else: the scrape owns every other column. A name the scrape has never seen
   * gets a bare row with `updated_at = 0`, which reads as maximally stale, so the next
   * `get()` schedules a scrape to fill the public side in.
   */
  async putScores(elos: Record<string, number>): Promise<void> {
    const entries = Object.entries(elos).filter(
      ([key, elo]) => key.length > 0 && Number.isFinite(elo),
    );
    if (!entries.length) return;

    const existing = this.selectMany(entries.map(([key]) => key));
    const updates = entries.filter(([key, elo]) => {
      const row = existing.get(key);
      return row && row.ratingHidden !== elo;
    });
    const inserts = entries.filter(([key]) => !existing.has(key));

    for (const [key, elo] of updates) {
      this.sql.exec(`UPDATE ratings SET rating_hidden = ? WHERE name = ?`, elo, key);
    }
    for (const batch of chunk(inserts, MAX_INSERT_ROWS)) {
      const binds: (string | number | null)[] = [];
      for (const [key, elo] of batch) {
        binds.push(key, 0, null, null, null, null, null, null, 0, elo);
      }
      this.sql.exec(
        `INSERT INTO ratings
           (name, found, player_id, rating, wins, losses, games, win_rate, updated_at, rating_hidden)
         VALUES ${batch.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",")}`,
        ...binds,
      );
    }
    if (updates.length || inserts.length) {
      console.log(
        `RatingsDO: balance elos recorded (${updates.length} updated, ${inserts.length} new)`,
      );
    }
  }

  /** Bulk-scrape the stale/missing keys and persist whatever actually changed. */
  private async refresh(keys: string[], now: number): Promise<void> {
    const todo = keys.filter((k) => !this.inflight.has(k)).slice(0, MAX_FETCH_PER_REFRESH);
    if (!todo.length) return;
    if (keys.length > todo.length) {
      console.log(
        `RatingsDO: refreshing ${todo.length}/${keys.length} stale names this round (capped)`,
      );
    }
    for (const k of todo) {
      this.inflight.add(k);
      this.checkedAt.set(k, now);
    }
    try {
      const results = await this.fetchMany(todo);
      this.writeChanged(results, Date.now());
    } finally {
      for (const k of todo) this.inflight.delete(k);
    }
  }

  /** Scrape each name from Lavabar concurrently; drop the ones whose fetch failed outright. */
  private async fetchMany(keys: string[]): Promise<FetchResult[]> {
    const settled = await Promise.all(
      keys.map(async (key): Promise<FetchResult | null> => {
        try {
          return { key, value: await this.fetchRating(key) };
        } catch (err) {
          // Transport/parse failure after the built-in retry: leave the cached value as-is.
          console.error(`LavaRatings: failed to fetch rating for ${key}:`, err);
          return null;
        }
      }),
    );
    return settled.filter((r): r is FetchResult => r !== null);
  }

  /** Resolve one name from Lavabar's search page. A seam so tests can stub the network. */
  protected fetchRating(name: string): Promise<PlayerRating | null> {
    return fetchPlayerRating(name, { timeoutMs: this.timeoutMs });
  }

  /**
   * Persist the scraped results, writing ONLY the rows whose scrape view differs from what's
   * stored (so `updated_at` tracks real changes). The DELETE + multi-row INSERT carries the
   * stored `rating_hidden` through untouched — that column belongs to the balance endpoint,
   * and a scrape result (positive or negative) must never disturb it.
   */
  private writeChanged(results: FetchResult[], now: number): void {
    if (!results.length) return;
    const existing = this.selectMany(results.map((r) => r.key));
    const changed = results.filter((r) => differs(existing.get(r.key), r.value));
    if (!changed.length) return;

    for (const batch of chunk(changed, MAX_INSERT_ROWS)) {
      const keyPlaceholders = batch.map(() => "?").join(",");
      this.sql.exec(
        `DELETE FROM ratings WHERE name IN (${keyPlaceholders})`,
        ...batch.map((c) => c.key),
      );

      const rowPlaceholders = batch.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",");
      const binds: (string | number | null)[] = [];
      for (const { key, value } of batch) {
        binds.push(
          key,
          value ? 1 : 0,
          value?.playerId ?? null,
          value?.rating ?? null,
          value?.wins ?? null,
          value?.losses ?? null,
          value?.games ?? null,
          value?.winRate ?? null,
          now,
          existing.get(key)?.ratingHidden ?? null,
        );
      }
      this.sql.exec(
        `INSERT INTO ratings
           (name, found, player_id, rating, wins, losses, games, win_rate, updated_at, rating_hidden)
         VALUES ${rowPlaceholders}`,
        ...binds,
      );
    }
  }

  /** Bulk SELECT the given keys; returns a map keyed by `name` (missing keys are absent). */
  private selectMany(keys: string[]): Map<string, RatingRow> {
    const out = new Map<string, RatingRow>();
    if (!keys.length) return out;
    // Chunk the IN (...) list so a large roster never exceeds SQLite's bound-parameter cap.
    for (const batch of chunk(keys, SQL_MAX_BIND_PARAMS)) {
      const placeholders = batch.map(() => "?").join(",");
      const cursor = this.sql.exec(
        `SELECT name, found, player_id, rating, wins, losses, games, win_rate, updated_at,
                rating_hidden
           FROM ratings WHERE name IN (${placeholders})`,
        ...batch,
      );
      for (const raw of cursor) {
        const row = decodeRow(raw as unknown as RawRow);
        out.set(row.name, row);
      }
    }
    return out;
  }
}

// SQL attribution: wrap the prototype once, at module load (see src/sqlStats.ts).
trackSqlOnPrototype(RatingsDO, ["sqlStatsReport"]);

/** Split `items` into consecutive runs of at most `size` (the last may be shorter). */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Raw column shape returned by SqlStorage (snake_case, numbers/null). */
interface RawRow {
  name: string;
  found: number;
  player_id: number | null;
  rating: number | null;
  wins: number | null;
  losses: number | null;
  games: number | null;
  win_rate: number | null;
  updated_at: number;
  rating_hidden: number | null;
}

function decodeRow(raw: RawRow): RatingRow {
  return {
    name: raw.name,
    found: raw.found,
    playerId: raw.player_id,
    rating: raw.rating,
    wins: raw.wins,
    losses: raw.losses,
    games: raw.games,
    winRate: raw.win_rate,
    updatedAt: raw.updated_at,
    ratingHidden: raw.rating_hidden,
  };
}

function rowToRating(row: RatingRow): StoredRating {
  return {
    playerId: row.playerId ?? 0,
    // The public rating exists only when the scrape FOUND the player.
    rating: row.found ? (row.rating ?? null) : null,
    ratingHidden: row.ratingHidden,
    wins: row.wins ?? 0,
    losses: row.losses ?? 0,
    games: row.games ?? 0,
    winRate: row.winRate ?? 0,
  };
}

/** True if a freshly-scraped value differs from the stored row's scrape view (or is new). */
function differs(existing: RatingRow | undefined, value: PlayerRating | null): boolean {
  if (!existing) return true;
  const found = value ? 1 : 0;
  if (existing.found !== found) return true;
  if (!value) return false; // both are negative ("no public rating") — unchanged
  return (
    existing.playerId !== value.playerId ||
    existing.rating !== value.rating ||
    existing.wins !== value.wins ||
    existing.losses !== value.losses ||
    existing.games !== value.games ||
    existing.winRate !== value.winRate
  );
}
