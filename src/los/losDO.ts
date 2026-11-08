// LosDO — the singleton Durable Object that IS the LOS service's storage and
// single writer (docs/lavaos-cloudflare-data-model.md).
//
// The rating fold is path-dependent and strictly forward-only, so the DO
// holds both the fold's state and the log it produces in one SQLite:
//   • games        — one row per STORED game: status 'rated' | 'ignored'.
//                    Only rateable lava games are stored (ineligible ones are
//                    reported to the uploader and dropped), so every row is a
//                    real 8v8 with a winner.
//   • game_players — roster AND rating log in one table; rating columns are
//                    NULL on ignored games.
//   • players      — the fold's running state = the leaderboard. INVARIANT:
//                    a row always equals the mu/sigma_after of that user's
//                    highest-seq rated game.
//   • meta         — last_seq, the fold head (start_time, id of the last
//                    rated game), algo/schema versions.
//
// Every upload commits in ONE transactionSync: readers see pre- or
// post-upload state, never between, and a failed upload changes nothing
// (retries are idempotent — stored games dedupe by id, dropped games
// re-classify to the same verdict).

import { DurableObject } from "cloudflare:workers";
import {
  avoidKey,
  avoidName,
  MAX_AVOIDS_PER_PLAYER,
  type AddAvoidResult,
  type AvoidEntry,
  type RemoveAvoidResult,
} from "../avoids";
import { SqlAccounting, trackSqlOnPrototype, type SqlStatsReport } from "../sqlStats";
import {
  BOARD_KEEP,
  BOARD_MIN_GAMES,
  filterBoards,
  scoutBoards,
  type ScoutBoards,
  type ScoutCard,
  type ScoutUpload,
} from "../scout";
import type { AuthUser } from "../auth";
import {
  GAME_START_TTL_MS,
  parseGameStartSnapshot,
  type GameStartSnapshot,
} from "../gameStart";
import { isRatedMapName, startMetalReason, startMetalStorage, START_METAL_RULE_FROM } from "../lavaos/lava";
import type { ReplayDetail } from "../lavaos/types";
import { DEMOTE_MARGIN, tierIndexOf, tierOf, tierOfIndex, type Tier } from "./tiers";
import {
  ALGO_VERSION,
  applyRatedGame,
  classifyReplay,
  extractLobby,
  leaderboardOf,
  losOf,
  shownLosOf,
  predictTeams,
  type GameInput,
  type PlayerState,
} from "./losGames";

export interface LosEnv {
  LOS: DurableObjectNamespace<LosDO>;
}

/** How long a poll's tally is served from memory before it is re-read (votes drop it at once). */
const POLL_TALLY_TTL_MS = 10 * 60_000;

/** Votes on one poll: overall and by the voters' rank tier ("unrated" = no LOS row). */
export interface PollTally {
  total: number;
  counts: Record<string, number>;
  byTier: { tier: string; total: number; counts: Record<string, number> }[];
}

export interface PollState extends PollTally {
  /** The asking user's own vote, or null. */
  myVote: { choice: string; votedAt: number; updatedAt: number; changes: number } | null;
  /** Every voter, latest change first — admins only. */
  voters?: {
    userId: number;
    name: string;
    choice: string;
    votedAt: number;
    updatedAt: number;
    changes: number;
    tier: Tier | null;
    games: number;
  }[];
}

/** SQLite caps bound parameters per statement at 100; IN(...) lists chunk under it. */
const SQL_MAX_BIND_PARAMS = 100;

/** The maintained row counts (the `counts` table) a read may ask for. */
type CountKey = "players" | "players_ranked" | "games" | "games_rated";

/**
 * A player with no rated game in this many days is `inactive`: off the
 * leaderboard until they play again, but hidden in no other way.
 */
const INACTIVE_DAYS = 35;
const INACTIVE_MS = INACTIVE_DAYS * 24 * 60 * 60 * 1000;

/**
 * How often a READ may re-derive `inactive` (refreshRanks). Uploads already do
 * it, so this only covers the passage of time — a player lapses because nothing
 * happened, which no write can notice. Cheap at this cadence and far finer than
 * the 35-day boundary it tracks.
 */
const ACTIVITY_SWEEP_MS = 6 * 60 * 60 * 1000;

/**
 * `rank_history` — one row per player per UTC day, written by refreshRanks (see
 * recordDailySnapshot) and read back as the BASELINE the `rank_change_7d` /
 * `los_change_7d` columns are measured against.
 *
 * How far back that baseline sits. The lookup takes the newest recorded day at
 * or before `today − RANK_HISTORY_DAYS`, so a day nobody uploaded a game on
 * (nothing runs refreshRanks, nothing is recorded) falls back to the one before
 * it rather than to nothing — and `RANK_HISTORY_MAX_AGE_DAYS` is where that
 * falling back stops. Past it there is no baseline and both changes are NULL,
 * which is also what every player sees for the store's first week: a "7-day
 * change" measured over three days would be a different number wearing the same
 * label.
 */
const RANK_HISTORY_DAYS = 7;
const RANK_HISTORY_MAX_AGE_DAYS = 14;

/** How many past days `rebuildRankHistory` (the admin button) redraws. */
const RANK_HISTORY_REBUILD_DAYS = 8;

/**
 * How long a snapshot is kept. The table gains a row per player per day
 * forever otherwise (~700/day here), and nothing reads past the baseline
 * window — the retention is generous next to it only so a widened window, or a
 * rebuild, has something to work with.
 */
const RANK_HISTORY_RETENTION_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar day an instant falls in, as "YYYY-MM-DD" — the key
 * `rank_history` is stamped and ordered by. Lexicographic order on this IS
 * chronological order, which is what lets the baseline lookup be a MAX(). */
function utcDayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 00:00:00Z of the day AFTER `day` — the exclusive instant a day's state is
 * taken at, so a game started at 23:59 on it still counts. */
function dayEndInstant(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString();
}

/** Whether a stored nullable number is already the value just derived — the
 * skip test that keeps refreshRanks writing only the rows that moved. */
function sameNullableNumber(stored: SqlStorageValue, derived: number | null): boolean {
  if (stored == null || derived == null) return stored == null && derived == null;
  return Number(stored) === derived;
}

/** The change columns, as they come back from `rankingRows` — named once so
 * wirePlayerRow can tell "the SELECT did not ask for these" (the lookup and
 * search shapes) from "there is no baseline for this player" (a NULL). */
const RANK_CHANGE_COLUMNS = ["rank_change_7d", "los_change_7d"] as const;

/** One player's place on the board on one day: what `rank_history` stores. */
interface RankSnapshotRow {
  userId: number;
  rank: number;
  los: number;
}

/** What rebuildRankHistory redrew. */
export interface RankHistoryRebuildResult {
  /** The days rewritten, oldest first. */
  days: string[];
  /** Rows written across all of them. */
  rows: number;
  /** Rated games rewound to reach the oldest of them. */
  games: number;
  /** Players on the board on the newest rebuilt day. */
  players: number;
}

/**
 * What the ranking may be ordered by — one key per sortable COLUMN of the page,
 * which is why `rank` and `los` are both here even though they are the same
 * ordering: `rank` is materialized FROM `los`, so "# ascending" and "LOS
 * descending" are the same list, and each header should still read naturally
 * on its own terms.
 */
export const RANKING_SORTS = ["rank", "los", "rankChange", "losChange", "tier"] as const;
export type RankingSort = (typeof RANKING_SORTS)[number];
export type RankingDir = "asc" | "desc";

/**
 * How each sort key becomes an ORDER BY.
 *
 * `column` is what it actually orders by and `flip` says whether the requested
 * direction is inverted on the way (only `rank`, whose 1 is `los`'s highest).
 * `nullable` picks the shape of the clause, and that distinction is the whole
 * reason this is a table rather than a string concatenation:
 *
 *   • A NOT NULL column needs ONE index. `los DESC, user_id` read backwards is
 *     `los ASC, user_id DESC`, so the ascending clause flips the TIEBREAK too —
 *     an exact reversal is an index scan, anything else is a sort of the table,
 *     and which of two players with identical ratings comes first is arbitrary
 *     either way.
 *   • A NULLABLE column cannot do that. "No baseline" is not a small change and
 *     not a large one; it belongs at the END whichever way the column is read,
 *     which takes a leading `<col> IS NULL` key — and reversing THAT puts the
 *     unknowns first again. So the change columns get one index per direction
 *     (see ensurePlayerIndexes), both scanned forwards, and the tiebreak stays
 *     `user_id` in both.
 *
 * `defaultDir` is the direction a first click on that header gives: the one
 * that puts what the column is interesting FOR at the top — best rating, best
 * position, biggest gain.
 */
const RANKING_SORT_ORDERS: Record<
  RankingSort,
  { column: string; nullable: boolean; flip: boolean; defaultDir: RankingDir }
> = {
  rank: { column: "los", nullable: false, flip: true, defaultDir: "asc" },
  los: { column: "los", nullable: false, flip: false, defaultDir: "desc" },
  rankChange: { column: "rank_change_7d", nullable: true, flip: false, defaultDir: "desc" },
  losChange: { column: "los_change_7d", nullable: true, flip: false, defaultDir: "desc" },
  // The visitors' board: rank tier, then games played (see TIER_ORDER_BY).
  tier: { column: "tier", nullable: false, flip: false, defaultDir: "desc" },
};

/** The tier board's two keys, best first: higher tier, then more games. The
 * exact reversal (tiebreak included) is the ascending order, so one index per
 * list answers both ways (idx_players_tier*). */
const TIER_ORDER_BY = { desc: "ORDER BY tier DESC, games DESC, user_id", asc: "ORDER BY tier ASC, games ASC, user_id DESC" };

/** The default view: the leaderboard, best first — what /api/ranking has always served. */
const DEFAULT_RANKING_SORT: RankingSort = "rank";

/** The ORDER BY for one sort, and the matching comparator for the search path
 * (which sorts its materialized matches in JS — see ranking). */
function rankingOrderBy(sort: RankingSort, dir: RankingDir): string {
  const spec = RANKING_SORT_ORDERS[sort];
  const desc = spec.flip ? dir === "asc" : dir === "desc";
  if (sort === "tier") return desc ? TIER_ORDER_BY.desc : TIER_ORDER_BY.asc;
  if (!spec.nullable) {
    // The exact reversal, tiebreak included, so one index answers both ways.
    return desc
      ? `ORDER BY ${spec.column} DESC, user_id`
      : `ORDER BY ${spec.column} ASC, user_id DESC`;
  }
  // Unknown last in both directions; one index per direction, both forwards.
  return `ORDER BY ${spec.column} IS NULL, ${spec.column} ${desc ? "DESC" : "ASC"}, user_id`;
}

/** The same order over rows already in hand (the search path). */
function rankingComparator(
  sort: RankingSort,
  dir: RankingDir,
): (a: Record<string, SqlStorageValue>, b: Record<string, SqlStorageValue>) => number {
  const spec = RANKING_SORT_ORDERS[sort];
  const desc = spec.flip ? dir === "asc" : dir === "desc";
  if (sort === "tier") {
    const key = (r: Record<string, SqlStorageValue>) => [Number(r.tier ?? 0), Number(r.games)];
    return (a, b) => {
      const [at, ag] = key(a);
      const [bt, bg] = key(b);
      const cmp = bt - at || bg - ag || Number(a.user_id) - Number(b.user_id);
      return desc ? cmp : -cmp;
    };
  }
  return (a, b) => {
    const av = a[spec.column];
    const bv = b[spec.column];
    // Unknown last, exactly as the SQL clause puts it.
    if (av == null || bv == null) {
      if (av != null) return -1;
      if (bv != null) return 1;
      return Number(a.user_id) - Number(b.user_id);
    }
    const cmp = desc ? Number(bv) - Number(av) : Number(av) - Number(bv);
    if (cmp !== 0) return cmp;
    return desc || spec.nullable ? Number(a.user_id) - Number(b.user_id) : Number(b.user_id) - Number(a.user_id);
  };
}

/** Normalize the two request params; anything unrecognized falls back, so an
 * older or hand-written URL still gets a list rather than an error. */
export function parseRankingSort(sort?: string, dir?: string): { sort: RankingSort; dir: RankingDir } {
  const key = (RANKING_SORTS as readonly string[]).includes(sort ?? "")
    ? (sort as RankingSort)
    : DEFAULT_RANKING_SORT;
  const wanted = dir === "asc" || dir === "desc" ? dir : RANKING_SORT_ORDERS[key].defaultDir;
  return { sort: key, dir: wanted };
}

const RANKING_MAX_PER_PAGE = 200;
const GAMES_MAX_LIMIT = 100;
const RECENT_GAMES_LIMIT = 20;
const SEARCH_LIMIT = 20;

export interface UploadResult {
  /** Entered the LOS fold, in fold order. */
  rated: string[];
  /** Stored with roster but never rated: at/before the fold head, or an
   * off-map lava game (reason "off-map" — every other eligibility rule
   * passed, the map is just not the one the rating is defined over). */
  ignored: { id: string; startTime: string; headAt: string; reason?: "off-map" | "start metal storage" }[];
  /** Lava but eligibility-ineligible — reported, NOT stored. */
  skipped: { id: string; reason: string }[];
  /** Already stored (rated or ignored) — no-op. */
  duplicate: string[];
  /** Not a lava game — NOT stored. */
  rejected: string[];
  lastSeq: number;
  players: number;
}

/** A game's roster entry on the wire (list + detail). */
interface WirePlayer {
  userId: number;
  name: string;
  team: number;
  won: boolean;
  faction: string | null;
  barSkill: number | null;
  /** BAR's chevron level at the time of this game; null on rows stored
   * before it was kept, and on players whose replay stated none. */
  barRank: number | null;
  gameNumber: number | null;
  losBefore: number | null;
  /** Rank tier going into the game (null when unrated or withheld). */
  tier: Tier | null;
  losAfter: number | null;
  losDelta: number | null;
  muBefore: number | null;
  sigmaBefore: number | null;
  muAfter: number | null;
  sigmaAfter: number | null;
  /** Set only when this entry has been blanked because the player's profile is
   * private (see redactRosterRating) — the pages draw a "?" against the missing
   * rating rather than the plain dash an unrated game gets. */
  privateProfile?: boolean;
}

/** A player's current rating state on the wire (ranking rows, name lookups). */
interface WireRatedPlayer {
  userId: number;
  name: string;
  los: number;
  /** Rank tier: the stored one (with hysteresis) where the read selected it. */
  tier: Tier | null;
  mu: number;
  sigma: number;
  leaderboardRating: number;
  games: number;
  wins: number;
  losses: number;
  lastPlayed: string;
  barOs: number | null;
  /** True when an admin has hidden this profile from the public site. */
  privateProfile?: boolean;
  /** True when this player has no rated game in INACTIVE_DAYS. Unlike a private
   * profile it hides nothing — the player is simply off the leaderboard until
   * they play again. Both fields are absent from the shapes that do not select
   * the columns (the bulk name lookup, the name search). */
  inactive?: boolean;
  /** Positions gained and LOS gained over the last RANK_HISTORY_DAYS days
   * (positive = up the board, both of them), from the materialized columns —
   * null when there is no snapshot that old to compare against. Absent, like
   * the two flags above, from the shapes that do not select the columns. */
  rankChange7d?: number | null;
  losChange7d?: number | null;
}

/**
 * One row of the ranking: a rated player plus their position on the list.
 *
 * `rank` is null for a private profile — a visitor gets it in the tail with no
 * position at all, and there the RATING fields are null too (see
 * `redactRatedPlayer`), since a leaderboard that still printed the number would
 * make the private player page's silence pointless. What survives is what the
 * public games list already tells anyone: games, W–L, last played.
 */
type WireRankedPlayer = Omit<WireRatedPlayer, "los" | "mu" | "sigma" | "leaderboardRating"> & {
  rank: number | null;
  los: number | null;
  mu: number | null;
  sigma: number | null;
  leaderboardRating: number | null;
};

/** Why a stored game is unranked; NULL on rated games. */
type UnrankedReason = "off-map" | "start metal storage" | "uploaded too late" | "excluded";

/** What rebase() did, or why it refused. */
export type RebaseResult =
  | { ok: false; error: string }
  | {
      ok: true;
      /** The rebase point (the requested game). */
      from: string;
      /** Stored games re-folded (the point included). */
      games: number;
      /** Of those, now rated / left ignored (off-map, start metal, excluded). */
      rated: number;
      ignored: number;
      /** Players whose state was rebuilt. */
      players: number;
      lastSeq: number;
    };

/** What setGameExcluded did to one game's `excluded` marker. */
export interface ExcludeResult {
  id: string;
  excluded: boolean;
  /** False when the marker already had the requested value (the call was a no-op). */
  changed: boolean;
  /** The game's fold status, which this call does NOT touch. */
  ignored: boolean;
  /**
   * True when the marker and the fold now disagree — a marked game still
   * carrying ratings, or an unmarked one still unrated for having been
   * marked. Re-running the LOS fold from this game is what settles it.
   */
  needsRebase: boolean;
}

/** What setPrivateProfile did to one player's `private_profile` flag. */
/** What one onetricklava push did (POST /api/scout/profiles). */
export interface ScoutPutResult {
  stored: number;
  unchanged: number;
  removed: number;
  /** Cards held after the push. */
  total: number;
}

export interface PrivacyResult {
  userId: number;
  name: string;
  privateProfile: boolean;
  /** False when the flag already had the requested value (the call was a no-op). */
  changed: boolean;
}

interface WireGame {
  id: string;
  startTime: string;
  durationMs: number;
  map: string;
  winnerTeam: number;
  ignored: boolean;
  /** Set exactly when `ignored` — the unrated badge's tooltip. */
  unrankedReason: UnrankedReason | null;
  /**
   * An admin marked this game ignored (setGameExcluded). Independent of
   * `ignored`: the flag only tells the NEXT fold to skip the game, so a game
   * that was rated before it was marked stays `ignored: false` — with its
   * ratings — until a rebase from it actually drops them.
   */
  excluded: boolean;
  teams: WirePlayer[][];
  /** Pre-game predicted win chance per team (rated games only, else null). */
  predictedWin: number[] | null;
  /**
   * Each team's mean pre-game LOS, null for a team with no rated players.
   * Computed here rather than by the pages because it is taken BEFORE any
   * private player's entry is blanked: a team average that quietly dropped a
   * member would be both wrong and a leak — subtract the seven-man mean shown
   * on one page from the eight-man mean shown on another and the hidden
   * rating falls out.
   */
  avgLosBefore: (number | null)[];
}

export class LosDO extends DurableObject<LosEnv> {
  /** SQL row-cost accounting per method (src/sqlStats.ts): in memory, served by
   * sqlStatsReport. Declared first so it exists before any wrapped method runs. */
  private readonly sqlStats: SqlAccounting;
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: LosEnv) {
    super(ctx, env);
    // Installed before the first statement so ensureSchema is in the tally too.
    this.sqlStats = new SqlAccounting(ctx.storage.sql);
    this.sql = ctx.storage.sql;
    // SqlStorage.exec is synchronous, so the schema is ready before any RPC.
    this.ensureSchema();
  }

  /** What each method has cost in SQLite rows since this instance started — GET /api/sqlstats. */
  sqlStatsReport(): SqlStatsReport {
    return this.sqlStats.report();
  }

  private ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS games (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        start_time     TEXT NOT NULL,
        duration_ms    INTEGER NOT NULL,
        map            TEXT NOT NULL,
        engine_version TEXT,
        game_version   TEXT,
        winner_team    INTEGER NOT NULL,
        status         TEXT NOT NULL,
        uploaded_at    TEXT NOT NULL,
        -- Why an 'ignored' game is unranked ('off-map' | 'uploaded too late' |
        -- 'excluded'); NULL on rated games. Shown as the unrated badge's tooltip.
        unranked_reason TEXT,
        -- 1 = an admin marked this game ignored (the games page's row menu,
        -- setGameExcluded). A MARKER for the fold, not a rating change: it is
        -- what makes rebase leave the game unrated, and on its own it touches
        -- neither the status column nor anybody's LOS: the ratings a game
        -- already produced stand until the LOS fold is re-run from it. Never
        -- set by an upload; survives a rebase, which reads it.
        excluded INTEGER NOT NULL DEFAULT 0,
        -- The lobby info barreplay's lava sync rode on the upload (lobbyName +
        -- lobbyDetails with the party roster), verbatim JSON; NULL when the
        -- upload carried none. Served by gameDetail only — nothing filters on it.
        lobby TEXT,
        -- The replay's startmetalstorage modoption (NULL: not recorded, i.e.
        -- the row predates the column). What rebase re-judges the start-metal
        -- rule by (lava.ts startMetalReason).
        start_metal_storage REAL
      );
      -- The list orders by (start_time, id) — the id tiebreak is part of the
      -- keyset cursor too — so both indexes carry it; without it every page
      -- paid a sort. (The earlier start_time-only versions are dropped below.)
      CREATE INDEX IF NOT EXISTS idx_games_time_id        ON games (start_time DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_games_status_time_id ON games (status, start_time DESC, id DESC);
      DROP INDEX IF EXISTS idx_games_time;
      DROP INDEX IF EXISTS idx_games_status_time;
      CREATE TABLE IF NOT EXISTS game_players (
        game_id      TEXT    NOT NULL REFERENCES games(id),
        user_id      INTEGER NOT NULL,
        team         INTEGER NOT NULL,
        won          INTEGER NOT NULL,
        name         TEXT    NOT NULL,
        faction      TEXT,
        bar_skill    REAL,
        -- BAR's chevron level at the time of THIS game (see GamePlayerInput.
        -- barRank). Nullable, and 0 is a real level: an account with under
        -- five hours, not a missing reading.
        bar_rank     INTEGER,
        start_time   TEXT    NOT NULL,
        game_number  INTEGER,
        mu_before    REAL,
        sigma_before REAL,
        mu_after     REAL,
        sigma_after  REAL,
        PRIMARY KEY (game_id, user_id)
      ) WITHOUT ROWID;
      -- A player's games are read by (start_time, game_id) in both directions
      -- (recent/paged newest-first, the chart oldest-first) and counted per
      -- player. game_id need not be listed: on a WITHOUT ROWID table every
      -- index implicitly ends in the primary key (game_id, user_id), so this
      -- one already orders the tiebreak (verified with EXPLAIN QUERY PLAN).
      CREATE INDEX IF NOT EXISTS idx_gp_player_time ON game_players (user_id, start_time);
      CREATE TABLE IF NOT EXISTS players (
        user_id      INTEGER PRIMARY KEY,
        name         TEXT NOT NULL,
        mu           REAL NOT NULL,
        sigma        REAL NOT NULL,
        los          REAL NOT NULL,
        games        INTEGER NOT NULL,
        wins         INTEGER NOT NULL,
        first_played TEXT NOT NULL,
        last_played  TEXT NOT NULL,
        bar_os       REAL,
        -- TRUE leaderboard position, over every player: what the admin view
        -- shows, since it sees the whole list in its real order.
        rank         INTEGER,
        -- Position among RANKED players only (NULL when this row is not one):
        -- what a visitor sees. The two differ once anyone drops off the
        -- leaderboard — a player below a hidden or lapsed one is #6 truly and
        -- #5 publicly — and both are materialized because the name search needs
        -- a row's global position without counting the rows above it.
        public_rank  INTEGER,
        -- 1 = the profile is hidden from the public site (admin-set, see
        -- setPrivateProfile): off the leaderboard, and the player page serves no
        -- rating to a non-admin reader. Never touched by an upload — the fold
        -- rates a private player exactly like anyone else, only the READS hide
        -- them, so the bot keeps balancing on their real rating.
        private_profile INTEGER NOT NULL DEFAULT 0,
        -- 1 = no rated game in INACTIVE_DAYS (derived from last_played, kept up
        -- to date by refreshRanks). Off the leaderboard as well, but NOTHING is
        -- hidden: a lapsed player's profile, rating and games are as public as
        -- anyone's. They simply hold no position while they are not playing.
        inactive     INTEGER NOT NULL DEFAULT 0,
        -- The two reasons above, folded into the one flag the ranking's indexes
        -- key on: ranked = (private_profile = 0 AND inactive = 0). Materialized
        -- because the head would otherwise key on that conjunction and the tail
        -- on its OR-negation, and an OR cannot drive a range scan — the tail
        -- would go looking for its rows by scanning the table.
        ranked       INTEGER NOT NULL DEFAULT 1,
        -- How far this player has moved in the last RANK_HISTORY_DAYS days:
        -- positions gained (positive = UP the board, so it reads the same way
        -- the LOS one does) and LOS gained, both against the rank_history
        -- snapshot (see rank_history) refreshRanks picks as the baseline. NULL
        -- when there is no baseline for them — a store younger than the
        -- window, a player who had not played yet. MATERIALIZED rather than
        -- computed per read for the reason every other derived column here is:
        -- a page may want the list
        -- ORDERED by one of them, and an expression over a joined snapshot
        -- cannot be indexed. Compared against the TRUE rank column, the one
        -- defined for every row (public_rank is NULL for a private or lapsed
        -- player, so a delta over it would vanish when someone lapsed).
        rank_change_7d INTEGER,
        los_change_7d  REAL
      );
      -- The indexes over this table are created AFTER the column migration,
      -- not here: several of them name columns that a store written by an older
      -- build does not have yet, and CREATE INDEX on a missing column is an
      -- error, not a no-op. See ensurePlayerIndexes.
      -- Row counts the pages show as totals, maintained by the upload (the
      -- single writer) so a page never pays a COUNT(*) scan of the table it
      -- lists. Keys: players, players_ranked (the leaderboard's length — the
      -- rest are the tail), games (every stored game), games_rated.
      CREATE TABLE IF NOT EXISTS counts (
        key TEXT PRIMARY KEY,
        n   INTEGER NOT NULL
      );
      -- One day's leaderboard, kept so the ranking can say what MOVED. Written
      -- once per UTC day by the first refreshRanks after midnight, which stamps
      -- the state it has just derived with the day that ended (see
      -- recordDailySnapshot); rebuildRankHistory redraws the recent ones from
      -- the game log.
      --
      -- rank is the TRUE position over every player, matching players.rank —
      -- see the change columns there for why not public_rank. los is that day's
      -- rating, which is what the LOS change is measured against.
      --
      -- (day, user_id) is the key because every read is "one day's rows": the
      -- baseline load is a range over the day, and picking the baseline day is a
      -- MAX() seek down the same index. WITHOUT ROWID keeps the row and its key
      -- in one place, which for a two-number row is most of it.
      CREATE TABLE IF NOT EXISTS rank_history (
        day     TEXT    NOT NULL,
        user_id INTEGER NOT NULL,
        rank    INTEGER NOT NULL,
        los     REAL    NOT NULL,
        PRIMARY KEY (day, user_id)
      ) WITHOUT ROWID;
      -- The bot-uploaded game-start roster, one row per battle id (battle ids
      -- persist across games, so a new game's upload overwrites). Written by
      -- POST /api/gamestart, cleared by POST /api/gameend, read by
      -- /api/lobbies/:id while the game runs — see src/gameStart.ts. Unrelated
      -- to the fold; it lives here because this is the SQLite DO that survives
      -- (the Dispatcher, the other candidate, is slated for removal).
      CREATE TABLE IF NOT EXISTS lobby_states (
        battle_id  INTEGER PRIMARY KEY,
        started_at INTEGER NOT NULL,
        snapshot   TEXT NOT NULL
      );
      -- Avoid lists (src/avoids.ts): "owner asked not to be teamed with avoid".
      -- Written by the bot's .avoid/.avoidremove whispers through the
      -- /api/avoids routes, read by the balancer and by the lobby page's
      -- admin-only view. Keyed on the LOWERCASED names, which is what every
      -- lookup joins on; the *_name columns keep the spelling people read (the
      -- avoided one as the ranking spells it). Unrelated to the fold, and here
      -- for the same reason lobby_states is: this is the SQLite DO that
      -- survives.
      CREATE TABLE IF NOT EXISTS avoids (
        owner_key     TEXT NOT NULL,
        avoid_key     TEXT NOT NULL,
        owner_name    TEXT NOT NULL,
        avoid_name    TEXT NOT NULL,
        avoid_user_id INTEGER,
        created_at    TEXT NOT NULL,
        PRIMARY KEY (owner_key, avoid_key)
      ) WITHOUT ROWID;
      -- A lobby's entries are looked up from BOTH ends (the roster is matched
      -- against owners and against targets), and the primary key only orders
      -- the owner side.
      CREATE INDEX IF NOT EXISTS idx_avoids_target ON avoids (avoid_key);
      -- Website login (src/auth.ts). Both tables are keyed on the SHA-256 of
      -- the token, never the token itself, so a copy of this database cannot
      -- be replayed as a login. auth_links are the one-time links the bot
      -- whispers (short-lived, single use); auth_sessions are the logged-in
      -- browsers. Like avoids, /api/reset leaves them alone: a fold rebuild
      -- has no business logging everybody out.
      CREATE TABLE IF NOT EXISTS auth_links (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL,
        name       TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_auth_links_user ON auth_links (user_id);
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL,
        name       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id);
      -- Scouting cards (src/scout.ts): play-style profiles onetricklava PUSHES
      -- (POST /api/scout/profiles), one JSON card per BAR account. Not part of
      -- the fold, and like avoids /api/reset leaves it alone: OTL only sends
      -- what CHANGED since its last push, so a wipe here would stay empty
      -- until OTL is told to resend everything. name_key = the lowercased
      -- name, for rosters whose players LOS has not rated; games feeds the
      -- board rebuild, which only reads the regulars.
      CREATE TABLE IF NOT EXISTS scout_profiles (
        user_id    INTEGER PRIMARY KEY,
        name_key   TEXT NOT NULL,
        games      INTEGER NOT NULL,
        data       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scout_name ON scout_profiles (name_key);
      CREATE INDEX IF NOT EXISTS idx_scout_games ON scout_profiles (games);
      -- The precomputed Scouting-page boards and the last push's facts. Its
      -- own table rather than meta, which /api/reset drops.
      CREATE TABLE IF NOT EXISTS scout_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      -- Polls (src/polls.ts): one row per poll. The question and options are
      -- code; this row is what the votes hang off (created the first time the
      -- poll is read). Like avoids, /api/reset leaves polls and their votes
      -- alone: people cast them, no upload can put them back.
      CREATE TABLE IF NOT EXISTS polls (
        id         INTEGER PRIMARY KEY,
        slug       TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      -- One row per (poll, logged-in BAR account): their CURRENT vote, so
      -- changing it overwrites rather than adds. name = the account name at
      -- the last vote; voted_at = first vote, updated_at = last change of
      -- choice, changes = how many times they changed it.
      CREATE TABLE IF NOT EXISTS poll_results (
        poll_id    INTEGER NOT NULL,
        user_id    INTEGER NOT NULL,
        name       TEXT NOT NULL,
        choice     TEXT NOT NULL,
        voted_at   INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        changes    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (poll_id, user_id)
      ) WITHOUT ROWID;
    `);
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES ('algo_version', ?)
       ON CONFLICT(key) DO NOTHING`,
      ALGO_VERSION,
    );
    // Strict order: the tables exist, THEN every column they have grown since,
    // THEN the indexes over those columns, THEN the data derived from them.
    const added = this.migrateColumns();
    this.ensurePlayerIndexes();
    this.ensureDerived(added);
  }

  /**
   * Add the columns this build expects to a table an older build created.
   * Returns the ones it actually added, which is what tells `ensureDerived`
   * that their contents are still the DEFAULT and have to be computed — on a
   * fresh store (CREATE TABLE already made them) and on an up-to-date one it
   * comes back empty and nothing is rebuilt.
   *
   * Runs BEFORE ensurePlayerIndexes, because an index over a column that does
   * not exist yet fails the whole constructor: the DO then cannot even serve
   * the page that would have migrated it ("no such column: ranked").
   */
  private migrateColumns(): ReadonlySet<string> {
    const added = new Set<string>();
    const has = (table: string, column: string) =>
      [...this.sql.exec(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`, table, column)].length > 0;
    const add = (table: string, column: string, decl: string) => {
      if (has(table, column)) return;
      this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      added.add(column);
    };
    add("players", "rank", "INTEGER");
    add("players", "public_rank", "INTEGER");
    add("players", "private_profile", "INTEGER NOT NULL DEFAULT 0");
    add("players", "inactive", "INTEGER NOT NULL DEFAULT 0");
    add("players", "ranked", "INTEGER NOT NULL DEFAULT 1");
    add("players", "rank_change_7d", "INTEGER");
    add("players", "los_change_7d", "REAL");
    // Current rank tier index (src/los/tiers.ts), kept by upsertPlayer with
    // hysteresis; NULL only between this column's creation and ensureDerived.
    add("players", "tier", "INTEGER");
    add("games", "unranked_reason", "TEXT");
    add("games", "excluded", "INTEGER NOT NULL DEFAULT 0");
    add("games", "lobby", "TEXT");
    // Filled by the upload, and for rows stored before it by a duplicate
    // re-upload (backfillGameFacts); rebase refuses until those are filled.
    add("games", "start_metal_storage", "REAL");
    // Nothing follows this one in ensureDerived: the chevron is a per-game
    // fact only the upload carries, so rows stored before the column have no
    // source to be rebuilt from and keep NULL.
    add("game_players", "bar_rank", "INTEGER");
    return added;
  }

  /** The indexes over `players`; see the note in ensureSchema for why they are
   * not created with the table. */
  private ensurePlayerIndexes(): void {
    this.sql.exec(`
      -- The whole leaderboard in order: the admin's ranking page and the
      -- refreshRanks walk.
      CREATE INDEX IF NOT EXISTS idx_players_ranking ON players (los DESC, user_id);
      -- The public ranking's HEAD: leading equality on the ranked flag, the rest
      -- already in leaderboard order — no sort, and not one unranked row read.
      CREATE INDEX IF NOT EXISTS idx_players_ranked ON players (ranked, los DESC, user_id);
      -- Its TAIL, in the order that list is served (see ranking): most recently
      -- seen first. Ordering the unranked by RATING would both read as a
      -- ranking and, for the private rows whose rating is blanked, leak the very
      -- thing the blanking hides. Paged in SQL through this index, because the
      -- tail holds every lapsed player and that is most of a mature store.
      CREATE INDEX IF NOT EXISTS idx_players_unranked ON players (ranked, last_played DESC, user_id);
      DROP INDEX IF EXISTS idx_players_visible;
      CREATE INDEX IF NOT EXISTS idx_players_name ON players (name COLLATE NOCASE);
      -- The board ordered by what MOVED, one index per DIRECTION. These are the
      -- reason the two changes are columns rather than a join against
      -- rank_history: an ORDER BY over a snapshot joined per read can only ever
      -- be a sort of the whole table.
      --
      -- Two per column rather than one read backwards, because the leading
      -- <col> IS NULL key is what keeps "no baseline" at the BOTTOM whichever
      -- way the column is read (see rankingOrderBy) and reversing an index
      -- reverses that key with it.
      --
      -- They lead with ranked like the other ranking indexes because the only
      -- view that orders by these columns asks for the RANKED players alone —
      -- a movement list is about who is climbing, which a lapsed or hidden
      -- player is not doing. The expression must appear in the ORDER BY exactly
      -- as it does here, or the planner sorts the table in a temp b-tree
      -- instead — pinned in losCost.workers.test.ts.
      DROP INDEX IF EXISTS idx_players_los_change;
      DROP INDEX IF EXISTS idx_players_rank_change;
      CREATE INDEX IF NOT EXISTS idx_players_los_change_desc
        ON players (ranked, los_change_7d IS NULL, los_change_7d DESC, user_id);
      CREATE INDEX IF NOT EXISTS idx_players_los_change_asc
        ON players (ranked, los_change_7d IS NULL, los_change_7d ASC, user_id);
      CREATE INDEX IF NOT EXISTS idx_players_rank_change_desc
        ON players (ranked, rank_change_7d IS NULL, rank_change_7d DESC, user_id);
      CREATE INDEX IF NOT EXISTS idx_players_rank_change_asc
        ON players (ranked, rank_change_7d IS NULL, rank_change_7d ASC, user_id);
      -- The tier board (rank tier, then games played): the public ranking's
      -- order, and a sort the admin can pick. Read backwards for ascending.
      CREATE INDEX IF NOT EXISTS idx_players_tier_ranked ON players (ranked, tier DESC, games DESC, user_id);
      CREATE INDEX IF NOT EXISTS idx_players_tier ON players (tier DESC, games DESC, user_id);
    `);
  }

  /**
   * Bring a store written before the derived data existed up to date: the
   * materialized `rank` column (a store from before it gets the column) and
   * the `counts` rows (empty on a fresh store and on one from before the
   * table). Both are then rebuilt from a full scan — once, on the first
   * construction after the deploy; every construction after that reads one
   * row of `counts` and finds it seeded.
   */
  private ensureDerived(added: ReadonlySet<string> = new Set()): void {
    if (added.has("unranked_reason")) {
      this.sql.exec(`UPDATE games SET unranked_reason = 'uploaded too late' WHERE status = 'ignored'`);
    }
    if (this.getMeta("unranked_reason_label") !== "3") {
      // One-time label repairs: the rename a short-lived build stored, and —
      // the Crescent Bay lesson — ignored off-map rows a blanket backfill once
      // labelled "uploaded too late". The MAP decides off-map, never the
      // label (isRatedMapName; LIKE mirrors its startsWith).
      this.sql.exec(`UPDATE games SET unranked_reason = 'uploaded too late' WHERE unranked_reason = 'behind fold head'`);
      this.sql.exec(
        `UPDATE games SET unranked_reason = 'off-map' WHERE status = 'ignored' AND map NOT LIKE 'Supreme Isthmus%'`,
      );
    }
    this.setMeta("unranked_reason_label", "3");
    if (added.has("tier") || this.getMeta("tiers_seeded") !== "1") this.seedTiers();
    // Nothing to rebuild when every derived column was already populated and
    // the counts are seeded. A column this construction ADDED still holds its
    // default for every existing row, so its contents have to be computed.
    const seeded = [...this.sql.exec(`SELECT 1 FROM counts WHERE key = 'players_ranked'`)].length > 0;
    const stale = ["rank", "public_rank", "inactive", "ranked", "rank_change_7d", "los_change_7d"].some(
      (c) => added.has(c),
    );
    if (!stale && seeded) return;
    this.ctx.storage.transactionSync(() => {
      const players = Number([...this.sql.exec(`SELECT COUNT(*) AS n FROM players`)][0].n);
      const games = Number([...this.sql.exec(`SELECT COUNT(*) AS n FROM games`)][0].n);
      const rated = Number([...this.sql.exec(`SELECT COUNT(*) AS n FROM games WHERE status = 'rated'`)][0].n);
      for (const [key, n] of [
        ["players", players],
        ["games", games],
        ["games_rated", rated],
      ] as const) {
        this.sql.exec(`INSERT INTO counts (key, n) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET n = excluded.n`, key, n);
      }
      // Writes players_ranked itself, and derives `inactive`/`ranked` for a
      // store that predates them (every row currently says "active, ranked").
      const changed = this.refreshRanks();
      console.log(
        `LosDO: derived data rebuilt (${players} players, ${games} games, ${changed} rows written, ` +
          `${this.count("players_ranked")} ranked)`,
      );
    });
  }

  /** Give every player the plain tier of their current rating — the starting
   * point hysteresis moves from (a column added after the fact has no history). */
  private seedTiers(): void {
    this.ctx.storage.transactionSync(() => {
      const rows = [...this.sql.exec(`SELECT user_id, mu, sigma, games FROM players`)];
      for (const r of rows) {
        const games = Number(r.games);
        this.sql.exec(
          `UPDATE players SET tier = ? WHERE user_id = ?`,
          tierIndexOf(shownLosOf(Number(r.mu), Number(r.sigma), games), games),
          r.user_id,
        );
      }
      this.setMeta("tiers_seeded", "1");
      console.log(`LosDO: rank tiers seeded for ${rows.length} players`);
    });
  }

  // ---------------------------------------------------------------- meta

  private getMeta(key: string): string | null {
    const rows = [...this.sql.exec(`SELECT value FROM meta WHERE key = ?`, key)];
    return rows.length ? (rows[0].value as string) : null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private lastSeq(): number {
    return Number(this.getMeta("last_seq") ?? 0);
  }

  /** One maintained row count (see the `counts` table) — one row read. */
  private count(key: CountKey): number {
    const rows = [...this.sql.exec(`SELECT n FROM counts WHERE key = ?`, key)];
    return rows.length ? Number(rows[0].n) : 0;
  }

  private bumpCount(key: CountKey, by: number): void {
    if (by === 0) return;
    this.sql.exec(
      `INSERT INTO counts (key, n) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET n = n + excluded.n`,
      key,
      by,
    );
  }

  /** How many players the leaderboard has — the tail (private or lapsed) is the
   * rest. A maintained row count, never a scan. */
  private rankedPlayerCount(): number {
    return this.count("players_ranked");
  }

  /**
   * Re-derive everything the ranking is served from, in ONE ordered walk of
   * idx_players_ranking: whether each player is `inactive` (no rated game in
   * INACTIVE_DAYS), whether they are therefore `ranked`, their true `rank` over
   * everyone, and their `public_rank` among the ranked. Writes only the rows
   * whose derived values actually moved — a game shifts the players below its
   * participants by at most a few places, so most are skipped — and stores the
   * ranked count. Returns how many rows were written.
   *
   * Everything lands here because the walk is the expensive part and it was
   * already being paid: `rank` is what the admin's list shows, `public_rank`
   * (NULL when unranked) is what a visitor's does, so their list runs 1..N with
   * no gap where a hidden or lapsed player sits, and the search can report a
   * row's global position without counting the rows above it.
   *
   * The same walk also feeds `rank_history`: the derived (rank, los) pairs ARE
   * the day's snapshot, so recording one costs no second read, and the two
   * change columns are then measured against the baseline snapshot. See
   * recordDailySnapshot and rankBaseline.
   *
   * `now` is a parameter so a caller inside a transaction fixes one instant for
   * the whole walk.
   */
  private refreshRanks(now = Date.now()): number {
    const cutoff = new Date(now - INACTIVE_MS).toISOString();
    const rows = [
      ...this.sql.exec(
        `SELECT user_id, rank, public_rank, private_profile, inactive, ranked, last_played,
                los, rank_change_7d, los_change_7d
           FROM players ORDER BY los DESC, user_id`,
      ),
    ];
    let changed = 0;
    let nextPublic = 1;
    // The derived leaderboard, in order — what recordDailySnapshot writes.
    const board: RankSnapshotRow[] = rows.map((r, i) => ({
      userId: Number(r.user_id),
      rank: i + 1,
      los: Number(r.los),
    }));
    // Recorded BEFORE the changes are measured, so a day that has just been
    // stamped is already in the table when the baseline is picked — it can only
    // ever be yesterday's, which the window is nowhere near, but the ordering
    // makes that a fact rather than a coincidence.
    this.recordDailySnapshot(now, board);
    const baseline = this.rankBaseline(now);
    rows.forEach((r, i) => {
      // last_played is an ISO instant, so the string compare IS the date compare.
      const inactive = String(r.last_played) < cutoff ? 1 : 0;
      const ranked = Number(r.private_profile) === 0 && inactive === 0 ? 1 : 0;
      const rank = i + 1;
      const publicRank = ranked === 1 ? nextPublic++ : null;
      // No baseline row = nothing to compare against (a player who had not
      // played by then, or a store with no snapshot old enough at all).
      const was = baseline?.get(Number(r.user_id));
      // Positions GAINED: an improvement is a smaller rank, so the subtraction
      // goes this way round and both changes then read positive-is-better.
      const rankChange = was == null ? null : was.rank - rank;
      const losChange = was == null ? null : Number(r.los) - was.los;
      if (
        r.rank === rank &&
        (r.public_rank ?? null) === publicRank &&
        Number(r.inactive) === inactive &&
        Number(r.ranked) === ranked &&
        sameNullableNumber(r.rank_change_7d, rankChange) &&
        sameNullableNumber(r.los_change_7d, losChange)
      ) {
        return;
      }
      this.sql.exec(
        `UPDATE players SET rank = ?, public_rank = ?, inactive = ?, ranked = ?,
                rank_change_7d = ?, los_change_7d = ? WHERE user_id = ?`,
        rank,
        publicRank,
        inactive,
        ranked,
        rankChange,
        losChange,
        r.user_id,
      );
      changed++;
    });
    this.sql.exec(
      `INSERT INTO counts (key, n) VALUES ('players_ranked', ?)
       ON CONFLICT(key) DO UPDATE SET n = excluded.n`,
      nextPublic - 1,
    );
    this.setMeta("activity_swept_at", String(now));
    return changed;
  }

  /**
   * Write one day's leaderboard into `rank_history`, at most once per UTC day.
   *
   * The day it stamps is YESTERDAY: this runs from refreshRanks, i.e. just
   * after a game was rated, so the first call once the clock has passed
   * midnight UTC holds the state the day that just ended finished with. A day
   * on which nothing was uploaded gets no row at all — nothing ran — which is
   * why the baseline lookup takes the newest day AT OR BEFORE its target
   * rather than that exact day.
   *
   * The stamp is therefore only as sharp as the gap between games: if the first
   * game of a day is played at 23:00, that snapshot has a day of play in it
   * that "yesterday" did not. rebuildRankHistory redraws such a day exactly,
   * from the game log.
   */
  private recordDailySnapshot(now: number, board: readonly RankSnapshotRow[]): void {
    if (board.length === 0) return;
    const day = utcDayString(now - DAY_MS); // the day that has just ended
    const last = this.getMeta("rank_history_day");
    if (last != null && last >= day) return;
    for (const row of board) this.writeSnapshotRow(day, row);
    this.setMeta("rank_history_day", day);
    // Bounded here rather than on a timer: this is the one place that adds to
    // the table, and it runs once a day, which is exactly the retention's step.
    const oldest = utcDayString(now - RANK_HISTORY_RETENTION_DAYS * DAY_MS);
    this.sql.exec(`DELETE FROM rank_history WHERE day < ?`, oldest);
    console.log(`LosDO: recorded ${board.length} ranks for ${day} (history kept from ${oldest})`);
  }

  /** One snapshot row. REPLACE so a rebuild can overwrite a day in place. */
  private writeSnapshotRow(day: string, row: RankSnapshotRow): void {
    this.sql.exec(
      `INSERT INTO rank_history (day, user_id, rank, los) VALUES (?,?,?,?)
       ON CONFLICT(day, user_id) DO UPDATE SET rank = excluded.rank, los = excluded.los`,
      day,
      row.userId,
      row.rank,
      row.los,
    );
  }

  /**
   * The snapshot the change columns are measured against: the newest recorded
   * day at or before `today − RANK_HISTORY_DAYS`, and no older than
   * RANK_HISTORY_MAX_AGE_DAYS. Null — meaning no player has a change — when
   * nothing that old exists, which is every store's first week.
   *
   * Two statements: a MAX() seek down the primary key to name the day, then
   * that day's rows as one range over it.
   */
  private rankBaseline(now: number): Map<number, RankSnapshotRow> | null {
    const target = utcDayString(now - RANK_HISTORY_DAYS * DAY_MS);
    const oldest = utcDayString(now - RANK_HISTORY_MAX_AGE_DAYS * DAY_MS);
    const found = [
      ...this.sql.exec(`SELECT MAX(day) AS day FROM rank_history WHERE day <= ? AND day >= ?`, target, oldest),
    ][0];
    if (found?.day == null) return null;
    const day = String(found.day);
    const map = new Map<number, RankSnapshotRow>();
    for (const r of this.sql.exec(`SELECT user_id, rank, los FROM rank_history WHERE day = ?`, day)) {
      const userId = Number(r.user_id);
      map.set(userId, { userId, rank: Number(r.rank), los: Number(r.los) });
    }
    return map;
  }

  /**
   * Re-derive activity if nothing has for a while. A player lapses because
   * nothing happened — no upload, no toggle, nothing to hook on — so the only
   * thing that can notice is a read. Guarded by a stored timestamp, so this
   * costs one row read on all but one call in ACTIVITY_SWEEP_MS.
   */
  private sweepActivityIfDue(): void {
    const last = Number(this.getMeta("activity_swept_at") ?? 0);
    const now = Date.now();
    if (now - last < ACTIVITY_SWEEP_MS) return;
    const changed = this.ctx.storage.transactionSync(() => this.refreshRanks(now));
    if (changed > 0) console.log(`LosDO: activity sweep rewrote ${changed} player rows`);
  }

  // -------------------------------------------------------------- upload

  /**
   * Ingest a batch of verbatim replays. The batch is sorted by
   * (startTime, id) first, so only order ACROSS uploads matters; the whole
   * batch commits atomically.
   */
  async upload(replays: ReplayDetail[]): Promise<UploadResult> {
    return this.ctx.storage.transactionSync(() => this.uploadSync(replays));
  }

  /**
   * Re-run the rating fold from one stored game onward — the recovery for a
   * game that arrived behind the fold head (status "ignored", reason
   * "uploaded too late"): every stored game from that game's fold position
   * (start_time, id) onward is re-folded in chronological order, so the late
   * arrival takes its rightful place and everything after it re-rates on top
   * of it. Runs entirely from stored rows — games + game_players keep the
   * full roster of rated AND ignored games, and each affected player's state
   * just before the rebase point is reconstructed from their last rated game
   * before it (the per-game mu/sigma transitions are exactly that history).
   * Off-map games stay ignored unless `includeOffMap` opts them in — judged
   * by the stored map itself, so a wrong reason label is repaired and a
   * default re-run resets a wrongly-rated off-map game to unranked. A game an
   * admin marked ignored (`excluded`) is skipped whatever its map: this fold
   * is where that marking takes effect.
   * One transaction; a discriminated result rather than a throw, like every
   * RPC here.
   */
  async rebase(gameId: string, includeOffMap = false): Promise<RebaseResult> {
    return this.ctx.storage.transactionSync(() => this.rebaseSync(gameId, includeOffMap));
  }

  private rebaseSync(id: string, includeOffMap: boolean): RebaseResult {
    const target = [...this.sql.exec(`SELECT start_time FROM games WHERE id = ?`, id)];
    if (!target.length) return { ok: false, error: "no such stored game" };
    const fromTime = String(target[0].start_time);

    // Every stored game at/after the rebase point, in fold order.
    const gameRows = [
      ...this.sql.exec(
        `SELECT id, start_time, duration_ms, map, engine_version, game_version,
                winner_team, unranked_reason, excluded, start_metal_storage
           FROM games
          WHERE (start_time, id) >= (?, ?)
          ORDER BY start_time, id`,
        fromTime,
        id,
      ),
    ];
    // The start-metal rule judges by the stored value, and a row stored before
    // the column has none: folding now would drop every such game as if it
    // had been played on the wrong storage. Refuse until a re-upload filled
    // them (excluded and off-map rows are left out whatever their value).
    const unknownStorage = gameRows.filter(
      (r) =>
        String(r.start_time) >= START_METAL_RULE_FROM &&
        r.start_metal_storage == null &&
        Number(r.excluded) !== 1 &&
        isRatedMapName(String(r.map)),
    ).length;
    if (unknownStorage > 0) {
      return {
        ok: false,
        error:
          `${unknownStorage} stored game(s) since ${START_METAL_RULE_FROM.slice(0, 10)} have no recorded ` +
          `start metal storage; re-upload them first (pnpm run lavaos:backfill-start-metal)`,
      };
    }
    const ids = gameRows.map((r) => String(r.id));
    const rosters = this.rostersFor(ids);

    // Reconstruct each affected player's state as of just BEFORE the rebase
    // point, from their last rated game before it. A player with no rated
    // history before the point loses their row here — the walk below
    // recreates it if they rate again, and a player left with only ignored
    // games must not keep ratings those games no longer justify.
    const userIds = new Set<number>();
    for (const roster of rosters.values()) for (const p of roster) userIds.add(p.userId);
    // `private_profile` is an admin setting, not fold state, and the walk below
    // drops and recreates `players` rows — so remember who was hidden and put
    // the flag back once the fold has finished rewriting them.
    const wasPrivate = [
      ...this.sql.exec(`SELECT user_id FROM players WHERE private_profile = 1`),
    ].map((r) => Number(r.user_id));
    const stateCache = new Map<number, PlayerState>();
    for (const userId of userIds) {
      const agg = [
        ...this.sql.exec(
          `SELECT COUNT(*) AS n, SUM(won) AS w, MIN(start_time) AS first
             FROM game_players
            WHERE user_id = ? AND game_number IS NOT NULL AND (start_time, game_id) < (?, ?)`,
          userId,
          fromTime,
          id,
        ),
      ][0];
      if (Number(agg.n) === 0) {
        this.sql.exec(`DELETE FROM players WHERE user_id = ?`, userId);
        continue;
      }
      const last = [
        ...this.sql.exec(
          `SELECT name, mu_after, sigma_after, start_time
             FROM game_players
            WHERE user_id = ? AND game_number IS NOT NULL AND (start_time, game_id) < (?, ?)
            ORDER BY start_time DESC, game_id DESC LIMIT 1`,
          userId,
          fromTime,
          id,
        ),
      ][0];
      const skillRow = [
        ...this.sql.exec(
          `SELECT bar_skill
             FROM game_players
            WHERE user_id = ? AND game_number IS NOT NULL AND bar_skill IS NOT NULL
              AND (start_time, game_id) < (?, ?)
            ORDER BY start_time DESC, game_id DESC LIMIT 1`,
          userId,
          fromTime,
          id,
        ),
      ];
      const state: PlayerState = {
        userId,
        name: String(last.name),
        mu: Number(last.mu_after),
        sigma: Number(last.sigma_after),
        games: Number(agg.n),
        wins: Number(agg.w ?? 0),
        firstPlayed: String(agg.first),
        lastPlayed: String(last.start_time),
        barOs: skillRow.length ? Number(skillRow[0].bar_skill) : null,
      };
      stateCache.set(userId, state);
      // Written now so a player who ends up in no rated game after the point
      // (everything ahead is off-map) still reverts to this state.
      this.upsertPlayer(state);
    }

    // Clear what the walk rewrites: the affected transitions, and the seqs
    // (freed first — seq is UNIQUE and the walk reassigns them).
    for (let i = 0; i < ids.length; i += SQL_MAX_BIND_PARAMS) {
      const chunk = ids.slice(i, i + SQL_MAX_BIND_PARAMS);
      const ph = chunk.map(() => "?").join(",");
      this.sql.exec(
        `UPDATE game_players SET game_number = NULL, mu_before = NULL, sigma_before = NULL,
                mu_after = NULL, sigma_after = NULL WHERE game_id IN (${ph})`,
        ...chunk,
      );
      this.sql.exec(`UPDATE games SET seq = NULL WHERE id IN (${ph})`, ...chunk);
    }

    // The fold base: the last rated game strictly before the point.
    const prior = [
      ...this.sql.exec(
        `SELECT seq, start_time, id FROM games
          WHERE status = 'rated' AND (start_time, id) < (?, ?)
          ORDER BY start_time DESC, id DESC LIMIT 1`,
        fromTime,
        id,
      ),
    ];
    let seq = prior.length ? Number(prior[0].seq) : 0;
    let headTime = prior.length ? String(prior[0].start_time) : "";
    let headId = prior.length ? String(prior[0].id) : "";

    let rated = 0;
    let ignoredN = 0;
    const uploadedAt = new Date().toISOString();
    for (const r of gameRows) {
      const gid = String(r.id);
      const roster = rosters.get(gid) ?? [];
      // A game an admin marked ignored (setGameExcluded) is skipped whatever
      // its map, and whether or not this run opted into off-map games: the
      // flag exists to be honoured HERE — marking a game is what schedules its
      // ratings to be dropped, and this fold is what drops them. Unmarking it
      // and re-running puts the game back.
      if (Number(r.excluded) === 1) {
        this.sql.exec(`UPDATE games SET status = 'ignored', unranked_reason = 'excluded' WHERE id = ?`, gid);
        ignoredN++;
        continue;
      }
      // Judged by the stored MAP, never by the reason label — a label can be
      // wrong (a backfill once mislabelled off-map rows, which is how a
      // Crescent Bay game got itself rated), the map cannot. Unless the
      // caller opted into rating other maps, an off-map game is (re)set to
      // ignored here whatever it was before — which is also how re-running
      // the rebase undoes a wrongly-rated off-map game: its transitions and
      // seq were already cleared above, so nothing of its rating survives.
      if (!includeOffMap && !isRatedMapName(String(r.map))) {
        this.sql.exec(`UPDATE games SET status = 'ignored', unranked_reason = 'off-map' WHERE id = ?`, gid);
        ignoredN++;
        continue;
      }
      // The start-metal rule, from the stored value. Not lifted by
      // includeOffMap: that opts other MAPS in, nothing else.
      const storage = r.start_metal_storage == null ? null : Number(r.start_metal_storage);
      if (startMetalReason(String(r.start_time), storage)) {
        this.sql.exec(
          `UPDATE games SET status = 'ignored', unranked_reason = 'start metal storage' WHERE id = ?`,
          gid,
        );
        ignoredN++;
        continue;
      }
      const game: GameInput = {
        id: gid,
        startTime: String(r.start_time),
        durationMs: Number(r.duration_ms),
        map: String(r.map),
        engineVersion: r.engine_version == null ? null : String(r.engine_version),
        gameVersion: r.game_version == null ? null : String(r.game_version),
        winnerTeam: Number(r.winner_team),
        startMetalStorage: storage,
        // Not re-inserted by the rebase (only rated/updated in place), so the
        // stored lobby column is untouched and need not be read here.
        lobby: null,
        players: roster.map((p) => ({
          userId: p.userId,
          name: p.name,
          faction: p.faction,
          barSkill: p.barSkill,
          barRank: p.barRank,
          team: p.team,
          won: p.won,
        })),
      };
      seq++;
      const { transitions, states } = applyRatedGame(game, (userId) => stateCache.get(userId));
      this.sql.exec(
        `UPDATE games SET seq = ?, status = 'rated', unranked_reason = NULL, uploaded_at = ? WHERE id = ?`,
        seq,
        uploadedAt,
        gid,
      );
      for (const t of transitions) {
        this.sql.exec(
          `UPDATE game_players SET game_number = ?, mu_before = ?, sigma_before = ?,
                  mu_after = ?, sigma_after = ? WHERE game_id = ? AND user_id = ?`,
          t.gameNumber,
          t.muBefore,
          t.sigmaBefore,
          t.muAfter,
          t.sigmaAfter,
          gid,
          t.userId,
        );
      }
      for (const st of states) {
        stateCache.set(st.userId, st);
        this.upsertPlayer(st);
      }
      headTime = game.startTime;
      headId = gid;
      rated++;
    }

    this.setMeta("last_seq", String(seq));
    this.setMeta("head_start_time", headTime);
    this.setMeta("head_id", headId);
    // A rebase from the first game IS the refold an algorithm change needs, so
    // the store now carries the version of the rule that produced its ratings.
    this.setMeta("algo_version", ALGO_VERSION);
    this.restorePrivate(wasPrivate);
    // The rebase deleted and recreated player rows; whatever the cache held for
    // them is no longer something this instance may assume.
    this.forgetPrivateIds();
    // Recount rather than delta: a one-off admin action, and correct by
    // construction. games itself did not change (no row added or removed).
    const ratedTotal = Number([...this.sql.exec(`SELECT COUNT(*) AS n FROM games WHERE status = 'rated'`)][0].n);
    const playersTotal = Number([...this.sql.exec(`SELECT COUNT(*) AS n FROM players`)][0].n);
    this.sql.exec(`INSERT INTO counts (key, n) VALUES ('games_rated', ?) ON CONFLICT(key) DO UPDATE SET n = excluded.n`, ratedTotal);
    this.sql.exec(`INSERT INTO counts (key, n) VALUES ('players', ?) ON CONFLICT(key) DO UPDATE SET n = excluded.n`, playersTotal);
    // players_ranked, `inactive` and both ranks all come out of this walk.
    const ranks = this.refreshRanks();
    console.log(
      `LosDO: rebase from ${id} → ${rated} rated, ${ignoredN} ignored over ${ids.length} games, ` +
        `${userIds.size} players rebuilt, ${ranks} ranks rewritten (seq ${seq})`,
    );
    return { ok: true, from: id, games: ids.length, rated, ignored: ignoredN, players: userIds.size, lastSeq: seq };
  }

  private uploadSync(replays: ReplayDetail[]): UploadResult {
    const out: UploadResult = {
      rated: [],
      ignored: [],
      skipped: [],
      duplicate: [],
      rejected: [],
      lastSeq: 0,
      players: 0,
    };
    const batch = [...replays].sort(
      (a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id),
    );
    let seq = this.lastSeq();
    let headTime = this.getMeta("head_start_time") ?? "";
    let headId = this.getMeta("head_id") ?? "";
    // Write-through cache of fold state, so consecutive games in one batch
    // see each other's updates without re-reading rows just written.
    const stateCache = new Map<number, PlayerState>();
    const uploadedAt = new Date().toISOString();
    // Players this batch creates (a state lookup that found no row), for `counts`.
    const newPlayers = new Set<number>();
    let gamesStored = 0;

    for (const replay of batch) {
      if (this.gameExists(replay.id)) {
        this.backfillGameFacts(replay);
        out.duplicate.push(replay.id);
        continue;
      }
      const verdict = classifyReplay(replay);
      if (verdict.kind === "rejected") {
        out.rejected.push(replay.id);
        continue;
      }
      if (verdict.kind === "skipped") {
        out.skipped.push({ id: replay.id, reason: verdict.reason });
        continue;
      }
      const game = verdict.game;
      const late =
        headTime !== "" &&
        (game.startTime < headTime || (game.startTime === headTime && game.id <= headId));
      // Two ways to be stored unranked: behind the fold head, or off the
      // rated map. Neither touches the fold, the head, or the players table.
      if (!verdict.rateable || late) {
        // Off-map wins the label when both hold: it is the permanent fact
        // about the game, where fold order is an accident of upload timing.
        const why: UnrankedReason = verdict.unranked ?? "uploaded too late";
        this.insertGame(game, null, "ignored", uploadedAt, why);
        gamesStored++;
        for (const p of game.players) this.insertGamePlayer(game, p, null);
        out.ignored.push({
          id: game.id,
          startTime: game.startTime,
          headAt: headTime,
          ...(verdict.unranked ? { reason: verdict.unranked } : {}),
        });
        continue;
      }

      seq++;
      const { transitions, states } = applyRatedGame(game, (userId) => {
        const cached = stateCache.get(userId);
        if (cached) return cached;
        const stored = this.selectPlayer(userId);
        if (!stored) newPlayers.add(userId);
        return stored;
      });
      this.insertGame(game, seq, "rated", uploadedAt);
      gamesStored++;
      const byUser = new Map(transitions.map((t) => [t.userId, t]));
      for (const p of game.players) this.insertGamePlayer(game, p, byUser.get(p.userId)!);
      for (const s of states) {
        stateCache.set(s.userId, s);
        this.upsertPlayer(s);
      }
      headTime = game.startTime;
      headId = game.id;
      out.rated.push(game.id);
    }

    this.bumpCount("games", gamesStored);
    this.bumpCount("games_rated", out.rated.length);
    this.bumpCount("players", newPlayers.size);
    let ranksWritten = 0;
    if (out.rated.length > 0) {
      this.setMeta("last_seq", String(seq));
      this.setMeta("head_start_time", headTime);
      this.setMeta("head_id", headId);
      // The fold moved, so the leaderboard did: refresh the materialized ranks
      // once per upload, not per read.
      ranksWritten = this.refreshRanks();
    }
    this.setMeta("last_upload_at", uploadedAt);
    out.lastSeq = seq;
    out.players = this.count("players");
    console.log(
      `LosDO: upload of ${replays.length} → ${out.rated.length} rated, ` +
        `${out.ignored.length} ignored, ${out.skipped.length} skipped, ` +
        `${out.duplicate.length} duplicate, ${out.rejected.length} rejected ` +
        `(seq ${seq}, ${newPlayers.size} new players, ${ranksWritten} ranks rewritten)`,
    );
    return out;
  }

  private gameExists(id: string): boolean {
    return [...this.sql.exec(`SELECT 1 FROM games WHERE id = ?`, id)].length > 0;
  }

  private insertGame(
    game: GameInput,
    seq: number | null,
    status: "rated" | "ignored",
    uploadedAt: string,
    unrankedReason: UnrankedReason | null = null,
  ): void {
    this.sql.exec(
      `INSERT INTO games
         (id, seq, start_time, duration_ms, map, engine_version, game_version,
          winner_team, status, uploaded_at, unranked_reason, lobby, start_metal_storage)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      game.id,
      seq,
      game.startTime,
      game.durationMs,
      game.map,
      game.engineVersion,
      game.gameVersion,
      game.winnerTeam,
      status,
      uploadedAt,
      unrankedReason,
      game.lobby == null ? null : JSON.stringify(game.lobby),
      game.startMetalStorage,
    );
  }

  /**
   * A duplicate upload can still teach the stored game what it lacks: its
   * lobby info (the first submission may have run before barreplay's lobby
   * match landed, and the sync's watermark re-offers carry it) and its start
   * metal storage (rows stored before the column; re-uploading them is the
   * backfill the start-metal rebase needs). Fills only NULL columns — what an
   * earlier upload knew is never overwritten.
   */
  private backfillGameFacts(replay: ReplayDetail): void {
    const lobby = extractLobby(replay);
    if (lobby != null) {
      this.sql.exec(
        `UPDATE games SET lobby = ? WHERE id = ? AND lobby IS NULL`,
        JSON.stringify(lobby),
        replay.id,
      );
    }
    const storage = startMetalStorage(replay);
    if (storage != null) {
      this.sql.exec(
        `UPDATE games SET start_metal_storage = ? WHERE id = ? AND start_metal_storage IS NULL`,
        storage,
        replay.id,
      );
    }
  }

  private insertGamePlayer(
    game: GameInput,
    p: GameInput["players"][number],
    t: { gameNumber: number; muBefore: number; sigmaBefore: number; muAfter: number; sigmaAfter: number } | null,
  ): void {
    this.sql.exec(
      `INSERT INTO game_players
         (game_id, user_id, team, won, name, faction, bar_skill, bar_rank,
          start_time, game_number, mu_before, sigma_before, mu_after, sigma_after)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      game.id,
      p.userId,
      p.team,
      p.won ? 1 : 0,
      p.name,
      p.faction,
      p.barSkill,
      p.barRank,
      game.startTime,
      t?.gameNumber ?? null,
      t?.muBefore ?? null,
      t?.sigmaBefore ?? null,
      t?.muAfter ?? null,
      t?.sigmaAfter ?? null,
    );
  }

  private selectPlayer(userId: number): PlayerState | undefined {
    const rows = [...this.sql.exec(`SELECT * FROM players WHERE user_id = ?`, userId)];
    if (!rows.length) return undefined;
    const r = rows[0];
    return {
      userId: Number(r.user_id),
      name: String(r.name),
      mu: Number(r.mu),
      sigma: Number(r.sigma),
      games: Number(r.games),
      wins: Number(r.wins),
      firstPlayed: String(r.first_played),
      lastPlayed: String(r.last_played),
      barOs: r.bar_os == null ? null : Number(r.bar_os),
    };
  }

  private upsertPlayer(s: PlayerState): void {
    // Tier hysteresis in the statement itself (no extra read): a new row takes
    // the plain tier; an existing one goes up to the plain tier, or down only
    // as far as the tier LOS + DEMOTE_MARGIN still reaches (nextTierIndex).
    const shown = shownLosOf(s.mu, s.sigma, s.games);
    const plain = tierIndexOf(shown, s.games);
    const floor = plain === 0 ? 0 : tierIndexOf(shown + DEMOTE_MARGIN, s.games);
    this.sql.exec(
      `INSERT INTO players
         (user_id, name, mu, sigma, los, games, wins, first_played, last_played, bar_os, tier)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
       ON CONFLICT(user_id) DO UPDATE SET
         name = excluded.name, mu = excluded.mu, sigma = excluded.sigma,
         los = excluded.los, games = excluded.games, wins = excluded.wins,
         last_played = excluded.last_played, bar_os = excluded.bar_os,
         tier = CASE WHEN players.tier IS NULL THEN ?11 ELSE MAX(?11, MIN(players.tier, ?12)) END`,
      s.userId,
      s.name,
      s.mu,
      s.sigma,
      losOf(s.mu, s.sigma),
      s.games,
      s.wins,
      s.firstPlayed,
      s.lastPlayed,
      s.barOs,
      plain,
      floor,
    );
  }

  // --------------------------------------------------- ignoring a game

  /**
   * Mark one stored game ignored, or unmark it — the games page's row menu.
   *
   * This writes ONE flag and recomputes nothing: no rating is re-folded, no
   * count moves, `status`, `seq` and every stored mu/sigma stay exactly as
   * they are. That is the point of it. Dropping a rated game's contribution
   * means re-running the fold over every game after it, which is what
   * `rebase` is for and what the row's other action does; the two are
   * deliberately separate, so an admin can mark a batch of games and re-run
   * once from the earliest of them.
   *
   * Until that re-run the marker is a statement of intent, which `needsRebase`
   * reports and the page badges: a marked game that is still rated keeps its
   * ratings, and a game left unrated BY a marker stays unrated until a fold
   * puts it back.
   *
   * Null when no such stored game (the route answers 404).
   */
  async setGameExcluded(id: string, excluded: boolean): Promise<ExcludeResult | null> {
    return this.ctx.storage.transactionSync(() => {
      const rows = [
        ...this.sql.exec(`SELECT status, unranked_reason, excluded FROM games WHERE id = ?`, id),
      ];
      if (!rows.length) return null;
      const ignored = String(rows[0].status) !== "rated";
      const was = Number(rows[0].excluded) === 1;
      // Does a fold still owe this game anything? Marked: only while it is
      // still rated. Unmarked: only while it is unrated FOR THE MARKER — a
      // game the fold left out for its own reasons (off-map, uploaded too
      // late) is not waiting on this call, and must not be reported as if
      // clearing the marker would rate it.
      const needsRebase = excluded
        ? !ignored
        : ignored && String(rows[0].unranked_reason) === "excluded";
      if (was === excluded) return { id, excluded, changed: false, ignored, needsRebase };
      this.sql.exec(`UPDATE games SET excluded = ? WHERE id = ?`, excluded ? 1 : 0, id);
      console.log(
        `LosDO: game ${id} is now ${excluded ? "IGNORED" : "not ignored"} ` +
          `(fold status ${ignored ? "unrated" : "rated"}${needsRebase ? ", re-run pending" : ""})`,
      );
      return { id, excluded, changed: true, ignored, needsRebase };
    });
  }

  // ------------------------------------------------------------- privacy

  /** Re-mark the profiles a rebase's drop-and-recreate of `players` un-hid.
   * A user_id the rebase left without a row is simply not matched. */
  private restorePrivate(userIds: number[]): void {
    for (let i = 0; i < userIds.length; i += SQL_MAX_BIND_PARAMS) {
      const chunk = userIds.slice(i, i + SQL_MAX_BIND_PARAMS);
      this.sql.exec(
        `UPDATE players SET private_profile = 1 WHERE user_id IN (${chunk.map(() => "?").join(",")})`,
        ...chunk,
      );
    }
  }

  /**
   * Hide (or unhide) one player's profile on the public site. Purely a READ
   * filter: the fold still rates them, their rows in every game's roster stay,
   * and the bot still balances on their real rating — they are simply off the
   * ranking and their player page serves no rating to a non-admin.
   *
   * Ranks shift (they count public players only), so the leaderboard's
   * materialized `rank` is refreshed in the same transaction as the flag and
   * the maintained private count.
   *
   * Returns null when no such player exists; a no-op toggle costs one read.
   */
  async setPrivateProfile(userId: number, isPrivate: boolean): Promise<PrivacyResult | null> {
    return this.ctx.storage.transactionSync(() => {
      const rows = [
        ...this.sql.exec(`SELECT name, private_profile FROM players WHERE user_id = ?`, userId),
      ];
      if (!rows.length) return null;
      const name = String(rows[0].name);
      const was = Number(rows[0].private_profile) === 1;
      if (was === isPrivate) return { userId, name, privateProfile: isPrivate, changed: false };
      this.sql.exec(`UPDATE players SET private_profile = ? WHERE user_id = ?`, isPrivate ? 1 : 0, userId);
      this.forgetPrivateIds();
      // Rewrites `ranked` for this row and every position below it, and the
      // maintained ranked count with them.
      const ranks = this.refreshRanks();
      console.log(
        `LosDO: player ${userId} (${name}) profile is now ${isPrivate ? "PRIVATE" : "public"} ` +
          `(${ranks} ranks rewritten)`,
      );
      return { userId, name, privateProfile: isPrivate, changed: true };
    });
  }

  // -------------------------------------------------------- rank history

  /**
   * Redraw the last RANK_HISTORY_REBUILD_DAYS days of `rank_history` from the
   * game log — the ranking page's admin button, and the repair for every way
   * the daily recorder can be approximate: a day nobody uploaded on, a day
   * whose first game came late (see recordDailySnapshot), a store that only
   * grew the table today.
   *
   * It REWINDS rather than re-folds. `players` already holds the present state
   * exactly, and `game_players` holds every rated game's mu/sigma BEFORE it, so
   * the board at any past instant is the board now with every game since then
   * undone — no rating is recomputed and the OpenSkill fold is never re-run,
   * which also means this cannot disagree with it. Walking the games
   * newest-first and overwriting per player leaves each one at the state before
   * their EARLIEST game after the cut, which is what that instant's board is.
   *
   * Days older than the rebuilt window are left alone, and so is the fold: this
   * writes `rank_history` and then re-derives the two change columns from it.
   */
  async rebuildRankHistory(): Promise<RankHistoryRebuildResult> {
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => this.rebuildRankHistorySync(now));
    console.log(
      `LosDO: rank history rebuilt for ${result.days.length} days ` +
        `(${result.days[0]}..${result.days[result.days.length - 1]}), ` +
        `${result.rows} rows from ${result.games} games rewound`,
    );
    return result;
  }

  private rebuildRankHistorySync(now: number): RankHistoryRebuildResult {
    // The days that have ENDED, oldest first — the order they are returned in;
    // the rewind below walks them backwards, from yesterday.
    const days: string[] = [];
    for (let d = RANK_HISTORY_REBUILD_DAYS; d >= 1; d--) days.push(utcDayString(now - d * DAY_MS));
    const oldest = days[0];
    // Everything from the oldest rebuilt day on goes — including any row for
    // TODAY, which nothing writes but a clock that went backwards could have.
    this.sql.exec(`DELETE FROM rank_history WHERE day >= ?`, oldest);

    // The state to rewind FROM. `players` is one row per player with a rated
    // game, and its `los` is that of their last one, so the present needs no
    // reconstruction at all.
    const state = new Map<number, number>();
    for (const r of this.sql.exec(`SELECT user_id, los FROM players`)) {
      state.set(Number(r.user_id), Number(r.los));
    }

    // Every rated game after the oldest day ENDED (that day's own games stay
    // folded in — its snapshot is the state it finished with). Read from
    // `games` through idx_games_status_time_id and then one primary-key range
    // per game, rather than as a join whose ORDER BY names the other table: the
    // window is a week or two of lava, so this is a couple of hundred seeks.
    const sinceCut = [
      ...this.sql.exec(
        `SELECT id, start_time FROM games
          WHERE status = 'rated' AND start_time >= ?
          ORDER BY start_time DESC, id DESC`,
        dayEndInstant(oldest),
      ),
    ];

    let cursor = 0;
    let rows = 0;
    let players = 0;
    for (let i = days.length - 1; i >= 0; i--) {
      const day = days[i];
      const until = dayEndInstant(day); // the instant this day's board is taken at
      while (cursor < sinceCut.length && String(sinceCut[cursor].start_time) >= until) {
        for (const pl of this.sql.exec(
          `SELECT user_id, game_number, mu_before, sigma_before FROM game_players WHERE game_id = ?`,
          sinceCut[cursor].id,
        )) {
          if (pl.mu_before == null || pl.sigma_before == null) continue; // never on a rated row
          const userId = Number(pl.user_id);
          // Undoing somebody's FIRST rated game undoes their existence: before
          // it they were not on the board at all, and a debutant's prior is not
          // a rating anyone held.
          if (Number(pl.game_number) <= 1) state.delete(userId);
          else state.set(userId, losOf(Number(pl.mu_before), Number(pl.sigma_before)));
        }
        cursor++;
      }
      const board = [...state]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .map(([userId, los], idx): RankSnapshotRow => ({ userId, rank: idx + 1, los }));
      for (const row of board) this.writeSnapshotRow(day, row);
      rows += board.length;
      if (i === days.length - 1) players = board.length;
    }

    // The recorder must not immediately overwrite the newest day it just drew.
    this.setMeta("rank_history_day", days[days.length - 1]);
    // The baseline moved, so the two change columns are stale by construction.
    this.refreshRanks(now);
    return { days, rows, games: cursor, players };
  }

  // --------------------------------------------------------------- reset

  /** Wipe everything for a chronological re-upload (e.g. an algorithm change). */
  async reset(): Promise<{ ok: true }> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`
        DROP TABLE IF EXISTS game_players;
        DROP TABLE IF EXISTS games;
        DROP TABLE IF EXISTS players;
        DROP TABLE IF EXISTS meta;
        DROP TABLE IF EXISTS counts;
        DROP TABLE IF EXISTS rank_history;
        DROP TABLE IF EXISTS lobby_states;
      `);
      // NOT the `avoids` table: this reset exists to rebuild the rating fold
      // from the uploads, and an avoid list is the one thing in here that no
      // upload can put back — people typed it. Wiping it is its own act
      // (clearAvoids, POST /api/avoids/reset).
      this.ensureSchema();
    });
    this.forgetPrivateIds();
    console.log("LosDO: reset — all tables dropped and recreated");
    return { ok: true };
  }

  // --------------------------------------------------------------- lobby states

  /**
   * Store the bot's game-start roster (POST /api/gamestart). Validates the raw
   * body here so a garbage upload never reaches the table; an upload for a
   * battle that already has one overwrites it (a new game in the same lobby).
   */
  async putGameStart(input: unknown): Promise<{ ok: true; battleId: number }> {
    const snap = parseGameStartSnapshot(input);
    this.sql.exec(
      `INSERT INTO lobby_states (battle_id, started_at, snapshot) VALUES (?,?,?)
       ON CONFLICT(battle_id) DO UPDATE SET
         started_at = excluded.started_at, snapshot = excluded.snapshot`,
      snap.battleId,
      snap.startedAt,
      JSON.stringify(snap),
    );
    console.log(
      `LosDO: game-start roster stored for battle ${snap.battleId} ` +
        `(${snap.players.length} players, botBalanced=${snap.botBalanced})`,
    );
    return { ok: true, battleId: snap.battleId };
  }

  /** Drop a battle's game-start roster (POST /api/gameend). Idempotent. */
  async clearGameStart(battleId: number): Promise<{ ok: true }> {
    this.sql.exec(`DELETE FROM lobby_states WHERE battle_id = ?`, battleId);
    return { ok: true };
  }

  /**
   * The stored game-start roster for a battle, or null. A row past the TTL is
   * reaped on read (games rarely exceed ~2h; a leftover row means the bot's
   * game-end never arrived) — only bot-visited battles ever get rows, so the
   * lazy sweep is enough. Whether the snapshot should be SHOWN (fresh vs the
   * live lobby's inProgress) is the route's call — see snapshotFresh.
   */
  async getGameStart(battleId: number, now = Date.now()): Promise<GameStartSnapshot | null> {
    const rows = [
      ...this.sql.exec(
        `SELECT started_at, snapshot FROM lobby_states WHERE battle_id = ?`,
        battleId,
      ),
    ];
    if (!rows.length) return null;
    if (now - Number(rows[0].started_at) >= GAME_START_TTL_MS) {
      this.sql.exec(`DELETE FROM lobby_states WHERE battle_id = ?`, battleId);
      return null;
    }
    try {
      return parseGameStartSnapshot(JSON.parse(String(rows[0].snapshot)));
    } catch (e) {
      // A row this DO cannot parse (a shape from a future/older build) is dead
      // weight: drop it rather than fail the lobby view forever.
      console.warn(
        `LosDO: dropping unreadable game-start row for battle ${battleId}: ` +
          (e instanceof Error ? e.message : String(e)),
      );
      this.sql.exec(`DELETE FROM lobby_states WHERE battle_id = ?`, battleId);
      return null;
    }
  }

  // ---------------------------------------------------------- avoid lists

  /**
   * One player's avoid list, oldest entry first (the order it was built in).
   * Serves GET /api/avoids and the bot's `.avoid` listing.
   */
  async listAvoids(player: string): Promise<{ owner: string; entries: AvoidEntry[]; limit: number }> {
    const rows = [
      ...this.sql.exec(
        `SELECT owner_name, avoid_name, avoid_user_id, created_at FROM avoids
          WHERE owner_key = ? ORDER BY created_at, avoid_key`,
        avoidKey(player),
      ),
    ];
    return {
      owner: rows.length ? String(rows[0].owner_name) : avoidName(player),
      entries: rows.map(avoidRow),
      limit: MAX_AVOIDS_PER_PLAYER,
    };
  }

  /**
   * Add `target` to `player`'s avoid list. The target must be someone the
   * ranking knows (a `players` row = at least one rated lava game) — a typo'd
   * or made-up name would silently constrain nothing, so it is refused with
   * near-miss suggestions instead. The requester is NOT checked: a debutant
   * has every right to a list.
   *
   * Refusals are values, not throws: `self`, `duplicate`, `limit`
   * (MAX_AVOIDS_PER_PLAYER) and `unknown-player`, each carrying what the bot
   * needs to word its reply.
   */
  async addAvoid(player: string, target: string): Promise<AddAvoidResult> {
    const ownerKey = avoidKey(player);
    const targetKey = avoidKey(target);
    if (ownerKey === targetKey) return { ok: false, reason: "self" };

    const existing = [
      ...this.sql.exec(
        `SELECT owner_name, avoid_name, avoid_user_id, created_at FROM avoids
          WHERE owner_key = ? AND avoid_key = ?`,
        ownerKey,
        targetKey,
      ),
    ];
    if (existing.length) return { ok: false, reason: "duplicate", entry: avoidRow(existing[0]) };

    // The ranking's own spelling of the name, and the row it belongs to. Two
    // accounts can share a name up to case; the one with more rated games (the
    // more recently seen of a tie) is the one people mean — same rule as
    // playersByNames.
    const found = [
      ...this.sql.exec(
        `SELECT user_id, name FROM players WHERE name COLLATE NOCASE = ?
          ORDER BY games DESC, last_played DESC LIMIT 1`,
        avoidName(target),
      ),
    ];
    if (!found.length) {
      const suggestions = [
        ...this.sql.exec(
          `SELECT name FROM players WHERE name LIKE ? ESCAPE '\\' COLLATE NOCASE
            ORDER BY games DESC, los DESC LIMIT ?`,
          `%${likeEscape(avoidName(target))}%`,
          AVOID_SUGGESTIONS,
        ),
      ].map((r) => String(r.name));
      return { ok: false, reason: "unknown-player", suggestions };
    }

    const count = Number(
      [...this.sql.exec(`SELECT COUNT(*) AS n FROM avoids WHERE owner_key = ?`, ownerKey)][0].n,
    );
    if (count >= MAX_AVOIDS_PER_PLAYER) {
      return { ok: false, reason: "limit", limit: MAX_AVOIDS_PER_PLAYER, count };
    }

    const entry: AvoidEntry = {
      owner: avoidName(player),
      avoid: String(found[0].name),
      avoidUserId: Number(found[0].user_id),
      createdAt: new Date().toISOString(),
    };
    this.sql.exec(
      `INSERT INTO avoids (owner_key, avoid_key, owner_name, avoid_name, avoid_user_id, created_at)
       VALUES (?,?,?,?,?,?)`,
      ownerKey,
      avoidKey(entry.avoid),
      entry.owner,
      entry.avoid,
      entry.avoidUserId,
      entry.createdAt,
    );
    console.log(`LosDO: avoid added — ${entry.owner} avoids ${entry.avoid} (${count + 1} on the list)`);
    return { ok: true, entry, count: count + 1 };
  }

  /**
   * Drop EVERY list (POST /api/avoids/reset). Deliberately not part of
   * `reset()` — see the note there — so wiping what people typed is a separate,
   * explicit act.
   */
  // ------------------------------------------------------------ website login

  /**
   * Store a one-time login link for `user` (src/auth.ts). Any earlier link of
   * the same account is dropped, so only the latest whisper works, and expired
   * links of everybody are swept while we are here.
   */
  async createLoginLink(tokenHash: string, user: AuthUser, expiresAt: number, now = Date.now()): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM auth_links WHERE expires_at <= ? OR user_id = ?`, now, user.userId);
      this.sql.exec(
        `INSERT INTO auth_links (token_hash, user_id, name, expires_at) VALUES (?, ?, ?, ?)`,
        tokenHash,
        user.userId,
        user.name,
        expiresAt,
      );
    });
  }

  /** Who a login link is for, without using it up (the "Continue as" page). */
  async peekLoginLink(tokenHash: string, now = Date.now()): Promise<AuthUser | null> {
    const rows = [
      ...this.sql.exec(
        `SELECT user_id, name FROM auth_links WHERE token_hash = ? AND expires_at > ?`,
        tokenHash,
        now,
      ),
    ];
    return rows.length ? { userId: Number(rows[0].user_id), name: String(rows[0].name) } : null;
  }

  /**
   * Trade a login link for a session: the link is deleted in the same
   * transaction that creates the session, so it works exactly once. Null when
   * the link is unknown, used or expired.
   */
  async redeemLoginLink(
    linkHash: string,
    sessionHash: string,
    sessionExpiresAt: number,
    now = Date.now(),
  ): Promise<AuthUser | null> {
    return this.ctx.storage.transactionSync(() => {
      const rows = [
        ...this.sql.exec(
          `SELECT user_id, name FROM auth_links WHERE token_hash = ? AND expires_at > ?`,
          linkHash,
          now,
        ),
      ];
      this.sql.exec(`DELETE FROM auth_links WHERE token_hash = ?`, linkHash);
      if (!rows.length) return null;
      const user = { userId: Number(rows[0].user_id), name: String(rows[0].name) };
      this.sql.exec(`DELETE FROM auth_sessions WHERE expires_at <= ?`, now);
      this.sql.exec(
        `INSERT INTO auth_sessions (token_hash, user_id, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
        sessionHash,
        user.userId,
        user.name,
        now,
        sessionExpiresAt,
      );
      console.log(`LosDO: login — ${user.name} (${user.userId})`);
      return user;
    });
  }

  /** Start a session directly, with no login link — the dev-only fake login. */
  async createSession(sessionHash: string, user: AuthUser, expiresAt: number, now = Date.now()): Promise<void> {
    this.sql.exec(
      `INSERT INTO auth_sessions (token_hash, user_id, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      sessionHash,
      user.userId,
      user.name,
      now,
      expiresAt,
    );
    console.log(`LosDO: DEV login — ${user.name} (${user.userId})`);
  }

  /** The account a session belongs to, or null when unknown or expired. */
  async sessionUser(sessionHash: string, now = Date.now()): Promise<AuthUser | null> {
    const rows = [
      ...this.sql.exec(
        `SELECT user_id, name FROM auth_sessions WHERE token_hash = ? AND expires_at > ?`,
        sessionHash,
        now,
      ),
    ];
    return rows.length ? { userId: Number(rows[0].user_id), name: String(rows[0].name) } : null;
  }

  /** End one session (logout). Idempotent. */
  async deleteSession(sessionHash: string): Promise<void> {
    this.sql.exec(`DELETE FROM auth_sessions WHERE token_hash = ?`, sessionHash);
  }

  /** End every session and pending link of one account; returns how many sessions ended. */
  async deleteUserSessions(userId: number): Promise<number> {
    return this.ctx.storage.transactionSync(() => {
      const n = Number(
        [...this.sql.exec(`SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?`, userId)][0].n,
      );
      this.sql.exec(`DELETE FROM auth_sessions WHERE user_id = ?`, userId);
      this.sql.exec(`DELETE FROM auth_links WHERE user_id = ?`, userId);
      return n;
    });
  }

  // ------------------------------------------------------------------- polls

  /** slug → polls.id, once looked up (ids never change). */
  private pollIds = new Map<string, number>();
  /**
   * poll id → its tally, rebuilt at most every POLL_TALLY_TTL_MS and dropped
   * on every vote. The tally reads every vote of the poll (it joins each to
   * the voter's rank tier), and the poll page is read far more often than
   * anybody votes; the TTL only lets tier moves from new games catch up.
   */
  private pollTallies = new Map<number, { at: number; tally: PollTally }>();

  /** The poll's id, creating its row the first time the slug is seen. */
  private pollId(slug: string, now = Date.now()): number {
    const cached = this.pollIds.get(slug);
    if (cached != null) return cached;
    const find = () => [...this.sql.exec(`SELECT id FROM polls WHERE slug = ?`, slug)][0];
    let row = find();
    if (!row) {
      this.sql.exec(`INSERT INTO polls (slug, created_at) VALUES (?, ?) ON CONFLICT(slug) DO NOTHING`, slug, now);
      row = find();
    }
    const id = Number(row.id);
    this.pollIds.set(slug, id);
    return id;
  }

  private pollTally(pollId: number, now: number): PollTally {
    const hit = this.pollTallies.get(pollId);
    if (hit && now - hit.at < POLL_TALLY_TTL_MS) return hit.tally;
    const rows = [
      ...this.sql.exec(
        `SELECT r.choice AS choice, p.tier AS tier, COUNT(*) AS n
           FROM poll_results r LEFT JOIN players p ON p.user_id = r.user_id
          WHERE r.poll_id = ?
          GROUP BY r.choice, p.tier`,
        pollId,
      ),
    ];
    const counts: Record<string, number> = {};
    const byTier = new Map<string, Record<string, number>>();
    let total = 0;
    for (const r of rows) {
      const choice = String(r.choice);
      const n = Number(r.n);
      const tier = tierOfIndex(r.tier == null ? null : Number(r.tier)) ?? "unrated";
      counts[choice] = (counts[choice] ?? 0) + n;
      const bucket = byTier.get(tier) ?? {};
      bucket[choice] = (bucket[choice] ?? 0) + n;
      byTier.set(tier, bucket);
      total += n;
    }
    const tally: PollTally = {
      total,
      counts,
      byTier: [...byTier].map(([tier, c]) => ({
        tier,
        total: Object.values(c).reduce((a, b) => a + b, 0),
        counts: c,
      })),
    };
    this.pollTallies.set(pollId, { at: now, tally });
    return tally;
  }

  /**
   * Record `user`'s vote on a poll, replacing any earlier one (a voter may
   * change their mind; only the latest counts). The caller has checked that
   * `choice` is one of the poll's options. Returns the previous choice.
   */
  async castVote(
    slug: string,
    user: AuthUser,
    choice: string,
    now = Date.now(),
  ): Promise<{ previous: string | null }> {
    return this.ctx.storage.transactionSync(() => {
      const pollId = this.pollId(slug, now);
      const prev = [
        ...this.sql.exec(`SELECT choice FROM poll_results WHERE poll_id = ? AND user_id = ?`, pollId, user.userId),
      ][0];
      if (!prev) {
        this.sql.exec(
          `INSERT INTO poll_results (poll_id, user_id, name, choice, voted_at, updated_at, changes)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
          pollId,
          user.userId,
          user.name,
          choice,
          now,
          now,
        );
      } else if (String(prev.choice) !== choice) {
        this.sql.exec(
          `UPDATE poll_results SET choice = ?, name = ?, updated_at = ?, changes = changes + 1
            WHERE poll_id = ? AND user_id = ?`,
          choice,
          user.name,
          now,
          pollId,
          user.userId,
        );
      }
      this.pollTallies.delete(pollId);
      const previous = prev ? String(prev.choice) : null;
      console.log(`LosDO: poll ${slug} — ${user.name} (${user.userId}) voted ${choice}${previous ? ` (was ${previous})` : ""}`);
      return { previous };
    });
  }

  /**
   * A poll's results: the tally (overall and by the voters' current rank
   * tier), the asking user's own vote, and — for an admin — every voter.
   */
  async pollState(
    slug: string,
    opts: { userId?: number | null; includeVoters?: boolean } = {},
    now = Date.now(),
  ): Promise<PollState> {
    const pollId = this.pollId(slug, now);
    const state: PollState = { ...this.pollTally(pollId, now), myVote: null };
    if (opts.userId != null) {
      const mine = [
        ...this.sql.exec(
          `SELECT choice, voted_at, updated_at, changes FROM poll_results WHERE poll_id = ? AND user_id = ?`,
          pollId,
          opts.userId,
        ),
      ][0];
      if (mine) {
        state.myVote = {
          choice: String(mine.choice),
          votedAt: Number(mine.voted_at),
          updatedAt: Number(mine.updated_at),
          changes: Number(mine.changes),
        };
      }
    }
    if (opts.includeVoters) {
      state.voters = [
        ...this.sql.exec(
          `SELECT r.user_id, r.name, r.choice, r.voted_at, r.updated_at, r.changes, p.tier, p.games
             FROM poll_results r LEFT JOIN players p ON p.user_id = r.user_id
            WHERE r.poll_id = ?
            ORDER BY r.updated_at DESC`,
          pollId,
        ),
      ].map((r) => ({
        userId: Number(r.user_id),
        name: String(r.name),
        choice: String(r.choice),
        votedAt: Number(r.voted_at),
        updatedAt: Number(r.updated_at),
        changes: Number(r.changes),
        tier: tierOfIndex(r.tier == null ? null : Number(r.tier)),
        games: r.games == null ? 0 : Number(r.games),
      }));
    }
    return state;
  }

  async clearAvoids(): Promise<{ ok: true; removed: number }> {
    const removed = Number([...this.sql.exec(`SELECT COUNT(*) AS n FROM avoids`)][0].n);
    this.sql.exec(`DELETE FROM avoids`);
    console.log(`LosDO: avoid lists cleared (${removed} entries)`);
    return { ok: true, removed };
  }

  /** Drop one entry from `player`'s list. Idempotent: `removed` says if it was there. */
  async removeAvoid(player: string, target: string): Promise<RemoveAvoidResult> {
    const ownerKey = avoidKey(player);
    const targetKey = avoidKey(target);
    const existing = [
      ...this.sql.exec(
        `SELECT avoid_name FROM avoids WHERE owner_key = ? AND avoid_key = ?`,
        ownerKey,
        targetKey,
      ),
    ];
    if (existing.length) {
      this.sql.exec(`DELETE FROM avoids WHERE owner_key = ? AND avoid_key = ?`, ownerKey, targetKey);
    }
    const count = Number(
      [...this.sql.exec(`SELECT COUNT(*) AS n FROM avoids WHERE owner_key = ?`, ownerKey)][0].n,
    );
    return {
      ok: true,
      removed: existing.length > 0,
      name: existing.length ? String(existing[0].avoid_name) : avoidName(target),
      count,
    };
  }

  /**
   * Every avoid entry touching any of these names, from EITHER end — the
   * balancer needs the pairs both of whose people are in the lobby, and the
   * lobby page's admin view lists who in this roster is avoiding whom. Which
   * of those an entry is good for is the caller's filter (avoidPairsOf).
   */
  async avoidsFor(names: string[]): Promise<{ entries: AvoidEntry[] }> {
    const keys = [...new Set(names.map(avoidKey).filter((n) => n.length > 0))];
    const out = new Map<string, AvoidEntry>();
    for (let i = 0; i < keys.length; i += SQL_MAX_BIND_PARAMS) {
      const chunk = keys.slice(i, i + SQL_MAX_BIND_PARAMS);
      const placeholders = chunk.map(() => "?").join(",");
      for (const column of ["owner_key", "avoid_key"] as const) {
        for (const r of this.sql.exec(
          `SELECT owner_key, avoid_key, owner_name, avoid_name, avoid_user_id, created_at
             FROM avoids WHERE ${column} IN (${placeholders})`,
          ...chunk,
        )) {
          out.set(`${String(r.owner_key)}\u0000${String(r.avoid_key)}`, avoidRow(r));
        }
      }
    }
    return { entries: [...out.values()] };
  }

  // --------------------------------------------------------------- scouting (OTL)

  /**
   * Store one onetricklava push (POST /api/scout/profiles, already validated by
   * parseScoutUpload): upsert the cards, drop the removed ids, and — when
   * anything moved — rebuild the Scouting page's boards. Writes are DIFF-ONLY:
   * a card identical to the stored one costs a read, not a write, so a resend
   * of everything (OTL's --full) is cheap on the write budget. One transaction.
   */
  async putScout(upload: ScoutUpload, now = Date.now()): Promise<ScoutPutResult> {
    let stored = 0;
    let unchanged = 0;
    let removed = 0;
    let added = 0;
    let total = 0;
    this.ctx.storage.transactionSync(() => {
      // Read BEFORE any write: the fallback count must not see this push's rows.
      const before = this.scoutCount();
      for (const card of upload.profiles) {
        const data = JSON.stringify(card);
        const prev = [...this.sql.exec(`SELECT data FROM scout_profiles WHERE user_id = ?`, card.userId)][0];
        if (prev != null && String(prev.data) === data) {
          unchanged++;
          continue;
        }
        if (prev == null) added++;
        this.sql.exec(
          `INSERT INTO scout_profiles (user_id, name_key, games, data, updated_at) VALUES (?,?,?,?,?)
           ON CONFLICT(user_id) DO UPDATE SET
             name_key = excluded.name_key, games = excluded.games,
             data = excluded.data, updated_at = excluded.updated_at`,
          card.userId,
          card.name.toLowerCase(),
          card.games,
          data,
          now,
        );
        stored++;
      }
      for (let i = 0; i < upload.remove.length; i += SQL_MAX_BIND_PARAMS) {
        const chunk = upload.remove.slice(i, i + SQL_MAX_BIND_PARAMS);
        const placeholders = chunk.map(() => "?").join(",");
        removed += Number(
          [...this.sql.exec(`SELECT COUNT(*) AS n FROM scout_profiles WHERE user_id IN (${placeholders})`, ...chunk)][0].n,
        );
        this.sql.exec(`DELETE FROM scout_profiles WHERE user_id IN (${placeholders})`, ...chunk);
      }
      if (stored > 0 || removed > 0 || this.getScoutMeta("boards") == null) {
        // Only the regulars can make a board, so only their rows are read.
        const cards: ScoutCard[] = [];
        for (const r of this.sql.exec(`SELECT data FROM scout_profiles WHERE games >= ?`, BOARD_MIN_GAMES)) {
          cards.push(JSON.parse(String(r.data)) as ScoutCard);
        }
        this.setScoutMeta("boards", JSON.stringify(scoutBoards(cards)));
      }
      total = before + added - removed;
      this.setScoutMeta("count", String(total));
      this.setScoutMeta(
        "sync",
        JSON.stringify({ generatedAt: upload.generatedAt, receivedAt: new Date(now).toISOString() }),
      );
    });
    console.log(
      `LosDO: scout push — ${stored} stored, ${unchanged} unchanged, ${removed} removed (${total} cards)`,
    );
    return { stored, unchanged, removed, total };
  }

  /** Scouting cards for a roster: by account id first, then by name for the rest. */
  async scoutCards(
    userIds: number[],
    names: string[],
    opts: { includePrivate?: boolean } = {},
  ): Promise<{ cards: ScoutCard[] }> {
    const byId = new Map<number, ScoutCard>();
    const ids = [...new Set(userIds.filter((n) => Number.isSafeInteger(n) && n > 0))];
    for (let i = 0; i < ids.length; i += SQL_MAX_BIND_PARAMS) {
      const chunk = ids.slice(i, i + SQL_MAX_BIND_PARAMS);
      const placeholders = chunk.map(() => "?").join(",");
      for (const r of this.sql.exec(`SELECT data FROM scout_profiles WHERE user_id IN (${placeholders})`, ...chunk)) {
        const card = JSON.parse(String(r.data)) as ScoutCard;
        byId.set(card.userId, card);
      }
    }
    const covered = new Set([...byId.values()].map((c) => c.name.toLowerCase()));
    const keys = [...new Set(names.map((n) => n.trim().toLowerCase()).filter((n) => n && !covered.has(n)))];
    for (let i = 0; i < keys.length; i += SQL_MAX_BIND_PARAMS) {
      const chunk = keys.slice(i, i + SQL_MAX_BIND_PARAMS);
      const placeholders = chunk.map(() => "?").join(",");
      for (const r of this.sql.exec(
        `SELECT data FROM scout_profiles WHERE name_key IN (${placeholders})`,
        ...chunk,
      )) {
        const card = JSON.parse(String(r.data)) as ScoutCard;
        // Two accounts once called the same: the busier one is the name's owner.
        const prev = [...byId.values()].find((c) => c.name.toLowerCase() === card.name.toLowerCase());
        if (prev && prev.games >= card.games) continue;
        if (prev) byId.delete(prev.userId);
        byId.set(card.userId, card);
      }
    }
    const hidden = this.privateAmong(byId.keys(), opts.includePrivate === true);
    return { cards: [...byId.values()].filter((c) => !hidden.has(c.userId)) };
  }

  /** One player's card; a private LOS profile answers `{private: true}` to a visitor. */
  async scoutCard(
    userId: number,
    opts: { includePrivate?: boolean } = {},
  ): Promise<{ card: ScoutCard } | { private: true } | null> {
    const row = [...this.sql.exec(`SELECT data FROM scout_profiles WHERE user_id = ?`, userId)][0];
    if (row == null) return null;
    if (opts.includePrivate !== true && this.isPrivate(userId)) return { private: true };
    return { card: JSON.parse(String(row.data)) as ScoutCard };
  }

  /** The Scouting page: the boards (private players filtered out for a visitor) + sync facts. */
  async readScoutBoards(opts: { includePrivate?: boolean; keep?: number } = {}): Promise<
    ScoutBoards & { profiles: number; generatedAt: string | null; receivedAt: string | null }
  > {
    const raw = this.getScoutMeta("boards");
    const boards: ScoutBoards = raw ? (JSON.parse(raw) as ScoutBoards) : { watchlist: [], laneKings: [] };
    const sync = JSON.parse(this.getScoutMeta("sync") ?? "{}") as { generatedAt?: string | null; receivedAt?: string };
    const hidden = opts.includePrivate === true ? new Set<number>() : this.privateUserIds();
    return {
      ...filterBoards(boards, hidden, Math.min(BOARD_KEEP, Math.max(1, opts.keep ?? 20))),
      profiles: this.scoutCount(),
      generatedAt: sync.generatedAt ?? null,
      receivedAt: sync.receivedAt ?? null,
    };
  }

  /** Drop every card (POST /api/scout/reset). OTL's next --full push refills it. */
  async clearScout(): Promise<{ ok: true; removed: number }> {
    const removed = this.scoutCount();
    this.sql.exec(`DELETE FROM scout_profiles`);
    this.sql.exec(`DELETE FROM scout_meta`);
    console.log(`LosDO: every scouting card cleared (${removed})`);
    return { ok: true, removed };
  }

  /** Cards held — maintained by putScout, so a read never counts the table. */
  private scoutCount(): number {
    const kept = this.getScoutMeta("count");
    if (kept != null) return Number(kept);
    const n = Number([...this.sql.exec(`SELECT COUNT(*) AS n FROM scout_profiles`)][0].n);
    this.setScoutMeta("count", String(n));
    return n;
  }

  private getScoutMeta(key: string): string | null {
    const row = [...this.sql.exec(`SELECT value FROM scout_meta WHERE key = ?`, key)][0];
    return row == null ? null : String(row.value);
  }

  private setScoutMeta(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO scout_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  // --------------------------------------------------------------- reads

  /**
   * The paged leaderboard: every rated player (a `players` row = at least one
   * rated game). An optional `q` narrows it to names starting with q
   * (case-insensitive prefix); paging and `total` then cover the MATCHES,
   * while each row's `rank` stays its GLOBAL leaderboard position (searching
   * "mol" shows Molly as #37, not #1). The total is the maintained count and
   * the rank the materialized column, so a page costs its own rows only.
   *
   * Private profiles are OFF this list unless `includePrivate` (the admin
   * view) asks for them; `rank` counts public players either way, so a private
   * row an admin sees carries rank null and the public list has no gaps.
   */
  async ranking(
    opts: {
      page?: number;
      perPage?: number;
      q?: string;
      includePrivate?: boolean;
      sort?: RankingSort;
      dir?: RankingDir;
    } = {},
  ) {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const perPage = Math.min(RANKING_MAX_PER_PAGE, Math.max(1, Math.floor(opts.perPage ?? 50)));
    const offset = (page - 1) * perPage;
    const q = (opts.q ?? "").trim();
    const includePrivate = opts.includePrivate === true;
    const { sort, dir } = parseRankingSort(opts.sort, opts.dir);
    const orderBy = rankingOrderBy(sort, dir);
    // A player lapses with the passage of time, which no write can notice.
    this.sweepActivityIfDue();
    // Prefix search. `name LIKE ?` with a bound "prefix%" runs as a range scan on
    // idx_players_name (the index's NOCASE collation is what lets LIKE use it —
    // do NOT append COLLATE NOCASE to the expression, that defeats it).
    const needle = q.length === 0 ? null : `${likeEscape(q)}%`;
    // inactiveDays travels with the list so a page can name the rule in its
    // "inactive" tooltip without keeping its own copy of the number.
    const meta = {
      page,
      perPage,
      q,
      includePrivate,
      inactiveDays: INACTIVE_DAYS,
      // Echoed so a page can mark the header it is actually sorted by, rather
      // than assuming the one it asked for was understood.
      sort,
      dir,
      // Like inactiveDays: the window the two change columns were measured over,
      // so a page can name it in its own wording without keeping a second copy
      // of the number.
      changeDays: RANK_HISTORY_DAYS,
      lastSeq: this.lastSeq(),
    };

    if (needle != null) {
      // A SEARCH reads its matches ONCE, through idx_players_name, and does the
      // ordering, the partitioning and the paging here.
      //
      // In SQL it took four passes — two counts and a page of each half — and
      // an `AND ranked = ?` alongside the LIKE was enough for the planner to
      // prefer idx_players_ranked and walk every ranked player instead of the
      // handful the prefix matches (744 rows for one search of a 720-player
      // store, against the ~50 it should cost). A name prefix is inherently
      // narrow, and the whole match set had to be materialized anyway for the
      // ORDER BY, so one pass is both cheaper and predictable. Note the absence
      // of an ORDER BY: adding one is what lets the planner reach for a
      // different index and read the table instead of the match.
      const matches = this.rankingRows([`name LIKE ?1 ESCAPE '\\'`], [needle], "");
      const order = rankingComparator(sort, dir);
      const listed = includePrivate
        ? matches.sort(order).map((r): WireRankedPlayer => ({
            rank: r.rank == null ? null : Number(r.rank),
            ...this.wirePlayerRow(r),
          }))
        : rankedFirst(matches, order).map((r): WireRankedPlayer => {
            const wire = this.wirePlayerRow(r);
            // On the tier board (the visitors' list) a match's place would need
            // a count of everyone above it; the LOS position would give the
            // hidden order back. So a match carries no number at all.
            if (Number(r.ranked) === 1) return { rank: sort === "tier" ? null : Number(r.public_rank), ...wire };
            return { rank: null, ...(wire.privateProfile ? redactRatedPlayer(wire) : wire) };
          });
      return {
        ...meta,
        // Both totals cover the MATCHES, like the page they describe.
        total: matches.length,
        rankedTotal: includePrivate
          ? matches.filter((r) => Number(r.ranked) === 1).length
          : matches.filter((r) => Number(r.ranked) === 1).length,
        players: listed.slice(offset, offset + perPage),
      };
    }

    if (includePrivate) {
      // The admin sees the leaderboard as it really is: ONE list — in the
      // requested order, LOS by default — with the hidden and lapsed players in
      // their true places, each row's `rank` being its true position (the
      // materialized column, no counting). That the position is materialized is
      // what lets the list be ordered by something else at all: a row still
      // knows where it stands on the leaderboard when the page is sorted by
      // what moved, exactly as a search result does.
      const rows = this.rankingRows([], [], orderBy, perPage, offset);
      return {
        ...meta,
        total: this.count("players"),
        // Same field as the public shape, so a page can say how many of the
        // players it is listing the leaderboard actually ranks.
        rankedTotal: this.rankedPlayerCount(),
        players: rows.map((r): WireRankedPlayer => ({
          rank: r.rank == null ? null : Number(r.rank),
          ...this.wirePlayerRow(r),
        })),
      };
    }

    // The public list is two lists end to end: the RANKED players in the
    // requested order (the leaderboard's own by default), and then everyone the
    // leaderboard leaves out — a private profile, or one that has not played in
    // INACTIVE_DAYS — with no position at all, most recently seen first.
    //
    // The sort reaches the HEAD only. The tail's order is not a display
    // preference: ordering those rows by a rating, or by anything derived from
    // one, would read as a ranking and — for the private rows whose rating is
    // blanked — put back exactly the standing the blanking removes.
    //
    // Both totals are maintained counts, so finding where one list ends and the
    // other begins costs no scan of the table.
    const rankedTotal = this.rankedPlayerCount();
    const total = this.count("players");

    const players: WireRankedPlayer[] = [];
    // idx_players_ranked answers this without a sort and without reading a
    // single unranked row (leading equality, the rest already in order).
    const take = Math.min(perPage, rankedTotal - offset);
    if (take > 0) {
      const rows = this.rankingRows([], [], orderBy, take, offset, ["ranked = 1"]);
      for (const r of rows) {
        // The materialized position, NOT this page's offset: under any sort but
        // the leaderboard's own the two are different numbers, and the one a
        // reader wants is where the player stands — the same rule the search
        // has always followed.
        // On the tier board (the visitors' list) a row's place is its position
        // in THAT order: the LOS leaderboard position would give the hidden
        // ordering back.
        players.push({
          rank: sort === "tier" ? offset + players.length + 1 : Number(r.public_rank),
          ...this.wirePlayerRow(r),
        });
      }
    }
    // The tail, once this page reaches past the ranked players. Paged in SQL
    // through idx_players_unranked (its own rows, in its own order, no sort):
    // every lapsed player is in here, which in a mature store is most of them.
    const want = perPage - players.length;
    if (want > 0) {
      const rows = this.rankingRows(
        [],
        [],
        "ORDER BY last_played DESC, user_id",
        want,
        Math.max(0, offset - rankedTotal),
        ["ranked = 0"],
      );
      for (const r of rows) {
        // Unranked either way, but only a PRIVATE profile has its rating taken
        // away with the position; a lapsed one is as public as it ever was.
        const wire = this.wirePlayerRow(r);
        players.push({ rank: null, ...(wire.privateProfile ? redactRatedPlayer(wire) : wire) });
      }
    }
    return { ...meta, total, rankedTotal, players };
  }

  /** One page of `players` for the ranking, always selecting the same columns. */
  private rankingRows(
    where: string[],
    binds: SqlStorageValue[],
    orderBy: string,
    limit?: number,
    offset = 0,
    extraWhere: string[] = [],
  ): Record<string, SqlStorageValue>[] {
    // ?1 is the LIKE needle when there is one, so LIMIT/OFFSET bind after it.
    const paging = limit == null ? "" : `LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`;
    const clauses = [...where, ...extraWhere];
    return [
      ...this.sql.exec(
        `SELECT user_id, name, mu, sigma, los, games, wins, last_played, bar_os, tier,
                rank, public_rank, private_profile, inactive, ranked,
                rank_change_7d, los_change_7d
           FROM players
          ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
          ${orderBy}
          ${paging}`,
        ...binds,
        ...(limit == null ? [] : [limit, offset]),
      ),
    ];
  }

  private wirePlayerRow(r: Record<string, SqlStorageValue>): WireRatedPlayer {
    const mu = Number(r.mu);
    const sigma = Number(r.sigma);
    const games = Number(r.games);
    const wins = Number(r.wins);
    return {
      userId: Number(r.user_id),
      name: String(r.name),
      // Shown LOS (rookie handicap applied); the ORDER of any list still comes
      // from the raw stored column.
      los: shownLosOf(mu, sigma, games),
      // The stored (hysteresis) tier when the SELECT carried it, else the plain one.
      tier: r.tier == null ? tierOf(shownLosOf(mu, sigma, games), games) : tierOfIndex(Number(r.tier)),
      mu,
      sigma,
      leaderboardRating: leaderboardOf(mu, sigma),
      games,
      wins,
      losses: games - wins,
      lastPlayed: String(r.last_played),
      barOs: r.bar_os == null ? null : Number(r.bar_os),
      // Only selected by the ranking (the lookup/search shapes omit the columns).
      ...(r.private_profile == null ? {} : { privateProfile: Number(r.private_profile) === 1 }),
      ...(r.inactive == null ? {} : { inactive: Number(r.inactive) === 1 }),
      // A NULL here is a real value ("no baseline"), not an absent column, so
      // these two ride on whether the SELECT asked for them at all.
      ...(RANK_CHANGE_COLUMNS.every((c) => c in r)
        ? {
            rankChange7d: r.rank_change_7d == null ? null : Number(r.rank_change_7d),
            losChange7d: r.los_change_7d == null ? null : Number(r.los_change_7d),
          }
        : {}),
    };
  }

  /**
   * The games list, newest first. Two paging modes:
   *   • keyset (`afterTime`+`afterId`, the API's original contract) — stable
   *     under inserts, since new games only prepend;
   *   • numbered (`page`, 1-based, with `limit` as the page size) — for the
   *     Games page's pager, which needs "page N of M" and a total. Offset paging
   *     is fine here: a year of lava is a few thousand rows on an indexed
   *     ORDER BY, and the tail of the list never moves under a reader.
   * Ignored games are included by default, flagged `ignored: true`;
   * `ratedOnly` narrows to fold games.
   */
  async games(
    opts: {
      afterTime?: string;
      afterId?: string;
      page?: number;
      limit?: number;
      ratedOnly?: boolean;
      includePrivate?: boolean;
    } = {},
  ) {
    const limit = Math.min(GAMES_MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? 25)));
    const keyset = opts.afterTime != null && opts.afterId != null;
    const page = opts.page != null ? Math.max(1, Math.floor(opts.page)) : null;
    const where: string[] = [];
    const binds: SqlStorageValue[] = [];
    if (keyset) {
      where.push(`(start_time, id) < (?, ?)`);
      binds.push(opts.afterTime!, opts.afterId!);
    }
    if (opts.ratedOnly) where.push(`status = 'rated'`);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = [
      ...this.sql.exec(
        `SELECT id, start_time, duration_ms, map, winner_team, status, unranked_reason, excluded FROM games
          ${whereSql}
          ORDER BY start_time DESC, id DESC LIMIT ? OFFSET ?`,
        ...binds,
        limit,
        page ? (page - 1) * limit : 0,
      ),
    ];
    const rosters = this.rostersFor(rows.map((r) => String(r.id)));
    const hidden = this.hiddenInRosters(rosters, opts.includePrivate === true);
    const games: WireGame[] = rows.map((r) => this.wireGame(r, rosters, hidden));
    const last = games.length === limit ? games[games.length - 1] : null;
    return {
      games,
      next: last ? { afterTime: last.startTime, afterId: last.id } : null,
      page: page ?? 1,
      perPage: limit,
      // The whole collection (the maintained count), whichever page or cursor
      // this is — never a COUNT(*) over the table.
      total: this.count(opts.ratedOnly ? "games_rated" : "games"),
      lastSeq: this.lastSeq(),
    };
  }

  /** One game with its full roster + per-player LOS deltas, or null.
   * A private player's entry keeps its Δ LOS and loses every absolute rating,
   * unless `includePrivate` (the admin view) asks for the lot. */
  async gameDetail(id: string, opts: { includePrivate?: boolean } = {}) {
    const rows = [
      ...this.sql.exec(
        `SELECT id, seq, start_time, duration_ms, map, engine_version, game_version,
                winner_team, status, uploaded_at, unranked_reason, excluded, lobby
           FROM games WHERE id = ?`,
        id,
      ),
    ];
    if (!rows.length) return null;
    const r = rows[0];
    const rosters = this.rostersFor([id]);
    const game = this.wireGame(r, rosters, this.hiddenInRosters(rosters, opts.includePrivate === true));
    return {
      ...game,
      seq: r.seq == null ? null : Number(r.seq),
      engineVersion: r.engine_version == null ? null : String(r.engine_version),
      gameVersion: r.game_version == null ? null : String(r.game_version),
      uploadedAt: String(r.uploaded_at),
      lobby: parseLobbyColumn(r.lobby),
    };
  }

  /**
   * One game for the wire. `hidden` names the players whose profile is private
   * for this reader: their roster entry keeps the name, side, result and Δ LOS
   * but loses every absolute rating.
   *
   * Both derived numbers — the win-chance prediction and the team averages —
   * are taken from the FULL roster first. They are properties of the game, the
   * same for whoever asks, and computing them after the blanking would silently
   * change what a game page says depending on who is looking.
   */
  private wireGame(
    r: Record<string, SqlStorageValue>,
    rosters: Map<string, WirePlayer[]>,
    hidden: ReadonlySet<number> = EMPTY_HIDDEN,
  ): WireGame {
    const roster = rosters.get(String(r.id)) ?? [];
    const teams: WirePlayer[][] = [[], []];
    for (const p of roster) teams[p.team]?.push(p);
    // Pre-game predicted win chance per team, from the same rookie-discounted
    // inputs the fold rated with. Rated games only (ignored have no ratings).
    const rated = String(r.status) === "rated";
    const predictedWin = rated
      ? predictTeams(
          teams.map((team) =>
            team.map((p) => ({
              muBefore: p.muBefore!,
              sigmaBefore: p.sigmaBefore!,
              gameNumber: p.gameNumber!,
            })),
          ),
        )
      : null;
    const avgLosBefore = teams.map(meanLosBefore);
    return {
      id: String(r.id),
      startTime: String(r.start_time),
      durationMs: Number(r.duration_ms),
      map: String(r.map),
      winnerTeam: Number(r.winner_team),
      ignored: !rated,
      unrankedReason: r.unranked_reason == null ? null : (String(r.unranked_reason) as UnrankedReason),
      excluded: Number(r.excluded ?? 0) === 1,
      // Strongest first by LOS before the game (a blanked row last), so a
      // visitor, whose copy loses the numbers, still gets the rosters in LOS
      // order. Sorted AFTER the blanking: a hidden player's place in the list
      // would be their rating again.
      teams: (hidden.size === 0
        ? teams
        : teams.map((team) => team.map((p) => (hidden.has(p.userId) ? redactRosterRating(p) : p)))
      ).map(byLosBeforeDesc),
      predictedWin,
      avgLosBefore,
    };
  }

  /**
   * Every hidden player's user_id, cached on this instance.
   *
   * Blanking a roster means asking "is this one private?" sixteen times per
   * game, and a games page carries hundreds of roster rows — looked up in
   * SQLite that cost ~800 row reads per view of /games, which is exactly the
   * kind of per-read scan the counts and materialized ranks exist to avoid.
   * The set is tiny (a handful of admin-set flags) and this DO is its only
   * writer, so it is loaded once per instance and invalidated by hand: see
   * every `forgetPrivateIds` call.
   */
  private privateIds: Set<number> | null = null;

  private privateUserIds(): ReadonlySet<number> {
    if (this.privateIds == null) {
      this.privateIds = new Set(
        [...this.sql.exec(`SELECT user_id FROM players WHERE private_profile = 1`)].map((r) =>
          Number(r.user_id),
        ),
      );
    }
    return this.privateIds;
  }

  /** Drop the cache after anything that could have changed who is hidden. */
  private forgetPrivateIds(): void {
    this.privateIds = null;
  }

  /**
   * Which of these players have a private profile — the roster entries a
   * non-admin read must blank. Free (a set intersection), and empty for the
   * admin view, which hides nothing.
   */
  private privateAmong(userIds: Iterable<number>, includePrivate: boolean): ReadonlySet<number> {
    if (includePrivate) return EMPTY_HIDDEN;
    const hidden = this.privateUserIds();
    if (hidden.size === 0) return EMPTY_HIDDEN;
    const out = new Set<number>();
    for (const id of userIds) if (hidden.has(id)) out.add(id);
    return out;
  }

  /** The private players across a whole page of rosters. */
  private hiddenInRosters(
    rosters: Map<string, WirePlayer[]>,
    includePrivate: boolean,
  ): ReadonlySet<number> {
    if (includePrivate) return EMPTY_HIDDEN;
    const ids: number[] = [];
    for (const roster of rosters.values()) for (const p of roster) ids.push(p.userId);
    return this.privateAmong(ids, false);
  }

  /** Bulk-load the rosters of the given game ids, chunked under the bind cap. */
  private rostersFor(gameIds: string[]): Map<string, WirePlayer[]> {
    const out = new Map<string, WirePlayer[]>();
    for (let i = 0; i < gameIds.length; i += SQL_MAX_BIND_PARAMS) {
      const chunk = gameIds.slice(i, i + SQL_MAX_BIND_PARAMS);
      const placeholders = chunk.map(() => "?").join(",");
      for (const r of this.sql.exec(
        `SELECT game_id, user_id, team, won, name, faction, bar_skill, bar_rank,
                game_number, mu_before, sigma_before, mu_after, sigma_after
           FROM game_players WHERE game_id IN (${placeholders})`,
        ...chunk,
      )) {
        const gameId = String(r.game_id);
        if (!out.has(gameId)) out.set(gameId, []);
        out.get(gameId)!.push(wireRosterRow(r));
      }
    }
    return out;
  }

  /**
   * One player's profile: current state, rank, recent games. Null if never rated.
   *
   * A PRIVATE profile read WITHOUT `includePrivate` answers with the name and
   * `privateProfile: true` and nothing else — no rating, no rank, no counts, no
   * recent games. The player page turns that into "this profile is private" in
   * place of the card and the chart, and draws its games table from
   * playerGames (which hides the same player's LOS the same way).
   */
  async player(userId: number, opts: { includePrivate?: boolean } = {}) {
    this.sweepActivityIfDue(); // the rank this serves depends on who has lapsed
    const row = [
      ...this.sql.exec(
        `SELECT rank, public_rank, private_profile, inactive, tier FROM players WHERE user_id = ?`,
        userId,
      ),
    ][0];
    if (row == null) return null;
    const privateProfile = Number(row.private_profile) === 1;
    const inactive = Number(row.inactive) === 1;
    const admin = opts.includePrivate === true;
    const s = this.selectPlayer(userId)!;
    if (privateProfile && !admin) {
      return { userId: s.userId, name: s.name, privateProfile: true as const };
    }
    const los = shownLosOf(s.mu, s.sigma, s.games);
    // "#N of M" has to mean the same thing here as on the ranking page the
    // reader came from: the admin's true position over everyone, or the
    // visitor's position among the players their list actually numbers (NULL
    // for a private profile, which that list leaves in its rankless tail).
    const raw = admin ? row.rank : row.public_rank;
    const rank = raw == null ? null : Number(raw);
    // Each recent game carries the whole game (roster, duration, prediction —
    // the same WireGame the list serves) plus this player's own transition, so
    // the player page can draw the games table in the same layout as /games.
    const recent = [
      ...this.sql.exec(
        `SELECT gp.game_id, gp.team, gp.won, gp.game_number,
                gp.mu_before, gp.sigma_before, gp.mu_after, gp.sigma_after,
                g.id, g.start_time, g.duration_ms, g.map, g.winner_team, g.status,
                g.unranked_reason, g.excluded
           FROM game_players gp JOIN games g ON g.id = gp.game_id
          WHERE gp.user_id = ?
          ORDER BY gp.start_time DESC, gp.game_id DESC LIMIT ?`,
        userId,
        RECENT_GAMES_LIMIT,
      ),
    ];
    return {
      userId: s.userId,
      name: s.name,
      los,
      tier: row.tier == null ? tierOf(los, s.games) : tierOfIndex(Number(row.tier)),
      mu: s.mu,
      sigma: s.sigma,
      leaderboardRating: leaderboardOf(s.mu, s.sigma),
      games: s.games,
      wins: s.wins,
      losses: s.games - s.wins,
      firstPlayed: s.firstPlayed,
      lastPlayed: s.lastPlayed,
      barOs: s.barOs,
      rank,
      rankedOf: admin ? this.count("players") : this.rankedPlayerCount(),
      privateProfile,
      // Says why `rank` is null on an otherwise perfectly public profile.
      inactive,
      inactiveDays: INACTIVE_DAYS,
      // The subject is public here (a private one returned above), but their
      // opponents may not be — recentGames goes through the same blanking.
      recentGames: this.playerGameRows(recent, null, admin),
    };
  }

  /** Is this player's profile hidden from a non-admin reader? A set lookup —
   * see privateUserIds. False for a user_id with no players row at all. */
  private isPrivate(userId: number): boolean {
    return this.privateUserIds().has(userId);
  }

  /**
   * One player's games, newest first, numbered pages (the player page's table).
   * Each entry is the whole game in the list shape plus this player's own side
   * and rating transition — the same rows `player()` serves as recentGames.
   *
   * A private profile still lists its games to a non-admin — only the RATING is
   * withheld: this player's LOS before/after/delta, and their own entry in each
   * roster, come back null (`privateProfile: true` says why). Everyone else in
   * the roster keeps theirs; the game itself is public on /games either way.
   */
  async playerGames(userId: number, opts: { page?: number; limit?: number; includePrivate?: boolean } = {}) {
    const limit = Math.min(GAMES_MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? RECENT_GAMES_LIMIT)));
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const rows = [
      ...this.sql.exec(
        `SELECT gp.game_id, gp.team, gp.won, gp.game_number,
                gp.mu_before, gp.sigma_before, gp.mu_after, gp.sigma_after,
                g.id, g.start_time, g.duration_ms, g.map, g.winner_team, g.status,
                g.unranked_reason, g.excluded
           FROM game_players gp JOIN games g ON g.id = gp.game_id
          WHERE gp.user_id = ?
          ORDER BY gp.start_time DESC, gp.game_id DESC LIMIT ? OFFSET ?`,
        userId,
        limit,
        (page - 1) * limit,
      ),
    ];
    const total = Number(
      [...this.sql.exec(`SELECT COUNT(*) AS n FROM game_players WHERE user_id = ?`, userId)][0].n,
    );
    const hide = opts.includePrivate !== true && this.isPrivate(userId);
    return {
      userId,
      games: this.playerGameRows(rows, hide ? userId : null, opts.includePrivate === true),
      page,
      perPage: limit,
      total,
      privateProfile: hide,
    };
  }

  /** Shape a player's game_players ⋈ games rows for the wire (shared by player/playerGames).
   * `hideUserId`, when set, blanks that player's rating everywhere in the result —
   * their own transition and their entry in each roster (see playerGames). */
  private playerGameRows(
    rows: Record<string, SqlStorageValue>[],
    hideUserId: number | null = null,
    includePrivate = false,
  ) {
    const rosters = this.rostersFor(rows.map((r) => String(r.game_id)));
    // wireGame blanks EVERY private player in each roster (the same entries the
    // game page hides), keeping their Δ LOS. The subject of this page, when
    // private, is blanked harder still — no delta either, which is what its
    // games table is asked to withhold — so it is redacted again on top.
    const hidden = this.hiddenInRosters(rosters, includePrivate);
    return rows.map((r) => {
      const game = this.wireGame(r, rosters, hidden);
      const teams =
        hideUserId == null
          ? game.teams
          : game.teams.map((team) => team.map((p) => (p.userId === hideUserId ? redactRating(p) : p)));
      return {
        ...game,
        teams,
        gameId: String(r.game_id),
        team: Number(r.team),
        won: Number(r.won) === 1,
        gameNumber: r.game_number == null ? null : Number(r.game_number),
        losBefore: hideUserId == null ? losBeforeOf(r) : null,
        // This player's rank going into the game.
        tier: hideUserId == null ? tierOf(losBeforeOf(r), gamesBehind(r) - 1) : null,
        losAfter: hideUserId == null ? losAfterOf(r) : null,
        losDelta: hideUserId == null ? losDeltaOf(r) : null,
      };
    });
  }

  /** The chart series: every rated game's post-game rating, oldest first.
   * A private profile serves NO points to a non-admin — the page draws its
   * "this profile is private" notice where the chart would be. */
  async playerHistory(userId: number, opts: { includePrivate?: boolean } = {}) {
    if (opts.includePrivate !== true && this.isPrivate(userId)) {
      return { userId, points: [], privateProfile: true };
    }
    const rows = [
      ...this.sql.exec(
        `SELECT game_id, start_time, game_number, won, mu_after, sigma_after
           FROM game_players
          WHERE user_id = ? AND mu_after IS NOT NULL
          ORDER BY start_time, game_id`,
        userId,
      ),
    ];
    return {
      userId,
      privateProfile: false,
      points: rows.map((r) => ({
        gameId: String(r.game_id),
        startTime: String(r.start_time),
        gameNumber: Number(r.game_number),
        won: Number(r.won) === 1,
        mu: Number(r.mu_after),
        sigma: Number(r.sigma_after),
        los: shownLosOf(Number(r.mu_after), Number(r.sigma_after), Number(r.game_number)),
      })),
    };
  }

  /**
   * Bulk exact-name lookup (case-insensitive) over CURRENT names, for resolving a
   * lobby roster in one request. Always answers with the REAL rating, private
   * profiles included, plus `privateProfile` saying which ones they are: the bot
   * balances on this and needs the true numbers, so hiding is the caller's job
   * (the lobby view blanks the display value — see finalizeLobby). Returns a map keyed by the LOWERCASED name; a name
   * no rated player currently carries is simply absent. When two accounts share a
   * current name the more-established one wins (more games, then most recent).
   */
  async playersByNames(names: string[]) {
    const wanted = new Map<string, string>(); // lowercased → as-asked (first spelling)
    for (const n of names) {
      const key = n.trim().toLowerCase();
      if (key && !wanted.has(key)) wanted.set(key, n);
    }
    const keys = [...wanted.keys()];
    const out: Record<string, WireRatedPlayer> = {};
    const seen = new Map<string, { games: number; lastPlayed: string }>();
    for (let i = 0; i < keys.length; i += SQL_MAX_BIND_PARAMS) {
      const chunk = keys.slice(i, i + SQL_MAX_BIND_PARAMS);
      const placeholders = chunk.map(() => "?").join(",");
      for (const r of this.sql.exec(
        `SELECT user_id, name, mu, sigma, los, games, wins, last_played, bar_os, private_profile, tier
           FROM players WHERE name COLLATE NOCASE IN (${placeholders})`,
        ...chunk,
      )) {
        const key = String(r.name).toLowerCase();
        const games = Number(r.games);
        const lastPlayed = String(r.last_played);
        const prev = seen.get(key);
        if (prev && (prev.games > games || (prev.games === games && prev.lastPlayed >= lastPlayed))) {
          continue;
        }
        seen.set(key, { games, lastPlayed });
        out[key] = this.wirePlayerRow(r);
      }
    }
    return { players: out };
  }

  /** Case-insensitive substring search over current names, best LOS first. */
  async searchPlayers(q: string) {
    const needle = `%${likeEscape(q)}%`;
    const rows = [
      ...this.sql.exec(
        `SELECT user_id, name, mu, sigma, los, games, wins, last_played, bar_os
           FROM players WHERE name LIKE ? ESCAPE '\\' COLLATE NOCASE
          ORDER BY los DESC, user_id LIMIT ?`,
        needle,
        SEARCH_LIMIT,
      ),
    ];
    return { players: rows.map((r) => this.wirePlayerRow(r)) };
  }
}

// SQL attribution: wrap the prototype once, at module load (see src/sqlStats.ts).
trackSqlOnPrototype(LosDO, ["sqlStatsReport"]);

/** The stored `games.lobby` JSON back into an object; null on NULL (and on a
 * corrupt value, which only a hand-edited store could contain). */
function parseLobbyColumn(v: SqlStorageValue): Record<string, unknown> | null {
  if (v == null) return null;
  try {
    const parsed = JSON.parse(String(v));
    return parsed != null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** How many near-miss names an unknown `.avoid <player>` target comes back with. */
const AVOID_SUGGESTIONS = 3;

/** One `avoids` row as the wire shape (src/avoids.ts AvoidEntry). */
function avoidRow(r: Record<string, SqlStorageValue>): AvoidEntry {
  return {
    owner: String(r.owner_name),
    avoid: String(r.avoid_name),
    avoidUserId: r.avoid_user_id == null ? null : Number(r.avoid_user_id),
    createdAt: String(r.created_at),
  };
}

/** Escape a user string for `LIKE ? ESCAPE '\\'` (backslash, %, _). */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function wireRosterRow(r: Record<string, SqlStorageValue>): WirePlayer {
  return {
    userId: Number(r.user_id),
    name: String(r.name),
    team: Number(r.team),
    won: Number(r.won) === 1,
    faction: r.faction == null ? null : String(r.faction),
    barSkill: r.bar_skill == null ? null : Number(r.bar_skill),
    barRank: r.bar_rank == null ? null : Number(r.bar_rank),
    gameNumber: r.game_number == null ? null : Number(r.game_number),
    losBefore: losBeforeOf(r),
    // The tier going INTO the game (plain cutoffs: a past moment has no history).
    tier: tierOf(losBeforeOf(r), gamesBehind(r) - 1),
    losAfter: losAfterOf(r),
    losDelta: losDeltaOf(r),
    muBefore: r.mu_before == null ? null : Number(r.mu_before),
    sigmaBefore: r.sigma_before == null ? null : Number(r.sigma_before),
    muAfter: r.mu_after == null ? null : Number(r.mu_after),
    sigmaAfter: r.sigma_after == null ? null : Number(r.sigma_after),
  };
}

/** A ranking row with the rating blanked — a private profile in the public
 * list's tail. `barOs` goes too: it is BAR's rating of the same player. The two
 * 7-day CHANGES stay, for the reason redactRosterRating keeps Δ LOS: a movement
 * says nothing about the rating or the position it moved. */
function redactRatedPlayer(p: WireRatedPlayer): Omit<WireRankedPlayer, "rank"> {
  return { ...p, los: null, tier: null, mu: null, sigma: null, leaderboardRating: null, barOs: null };
}

/** Leaderboard order: best LOS first, ties by user_id — the order every ranking
 * index materializes, applied here when the rows came back unordered. */
function byLeaderboard(a: Record<string, SqlStorageValue>, b: Record<string, SqlStorageValue>): number {
  return Number(b.los) - Number(a.los) || Number(a.user_id) - Number(b.user_id);
}

/** The public ranking's order over a set of rows: the ranked ones in the
 * requested order (the leaderboard's own by default), then the rest most
 * recently seen first — which is not a display preference (see ranking). */
function rankedFirst(
  rows: Record<string, SqlStorageValue>[],
  order: (a: Record<string, SqlStorageValue>, b: Record<string, SqlStorageValue>) => number = byLeaderboard,
): Record<string, SqlStorageValue>[] {
  const ranked = rows.filter((r) => Number(r.ranked) === 1).sort(order);
  const rest = rows
    .filter((r) => Number(r.ranked) === 0)
    .sort(
      (a, b) =>
        String(b.last_played).localeCompare(String(a.last_played)) ||
        Number(a.user_id) - Number(b.user_id),
    );
  return ranked.concat(rest);
}

/** No player is hidden — the admin view, and the default everywhere else. */
const EMPTY_HIDDEN: ReadonlySet<number> = new Set<number>();

/** A team's rows, strongest LOS before the game first (none last, then by name). */
function byLosBeforeDesc(team: WirePlayer[]): WirePlayer[] {
  const key = (p: WirePlayer) => p.losBefore ?? -1;
  return team.slice().sort((a, b) => key(b) - key(a) || a.name.localeCompare(b.name));
}

/** A team's mean pre-game LOS; null when nobody in it was rated. */
function meanLosBefore(team: WirePlayer[]): number | null {
  const vals = team.map((p) => p.losBefore).filter((v): v is number => v != null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * A private player's entry in a game's roster: the name, side, result, faction
 * and game number stay, and so does **Δ LOS** — a change says nothing about the
 * rating it moved, and it is what makes the row worth showing at all. What goes
 * is every absolute figure: the LOS before and after, the μ/σ they are made of,
 * and BAR's own skill number for the same player.
 */
function redactRosterRating(p: WirePlayer): WirePlayer {
  return {
    ...p,
    barSkill: null,
    losBefore: null,
    tier: null,
    losAfter: null,
    muBefore: null,
    sigmaBefore: null,
    muAfter: null,
    sigmaAfter: null,
    privateProfile: true,
  };
}

/** One roster entry with every rating field blanked — what a private player's
 * own games table shows of them (the name, side and result stay). */
function redactRating(p: WirePlayer): WirePlayer {
  return {
    ...p,
    barSkill: null,
    losBefore: null,
    tier: null,
    losAfter: null,
    losDelta: null,
    muBefore: null,
    sigmaBefore: null,
    muAfter: null,
    sigmaAfter: null,
  };
}

/**
 * A game_players row's shown LOS before / after the game: rookie handicap
 * applied for the games behind each state (game_number − 1 before, game_number
 * after; game_number is 1-based). Null when the row has no rating.
 */
function losBeforeOf(r: Record<string, SqlStorageValue>): number | null {
  if (r.mu_before == null || r.sigma_before == null) return null;
  return shownLosOf(Number(r.mu_before), Number(r.sigma_before), gamesBehind(r) - 1);
}

function losAfterOf(r: Record<string, SqlStorageValue>): number | null {
  if (r.mu_after == null || r.sigma_after == null) return null;
  return shownLosOf(Number(r.mu_after), Number(r.sigma_after), gamesBehind(r));
}

/** Shown LOS after − before (so a rookie's Δ includes the handicap shrinking). */
function losDeltaOf(r: Record<string, SqlStorageValue>): number | null {
  const before = losBeforeOf(r);
  const after = losAfterOf(r);
  if (before == null || after == null) return null;
  return after - before;
}

/** The row's game_number (NaN when NULL — rookieHandicap(NaN) is 0). */
function gamesBehind(r: Record<string, SqlStorageValue>): number {
  return r.game_number == null ? NaN : Number(r.game_number);
}
