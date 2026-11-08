# LOS on Cloudflare — data model design

**Status: implemented** — `src/los/` (`losGames.ts` pure logic, `losDO.ts` the
DO, `index.ts` the routes). Originally its own "lavaos" Worker
(`wrangler.lavaos.toml`, deleted); the routes and the LosDO are now part of
the main lavabalance Worker (`cloudflare.config.ts`, `pnpm run deploy`), with the
lavabalance.fogofwar.dev custom domain routed there — public URLs unchanged. Where
the text below says "the Worker", read "the LOS routes of the lavabalance
Worker". One deviation from the text below: the API is
currently **unauthenticated** (including upload and reset) — auth is
deliberately deferred. Verified against the real August 2026 data: the full
month uploaded through the live Worker produces a leaderboard byte-identical
to `pnpm run lavaos:los` over the same day files (2,013 players, every
mu/sigma/los/games/wins equal; ordering differs only within exact-tie groups,
where the API tiebreaks by user_id).

Design for serving **LOS** (lava OpenSkill, `src/lavaos/`) publicly on the
Cloudflare platform. The Worker does **no scraping**: game results are pushed
to it through an **upload endpoint**. In production the pusher is barreplay's
lava sync (`mabn/barreplay`, `worker/src/worker/lavasync.ts`), which offers each
lava game as its own mirror learns of it; `pnpm run lavaos:scrape` piped in by
hand is the backfill path. The service stores, rates, and serves.

Features this model must serve:

1. **Player ranking** with paging (what `pnpm run lavaos:los` prints today).
2. **List of games played** (newest first, paged).
3. **Game detail**: the 16 players, which side won, how each player's LOS
   changed in that game.
4. **Per-player LOS over time** — a chart series.
5. **Upload endpoint**: accepts an array of game results; only *new* games
   enter the LOS calculation — a game older than the fold head is stored but
   marked **ignored** (no recomputation, ever); the response says per game
   whether it was rated or ignored. Ineligible games (no winner, bots, …) are
   reported in the response but **not stored at all** — which is why an
   automated producer has to remember what it has offered rather than read that
   back off this API; see the upload-contract bullets in `../CLAUDE.md`.

This document is the data model + the upload contract that keeps it correct.
UI and exact route shapes are sketched only far enough to prove the model
serves them.

## The one property that shapes everything

OpenSkill is **sequential and path-dependent**: each rated game transforms the
(μ, σ) of its 16 players, and every later update depends on every earlier one.
`tools/lavaos/los.ts` is literally a fold over games in `startTime` order.

So the core of the model is an **ordered, append-only log of rated games with
per-player before/after rating snapshots**, and the fold **only ever moves
forward**. All four read features are projections of that log:

- game detail's "how LOS changed" = the before/after pair stored on that
  game's rows — no recomputation, ever;
- the player chart = that player's `after` values in time order;
- the ranking = the latest `after` per player, materialized in a `players`
  table (which is exactly the fold's running state);
- and forward-only is what makes the upload contract simple: a game that
  starts before the last rated game *would* require refolding everything after
  it, so instead it is stored and marked **ignored** — an explicit, queryable
  fact rather than a silent divergence from the canonical chronological fold.

The uploader keeps the verbatim source data (the scraper's `data/YYYY-MM-DD
.json` day files); the service stores only its projection. That makes an
algorithm change (the rookie handicap is explicitly expected to be re-fitted)
a **reset + chronological re-upload**, not a server-side recompute — see
"Algorithm changes" below.

## Measured sizing (August 2026 data)

From the real August scrape (`data.tar.gz`, 30 days, full-map scrape of 15,981
Supreme Isthmus games, classifier applied):

| Quantity | Aug 2026 | ×12 (≈ full lobby history — onetricklava holds ~11.3k lava games ≈ 1 year) |
|---|---|---|
| Lava-lobby games | 800 (602 rated; ineligible — never stored: 117 no-winner, 67 bots, 10 not-8v8, 4 too-short) | ~11k games |
| `game_players` rows | 11,756 (9,632 on rated games) | ~180k rows |
| Distinct rated players | 2,024 (≥1 rated game) | ~5–10k (heavy month-to-month overlap) |
| Upload payload (verbatim replay JSON) | mean 75 KB/game raw, ×0.35 gzipped | a full-map day file ≈ 10 MB; lava-only ≈ 2 MB/day |

The SQLite projection is a few tens of MB per year — far below the 10 GB
SQLite-DO storage limit. Growth is ~25–30 games/day. No component of this
design is within two orders of magnitude of a platform limit.

## Storage: one SQLite-backed Durable Object

```
uploader (barreplay's lava sync in production; manual curl for backfills)
   │  POST /api/games  (bearer auth)  body = ReplayDetail[]
   ▼
Worker (Hono route) ──▶ LosDO.upload(games)     ── the ONLY writer
                              │
                              ▼
        LosDO (singleton, SQLite-backed — owns the projection)
          per game: classify (isLavaGame) → eligibility (unrateableReason)
          → order check vs fold head → rate() → one transactionSync
                              ▲
                              │  read RPCs (ranking / games / gameDetail /
                              │             playerHistory / search)
Worker HTTP routes (read-only, edge-cached)
```

One singleton `LosDO` — the same shape as `RatingsDO` (`idFromName("singleton")`,
`new_sqlite_classes` migration, RPC accessors) — holds both sides:

- **Writes**: the rating fold is inherently single-threaded, and a DO is a
  hard single writer. The fold state (`players`) and the log live in the same
  SQLite the fold runs against, so an upload is plain synchronous code inside
  one `ctx.storage.transactionSync()` — read participants, `rate()`, insert,
  upsert — with no cross-service batch API between the fold and its state.
  The DO's input/output gates mean no read can ever observe a half-applied
  upload, and two concurrent uploads serialize instead of interleaving.
- **Reads**: the Worker resolves `/api/*` through typed RPCs on the DO
  (`ranking(page, perPage, q)`, `games(cursor, limit, ratedOnly)`,
  `gameDetail(id)`, `player(userId)`, `playerHistory(userId)`,
  `searchPlayers(q)`). Each is one or two indexed queries over a small
  database — sub-millisecond in SQLite — so the DO round-trip dominates, and
  edge caching (below) keeps repeat traffic off the DO entirely.

Follow the project's established split: the DO class (imports
`cloudflare:workers`) in its own file, the pure helpers (per-game upload
decision, SQL row mapping) in a sibling module so they unit-test in the Node
pool, and the DO itself exercisable end-to-end under
`@cloudflare/vitest-pool-workers` like the Dispatcher replay test.

Durability: the DO's SQLite is durable and has point-in-time recovery, but it
is still a **projection** — the uploader's day files remain the source of
truth, and catastrophic loss (or a deliberate reset) is answered by
re-uploading, never by backup archaeology.

### The DO's SQLite — the schema

All durable state lives in these tables (not in the DO's KV storage), so there
is exactly one store to reason about and a reset wipes *everything*.

```sql
-- System state.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- keys: schema_version, algo_version, last_seq,
--       head_start_time, head_id   (the fold head = last RATED game's keys),
--       last_upload_at

-- One row per stored game. Only rateable lava games are stored: non-lava
-- and eligibility-ineligible games are reported in the upload response and
-- dropped, so every row has a winner and a full 8v8 roster.
CREATE TABLE games (
  id             TEXT PRIMARY KEY,   -- bar-rts replay id (opaque 32-hex — NOT time-sortable)
  seq            INTEGER UNIQUE,     -- dense 1..N position in the rating fold; NULL when status='ignored'
  start_time     TEXT NOT NULL,      -- ISO-8601 UTC (lexicographic = chronological)
  duration_ms    INTEGER NOT NULL,
  map            TEXT NOT NULL,      -- Map.scriptName
  engine_version TEXT,
  game_version   TEXT,
  winner_team    INTEGER NOT NULL,   -- 0|1 (see team convention below)
  status         TEXT NOT NULL,      -- 'rated' | 'ignored'
  uploaded_at    TEXT NOT NULL,
  unranked_reason TEXT,              -- 'off-map' | 'uploaded too late' | 'excluded'; NULL on rated games
  excluded       INTEGER NOT NULL DEFAULT 0,  -- 1 = an admin marked this game ignored (the games
                                     -- page's row menu). A marker FOR THE FOLD, not a rating
                                     -- change: rebase skips a marked game, and nothing else
                                     -- reads it. See "Ignoring a game" below.
  lobby          TEXT                -- verbatim JSON barreplay's lava sync rode on the upload
                                     -- ({lobbyName, lobbyDetails} — party roster inside); NULL
                                     -- when the upload carried none. Served by gameDetail only.
);
CREATE INDEX idx_games_time_id        ON games (start_time DESC, id DESC);
CREATE INDEX idx_games_status_time_id ON games (status, start_time DESC, id DESC);

-- One row per (game, participant): the roster AND the rating log in one
-- table. For rated games the row is the player's rating transition.
CREATE TABLE game_players (
  game_id      TEXT    NOT NULL REFERENCES games(id),
  user_id      INTEGER NOT NULL,     -- stable BAR account id: THE player identity
  team         INTEGER NOT NULL,     -- 0|1
  won          INTEGER NOT NULL,     -- denormalized from games.winner_team
  name         TEXT    NOT NULL,     -- lobby name AT GAME TIME (names change; userId doesn't)
  faction      TEXT,
  bar_skill    REAL,                 -- lobby-shown BAR OS, parsed from "[30.9]"
  bar_rank     INTEGER,              -- BAR chevron level AT GAME TIME (see below)
  start_time   TEXT    NOT NULL,     -- denormalized games.start_time (chart = single-table query)
  -- rating transition; all NULL unless the game's status='rated'
  game_number  INTEGER,              -- player's nth rated lava game, 1-based (rookie-handicap context)
  mu_before    REAL, sigma_before REAL,
  mu_after     REAL, sigma_after  REAL,
  PRIMARY KEY (game_id, user_id)
) WITHOUT ROWID;
CREATE INDEX idx_gp_player_time ON game_players (user_id, start_time);

-- The fold's running state = the current leaderboard. INVARIANT: a row
-- always equals the mu/sigma_after of that user's highest-seq rated game.
CREATE TABLE players (
  user_id      INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,        -- name from their most recent rated game
  mu           REAL NOT NULL,
  sigma        REAL NOT NULL,
  los          REAL NOT NULL,        -- max(mu - sigma, 0), stored so the ranking has an index
  games        INTEGER NOT NULL,     -- rated games only
  wins         INTEGER NOT NULL,
  first_played TEXT NOT NULL,
  last_played  TEXT NOT NULL,
  bar_os       REAL,                 -- last non-null lobby skill seen (may be stale, display-only)
  rank         INTEGER,              -- materialized TRUE leaderboard position over every player
                                     -- (1 = top; los DESC, user_id) — the admin's view
  public_rank  INTEGER,              -- position among RANKED players only; NULL otherwise.
                                     -- Both recomputed by every upload that rated a game
  private_profile INTEGER NOT NULL DEFAULT 0,
                                     -- 1 = hidden from the public site (admin-set). A READ FILTER,
                                     -- not access control: the fold still rates them and the roster
                                     -- rows are untouched, so the bot balances on their real rating
  inactive     INTEGER NOT NULL DEFAULT 0,
                                     -- 1 = no rated game in INACTIVE_DAYS (35), derived from
                                     -- last_played. Off the leaderboard, and hidden in NO other way
  ranked       INTEGER NOT NULL DEFAULT 1,
                                     -- = private_profile = 0 AND inactive = 0. Materialized because
                                     -- the tail keys on the OR-negation of that, and an OR cannot
                                     -- drive a range scan
  rank_change_7d INTEGER,            -- positions gained over RANK_HISTORY_DAYS (positive = UP the
                                     -- board, so it reads like the LOS one). Against the TRUE rank:
                                     -- public_rank is NULL for a private or lapsed player, so a
                                     -- delta over it would vanish exactly when someone lapsed
  los_change_7d  REAL                -- LOS gained over the same window. Both NULL when there is no
                                     -- snapshot that old to compare against
);
-- The whole leaderboard in order: the admin's page and the refreshRanks walk.
CREATE INDEX idx_players_ranking  ON players (los DESC, user_id);
-- The public ranking's HEAD: leading equality on `ranked`, the rest already in
-- leaderboard order — no sort, and not one unranked row read.
CREATE INDEX idx_players_ranked   ON players (ranked, los DESC, user_id);
-- Its TAIL, in the order it is served: most recently seen first. Paged in SQL
-- through this, because it holds every lapsed player — most of a mature store.
CREATE INDEX idx_players_unranked ON players (ranked, last_played DESC, user_id);
CREATE INDEX idx_players_name     ON players (name COLLATE NOCASE);
-- The board ordered by what MOVED, one index per DIRECTION. These are why the
-- two changes are COLUMNS rather than a join against rank_history per read: an
-- ORDER BY over a joined snapshot can only ever be a sort of the whole table.
-- Two per column rather than one read backwards (see "Sorting the ranking"),
-- and leading with `ranked` because that is the list every visitor loads: the
-- public ranking's head. See "Sorting the ranking" for the admin exception.
CREATE INDEX idx_players_los_change_desc  ON players (ranked, los_change_7d IS NULL, los_change_7d DESC, user_id);
CREATE INDEX idx_players_los_change_asc   ON players (ranked, los_change_7d IS NULL, los_change_7d ASC,  user_id);
CREATE INDEX idx_players_rank_change_desc ON players (ranked, rank_change_7d IS NULL, rank_change_7d DESC, user_id);
CREATE INDEX idx_players_rank_change_asc  ON players (ranked, rank_change_7d IS NULL, rank_change_7d ASC,  user_id);

-- Row counts the pages show as totals, maintained by the upload so no read
-- ever pays a COUNT(*) scan. Keys: players, players_ranked (the leaderboard's
-- length — the rest are its rankless tail), games (every stored game),
-- games_rated.
CREATE TABLE counts (
  key TEXT PRIMARY KEY,
  n   INTEGER NOT NULL
);

-- One day's leaderboard, kept so the ranking can say what MOVED. `rank` is the
-- TRUE position over every player (matching players.rank — see the change
-- columns above for why not public_rank); `los` is that day's rating.
-- (day, user_id) is the key because every read is "one day's rows": loading the
-- baseline is a range over the day, and picking WHICH day is a MAX() seek down
-- the same index.
CREATE TABLE rank_history (
  day     TEXT    NOT NULL,          -- UTC calendar day, "YYYY-MM-DD"
  user_id INTEGER NOT NULL,
  rank    INTEGER NOT NULL,
  los     REAL    NOT NULL,
  PRIMARY KEY (day, user_id)
) WITHOUT ROWID;
```

**Derived data (`rank`, `counts`) is written by the upload, never by a read.**
Durable Object SQLite is billed per row read, so a `COUNT(*)` or a correlated
"how many players are above me" walk on every page view cost the whole table
per request (measured on the August 2026 data: ~2,000 rows per ranking page,
~24,000 per ranking search, ~2,300 per player page). Now the upload — the
single writer — bumps `counts` inside its transaction and, when a game was
rated, re-walks `idx_players_ranking` once and rewrites only the ranks that
moved (`refreshRanks`); a ranking page reads its 50 rows + 1, a player page
its row + its rank + the roster rows. A store from before these existed is
migrated on the first construction after the deploy (`ensureDerived`: adds
the columns, seeds `counts`, computes every rank — one full scan, once).

**What moved (`rank_history` + the two change columns).** The ranking page's
two Δ columns ask a different question of the same list — not who is
best, but who is *climbing* — and answering it needs a past to compare with,
which a fold that only ever holds the present does not have. So `refreshRanks`,
already walking the whole board after every rated game, also:

1. **Records one snapshot per UTC day.** The first run once the clock has passed
   midnight stamps the state it has just derived with the day that ENDED
   (`recordDailySnapshot`) — it ran just after a game, so that state is what the
   day finished with. Once per day, not per game: "the board on the 3rd" has to
   mean one thing. A day nobody uploaded on gets no row, which is why the
   baseline lookup takes the newest day *at or before* its target rather than
   that exact day. The same call prunes past `RANK_HISTORY_RETENTION_DAYS` (60)
   — it is the only thing that adds to the table and it runs once a day, which
   is the retention's own step.
2. **Measures the two changes against it.** The baseline is the newest snapshot
   at or before `today − RANK_HISTORY_DAYS` (7) and no older than
   `RANK_HISTORY_MAX_AGE_DAYS` (14) — past that there is none, and both changes
   are NULL, which is also what every player gets for the store's first week. A
   "7-day change" measured over three days would be a different number wearing
   the same label.

Both are then columns on `players`, indexed, for the same reason `rank` is: the
list may want to be ORDERED by them, and an expression over a snapshot joined
per read cannot be. Positive is better in both — an improvement is a *smaller*
rank, so the rank subtraction goes `was − now`.

`POST /api/rank-history/rebuild` (the tab's admin button) redraws the last
`RANK_HISTORY_REBUILD_DAYS` (8) days from the game log and re-derives the
columns from them: the repair for a day nobody played on, a day whose first game
came late enough that "yesterday's state" had some of today in it, and a store
that only grew the table this morning. It **rewinds** rather than re-folds —
`players` already holds the present exactly and `game_players` holds every rated
game's μ/σ *before* it, so the board at a past instant is the board now with
every game since undone, walking newest-first so each player lands on the state
before their earliest game after the cut. No rating is recomputed, the OpenSkill
fold is never re-run, and undoing somebody's *first* rated game removes them
from the board entirely — before it they were not on it.

**Sorting the ranking.** `GET /api/ranking?sort=&dir=` orders the list by any
of its sortable columns, either way round: `rank`, `los`, `rankChange`,
`losChange`, with `dir` `asc`/`desc`. Anything unrecognized falls back to the
leaderboard rather than 400ing (a stale or hand-written URL should still answer
with a list), and the response echoes what it actually used. `rank` and `los`
are the same ordering under two names — `rank` is materialized FROM `los` — so
"# ascending" and "LOS descending" are one list; each header still reads
naturally on its own terms, which is why both keys exist.

Two properties survive every sort:

- **`rank` stays the player's STANDING**, never their place in the sorted page.
  A list ordered by what moved would otherwise silently renumber the board. This
  is the rule the name search has always followed ("mol" shows Molly as #37),
  and it is only possible because the position is materialized.
- **The public list's rankless tail is never sorted.** The head takes the
  requested order; the tail keeps its own (most recently seen first), because
  ordering those rows by a rating — or anything derived from one — would read as
  a ranking and, for the private rows whose rating is blanked, hand back exactly
  the standing the blanking removes.

Every one of the eight orderings is an index scan, never a temp b-tree
(`losCost.workers.test.ts` pins the plans), and the two kinds of column get
there differently:

- A **NOT NULL** column needs ONE index. `los DESC, user_id` read backwards is
  `los ASC, user_id DESC`, so the ascending clause flips the TIEBREAK too — an
  exact reversal is an index scan, anything else is a sort of the table, and
  which of two identically-rated players comes first is arbitrary either way.
- A **nullable** change column cannot do that. "No baseline" is not a small
  change and not a large one; it belongs at the END whichever way the column is
  read, which takes a leading `<col> IS NULL` key — and reversing an index
  reverses that key too, putting the unknowns back on top. So each change column
  carries an index per direction, both scanned forwards. Both lead with
  `ranked`, like every other ranking index, because that is the list every
  visitor loads — the public ranking's head. The ORDER BY must repeat the
  `IS NULL` expression exactly as the index declares it or the planner sorts the
  table instead.

The **admin view** (`?includePrivate=true`) is the one documented exception: it
is a single flat list over everyone, so a sort by a change column has no leading
`ranked` to seek on and SQLite sorts the table. That is a couple of thousand
rows on a maintainer's click, not a scan on anything polled — the trade every
human-initiated read here is allowed — and `losCost.workers.test.ts` asserts it
so the exception stays deliberate rather than being discovered. Four more
indexes would remove it if it ever mattered.

**Inactive players.** `players.inactive` = no rated game in `INACTIVE_DAYS`
(35), derived from `last_played`. It takes a player off the leaderboard and
does nothing else: no rank, but the rating, record, chart, games and profile
stay as public as anyone's. `refreshRanks(now)` derives it in the same single
walk that writes both ranks and `counts.players_ranked` — `last_played` is an
ISO instant, so the string compare against a `now − 35 days` cutoff IS the date
compare. Uploads, `setPrivateProfile` and `rebase` all call it; so does
`sweepActivityIfDue()` from the ranking and player reads, because a player
lapses when NOTHING happens and no write can notice — a stored
`activity_swept_at` holds that to one walk per 6h however much traffic
arrives.

**Private profiles.** `POST /api/players/:userId/private` `{"private": true|false}`
sets `private_profile`; `setPrivateProfile` flips the flag, bumps
`players_private` and re-runs `refreshRanks` in one transaction, since hiding a
player shifts everyone below them. A hidden player is still LISTED on
`/api/ranking` — last, after every ranked player, in a name-ordered tail with
`rank` and every rating field null — and `/api/players/:id` (name +
`privateProfile: true` only), `…/history` (no points) and `…/games` (rows kept,
this player's ratings nulled) serve no rating. Their entry in any **game
roster** (`/api/games`, `/api/games/:id`, and the rosters inside `…/games`) is
blanked too, `privateProfile: true` marking it, but **keeps `losDelta`** — a
change says nothing about the rating it moved. The game-level numbers are taken
from the full roster BEFORE the blanking, so they read the same for everyone:
`predictedWin`, and `avgLosBefore` (each team's mean pre-game LOS, served
precisely so a page never averages a roster that has had a member blanked out
of it — the difference between a seven- and an eight-man mean would be the
hidden rating). `?includePrivate=true` on any of these is the admin view (open,
`Cache-Control: no-store`), and its ranking is the true list: hidden players in
their real places with their real `rank`. A
**rebase** drops and recreates `players` rows, so it snapshots the hidden ids
first and restores the flag before recounting.

Game `status`, the upload contract made durable:

- **`rated`** — entered the fold; has a `seq` and full before/after snapshots
  on its `game_players` rows.
- **`ignored`** — a game that *would* have been rated, but arrived after the
  fold had already moved past its `start_time`. Stored with its roster;
  rating columns stay NULL. Permanently unrated under the current fold — only
  a reset + chronological re-upload incorporates it.

**Ignoring a game** (`POST /api/games/:id/ignored` with `{"ignored": true|false}`
— the games page's admin row menu) writes the `excluded` marker and NOTHING
else: no rating is re-folded, no count moves, `status`, `seq` and every stored
mu/sigma stay exactly as they are. Dropping a rated game's contribution means
re-running the fold over every game after it, which is what the rebase below
does and what the row's other menu entry is — so the two are separate, and an
admin can mark a batch of games and re-run once from the earliest of them. Until
that re-run the marker is a statement of intent: the response's `needsRebase`
says whether the marker and the ratings currently disagree, and the page badges
a marked-but-still-rated game "ignored · pending". A rebase honours the marker
whatever the game's map, and whether or not it opted into off-map games (an
exclusion is a decision, not a map verdict), recording `unranked_reason =
'excluded'`; clearing the marker and re-running puts the game back exactly as it
was. `excluded` is never set by an upload and survives every rebase.

Games that the map-independent eligibility rules exclude
(`eligibilityReason`: no winner, bots, not 8v8, too short) are **not
stored** — they are reported as `skipped` in the upload response and
dropped, exactly like non-lava games except that the uploader is told why.
The MAP is not one of those rules any more: an off-map lava game passing
them is stored **unranked** (status `ignored`, upload reason `"off-map"`)
without touching the fold. Every ignored row records WHY in
`games.unranked_reason` (`'off-map'` | `'uploaded too late'` | `'excluded'`; NULL on rated
rows — pre-column ignored rows were backfilled `'uploaded too late'`, the
only way they could have been stored), served as `unrankedReason` on the
list and detail and shown as the unrated badge's tooltip. A game unranked
as `'uploaded too late'` is recoverable: `POST /api/games/:id/rebase`
(LosDO.rebase — "Re-run LOS from here" in the games table's admin-only row
menu, whose dialog asks whether to also rate off-map games; body
{includeOffMap:true}, default off) re-runs the fold from that game's (start_time, id) position over
every stored game after it — judging off-map by the STORED MAP
(isRatedMapName), never the reason label, so a mislabelled row is repaired
and a default re-run resets a wrongly-rated off-map game to unranked — reconstructing each affected player's prior state from their
last rated game before the point (the per-game mu/sigma transitions are
that history), so the result is identical to having uploaded everything
chronologically — the workers suite pins that equality. Off-map games stay
ignored through a rebase; rebasing needs no external data at all — the rated set is still gated on Supreme
Isthmus via `unrateableReason`, which the offline oracle keeps using.

Deliberate denormalizations (each bought a one-query feature):

- `game_players.start_time` — replay ids are opaque hashes, so per-player time
  ordering needs the game's time; copying it makes the chart a single indexed
  scan with no join. ~25 bytes × 180k rows.
- `game_players.won` — the chart and player game-history want W/L without
  joining `games`.
- `game_players.bar_rank` — BAR's chevron level for that account on the day of
  that game (0..7), straight off the replay's `Player.rank`. It is the only
  reading of a player's BAR-WIDE experience anything here can get: under BAR's
  "Role" rank method it buckets in-game hours (0: <5h, 1: 5h, 2: 15h, 3: 100h,
  4: 250h, 5: 1000h), with 6 and 7 reserved for contributors and tournament
  winners, so it says roughly how long someone had been playing BAR before
  this lava game — which LOS, being lava-only, cannot. It lives on the game
  row rather than on `players` because it is a SNAPSHOT: teiserver recomputes
  a chevron at login, so what it was that day is unrecoverable afterwards,
  where the current value is always one API call away. NULL means the replay
  stated no rank, or the row predates the column: `migrateColumns` adds it
  and it is the one migrated column `ensureDerived` does NOT rebuild, since
  only the upload carries it and an older row has no source. 0 is a REAL
  level and must never be read as "unknown". Rows that predate the column
  cannot be repaired from inside the service (only an upload carries the
  field, and re-uploading a stored game is a no-op), so the backfill runs SQL
  straight against the Durable Object: `pnpm run lavaos:backfill-ranks --dry`,
  see `tools/lavaos/backfill-ranks.ts`.
- `players.los` — derivable from μ−σ, but the ranking needs `ORDER BY` on it;
  an indexed real column beats computing-then-sorting every page load.
  (`leaderboardRating` = max(μ−3σ,0) and `losses` = games−wins stay derived at
  read time — nothing orders by them.)
- `seq` — the fold order made explicit. Assigned densely (1, 2, 3…) to rated
  games in `(start_time, id)` order. It is the tie-break for identical
  timestamps and the cheap "did anything change" etag (`meta.last_seq`).

Team convention: `team` ∈ {0, 1} is the game's position in its non-empty
`AllyTeams` sorted by the *ally-team-level* `allyTeamId` (0/1 in the data).
The player-level `allyTeamId` field is an API-internal row id (e.g. 5825596)
— never use it.

Rows in `players` exist only for users with ≥1 *rated* game; participants of
ignored games appear in `game_players` (roster display) but don't get a
leaderboard identity until a rated game.

## The upload endpoint

```
POST https://lavabalance.fogofwar.dev/api/games
                               (bearer token secret — the project's CONTROL_TOKEN auth pattern)
Content-Type: application/json
body: ReplayDetail[]           (verbatim api.bar-rts.com format — EXACTLY the
                                scraper's day-file content, so
                                `curl --data-binary @data/2026-08-15.json` works)
```

The Worker route forwards the array to `LosDO.upload(games)`. Inside the DO,
per upload:

1. **Sort the batch** by `(start_time, id)` ascending — a batch is allowed to
   contain any mix of days in any order; sorting makes intra-batch order
   irrelevant.
2. **Per game, decide** (pure function, unit-testable in the Node pool):
   - already in `games` → **`duplicate`**: no-op, previously stored verdict
     stands (re-uploading an ignored game does not resurrect it);
   - `!isLavaGame` → **`rejected`**: not stored (the uploader may be feeding
     full-map day files; the classifier gates every game);
   - `eligibilityReason` ≠ null → **`skipped`**: not stored either — reported
     with the reason so the uploader sees why, then dropped;
   - else, if off the rated map (not Supreme Isthmus) → **`ignored`** with
     reason `"off-map"`: stored with roster, no rating columns, fold and
     head untouched;
   - else, if `(start_time, id) ≤ (meta.head_start_time, meta.head_id)` →
     **`ignored`**: stored with roster, no rating columns;
   - else → **`rated`**: fold it — read the participants' current `players`
     rows, apply `rate()` on `losEffectiveRating(state, games)` exactly as
     `los.ts` does, write the `game_players` transitions, upsert `players`,
     advance `seq` and the fold head.
3. **Commit the whole batch in one `transactionSync`** — readers see the
   pre-upload or post-upload state, nothing between; a failed upload changes
   nothing and is safe to retry verbatim (duplicates make retries idempotent).
4. **Respond** with the per-game outcome the uploader needs:

```jsonc
{
  "rated":     ["<id>", ...],                 // entered the LOS fold, in fold order
  "ignored":   [{ "id": "<id>", "startTime": "...", "headAt": "..." }, ...],
  "skipped":   [{ "id": "<id>", "reason": "no winning team" }, ...],  // NOT stored
  "duplicate": ["<id>", ...],
  "rejected":  ["<id>", ...],                 // not lava — not stored
  "lastSeq": 615, "players": 2031             // post-upload fold state summary
}
```

Notes on the contract:

- **Only the order *across uploads* matters.** Upload whole days newest-last
  and nothing is ever ignored; upload a forgotten old day after a newer one
  and its rateable games come back `ignored` — the response makes the mistake
  visible immediately, and the fix (if the games matter) is the reset flow
  below.
- **Retries stay idempotent without dedup rows for dropped games**: stored
  games (rated/ignored) come back `duplicate`; a skipped or rejected game
  isn't in the database, so a retry simply re-classifies it to the same
  verdict — same response, still nothing stored.
- Batch size: a full lava day (~25 games) or even a full-map day file (~530
  games, ~10 MB) folds in well under a second of CPU — `rate()` is
  microseconds and all writes are local synchronous SQLite. One day file per
  request is the recommended granularity; nothing breaks at a month.

## Algorithm changes (and other resets)

The service never holds the verbatim replays, the uploader does, so the
original path for an algorithm change was a reset + re-upload. Since the
rebase exists (`POST /api/games/:id/rebase` re-runs the fold from one stored
game onward, from the stored inputs), **a rebase from the very first stored
game is a full refold under the current code** and is the cheaper route: no
upload, one admin call, and it stamps the new `algo_version` in `meta`. That
is how ALGO_VERSION 2 (the 2026-09-16 rookie-handicap curve) and 3 (its 2026-09-27 refit) were applied.
When `algo_version` changes (rookie handicap re-fit, τ change, eligibility
change) and a rebase will not do — or ignored games have piled up and should
be incorporated:

1. `POST /api/reset` (bearer auth, explicit confirmation param) — drops
   and recreates all tables, records the new `algo_version` in `meta`.
2. Re-upload the day files chronologically (a trivial loop in the external
   tool; the full ~11k-game history is a few hundred requests or a handful of
   month-sized ones, minutes end-to-end).

`tools/lavaos/los.ts` doubles as the verification: run it locally over the
same day files and diff its leaderboard against `/api/ranking` — same
inputs, same fold, byte-equal μ/σ expected.

## How each feature maps to queries

(Each read RPC on the DO is one or two of these.)

**1. Ranking (paged)** — mirrors `pnpm run lavaos:los`. **The public ranking
includes every player except the hidden ones** (every `players` row has ≥1 rated
game; there is no `minGames` filter any more — the total is the maintained
count minus the maintained hidden count, not a scan):

```sql
SELECT n FROM counts WHERE key = 'players';   -- and 'players_ranked': the split point
SELECT user_id, name, mu, sigma, los, games, wins, last_played, bar_os,
       rank, public_rank, private_profile, inactive
FROM players
WHERE ranked = 1                              -- idx_players_ranked: no sort, no unranked row read
ORDER BY los DESC, user_id
LIMIT :perPage OFFSET :offset;                -- rank = offset + row index + 1
```

A **search** never runs that query: it reads its matches once through
`idx_players_name` (no `ORDER BY`, which would let the planner prefer a ranking
index and walk the table instead of the match) and partitions, orders and pages
them in JS. Once a page reaches past the ranked players it pages the TAIL the same way —
`WHERE ranked = 0 ORDER BY last_played DESC, user_id` through
`idx_players_unranked` — and serves those rankless: a private row also has its
rating blanked, a merely lapsed one does not. The admin view
(`?includePrivate=true`) instead drops the `WHERE` altogether and takes `rank`
from the column: one list in its true order. A **search** pages over the matches
but keeps each row's global position, so it reads `public_rank` (or `rank`)
rather than counting from the offset.

OFFSET paging is fine at ≤10k rows; the `(los DESC, user_id)` index makes it
an index walk. `mu`/`sigma` in the payload let the UI show μ, σ, and
`leaderboardRating` without extra columns.

**2. Games list (paged, newest first)** — keyset paging, stable under inserts
because rated games only prepend:

```sql
SELECT * FROM games
WHERE (start_time, id) < (:afterTime, :afterId)   -- omit on first page
ORDER BY start_time DESC, id DESC LIMIT :n;

SELECT game_id, user_id, name, team, won, mu_before, sigma_before, mu_after, sigma_after
FROM game_players WHERE game_id IN (:pageIds);    -- one 2nd query, ≤16×n rows
```

**Ignored games are visible by default**: the wire shape carries a boolean
`ignored: true|false` on every game (serialized from `status`) plus `excluded`
(the admin's marker, which is independent of it — see "Ignoring a game"), so the
UI can badge them without a separate query mode. An optional `rated=true` filter
(backed by `idx_games_status_time_id`) narrows to fold games only. Ineligible
games (false starts, bot games) never made it into the table, so the list is
all-real-games by construction.

**3. Game detail** — the game row + its ≤16 `game_players` rows. Per player:
`losBefore = max(mu_before − sigma_before, 0)`, same for after, delta = the
difference — pure arithmetic on stored columns. `game_number` lets the UI mark
rookie-handicapped players (games 1–3). Because `src/lavaos/` is Worker-safe,
the RPC can also compute the *pre-game predicted win chance* on the fly with
`predictWin` over the `_before` ratings (+ `losEffectiveRating` with
`game_number − 1` prior games) — no extra storage.

**4. Player chart** — one indexed single-table scan:

```sql
SELECT game_id, start_time, game_number, won,
       mu_after, sigma_after                     -- point = max(mu−sigma, 0), band = sigma
FROM game_players
WHERE user_id = :id AND mu_after IS NOT NULL
ORDER BY start_time;
```

Worst realistic case ≈ a few hundred rows (143 games was August's max);
no downsampling needed. The same query `DESC LIMIT 20` is the profile page's
recent-games list, and the profile's rank is the materialized `players.rank`
(one row read; formerly a correlated count that walked the ranking index up to
the player's position).

Name search (`searchPlayers(q)`) hits `idx_players_name`; past aliases are
recoverable ad hoc via `SELECT DISTINCT name FROM game_players WHERE user_id=?`
— no extra table until a real need shows up.

## Serving & caching

LOS is its **own Worker** on the custom domain **`lavabalance.fogofwar.dev`** —
not part of the lavabalance Worker. It lives in the lavabalance package (a
second wrangler config next to `wrangler.toml`, e.g. `wrangler.lavaos.toml`
with the custom-domain route, the `LOS` DO binding + its
`new_sqlite_classes` migration, and the upload bearer-token secret) so it
imports `src/lavaos/` directly and shares the toolchain; nothing else is
shared — the bot and LOS deploy and scale independently, and `/` is free for
the future LOS UI pages. Routes (Worker → `LosDO` RPC):

| Route | DO RPC / backing queries |
|---|---|
| `POST /api/games` (auth) | `upload(games)` — the write path above |
| `POST /api/reset` (auth) | `reset(algoVersion)` — wipe for re-upload |
| `GET /api/ranking?page&perPage[&q]` | `ranking(…)` — ranking pair above (everyone with a rated game; `minGames` was removed); `q` = name-prefix filter (range scan on `idx_players_name`, global rank from the materialized `rank` column) |
| `GET /api/games?after&limit&rated` (or `?page&limit&rated`) | `games(…)` — keyset page (or a numbered OFFSET page for the Games UI) + roster batch, with `total`; each game carries `ignored` |
| `GET /api/games/:id` | `gameDetail(id)` — game + its `game_players` + the stored `lobby` JSON (null when the upload carried none) |
| `GET /api/players/:userId` | `player(id)` — `players` row + rank + recent games |
| `GET /api/players/:userId/history` | `playerHistory(id)` — chart scan |
| `GET /api/players/:userId/games?page&limit` | `playerGames(id, …)` — numbered OFFSET page of that player's games (list shape + own transition), with `total` |
| `GET /api/players?q=` | `searchPlayers(q)` — name search |
| `POST /api/players/:userId/private` | `setPrivateProfile(id, private)` — hide/unhide a profile (flag + `players_private` + `refreshRanks`, one transaction) |

The four player/ranking reads take **`?includePrivate=true`** — the admin view,
which serves the hidden profiles whole; it is answered `no-store` rather than
cached, so a hidden profile never reaches the next reader from the edge.

Because every read pays a Worker→DO hop to a single location, edge caching is
part of the design, not an optimization: data changes only on upload, so the
Worker caches each GET response (Cache API / `Cache-Control: max-age=60`,
ETag = `algo_version:last_seq`) and the DO sees roughly one request per route
per cache TTL regardless of traffic. Payloads are small (a ranking page ≈ a
few KB; the largest, a 143-game chart series, ≈ 20 KB).

## Alternatives considered

- **Server-side ingest** (a cron/alarm-driven pipeline scraping onetricklava
  + api.bar-rts.com, with verbatim replays archived to R2 and recompute on
  out-of-order arrival): self-feeding and able to refold server-side, but it
  duplicates the scraper that already exists and works, adds R2 + scheduling
  + politeness machinery to operate, and recompute-on-out-of-order makes
  upload cost unbounded. The upload model keeps the Worker passive, reuses
  the local scraper verbatim, and bounds every upload at O(new games); the
  cost is that late games are `ignored` until a reset — explicitly accepted.
- **D1 for the projection** (same schema, writes batched from the DO): buys
  direct Worker-side queries with no DO hop, read replicas, and `wrangler d1`
  inspection/export. Not chosen: it splits the fold from its state across a
  service boundary (every upload becomes a remote batch instead of a local
  transaction), adds a second stateful service, and diverges from the
  codebase's established DO-SQLite pattern (`RatingsDO`, Dispatcher) —
  including its `vitest-pool-workers` test story. At this read volume, edge
  caching neutralizes the latency argument. The schema is identical, so
  migrating later is mechanical if read patterns ever outgrow one DO.
- **Storing verbatim replays in the DO** (a gzipped BLOB per game, enabling
  server-side recompute): ~300 MB/year of blobs inside the projection for a
  capability the reset + re-upload flow already provides more simply, given
  the uploader necessarily has the source files. Revisit only if uploads ever
  come from a source that doesn't retain data.
- **Precomputed JSON in KV/R2** (ship `los.json` pages): handles the ranking,
  but per-player history and game paging would mean materializing thousands
  of documents on every upload, and any new view is another materialization.
  A relational projection is the same work done once.
- **Store only current ratings, derive per-game deltas on demand**:
  path-dependence makes "on demand" mean refolding history per request.
  Rejected; the log costs ~180k small rows.

## Resolved decisions

Formerly open questions, decided 2026-08-31:

- **Ranking includes all players** — every user with a rated game. (A
  `minGames` parameter existed until 2026-09-01; it was removed so the total
  can be the maintained count rather than a filtered scan.)
- **Ignored games are visible by default** in the games list, flagged with
  `ignored: true` on the wire.
- **Separate Worker** on the custom domain **`lavabalance.fogofwar.dev`** (see
  Serving above), not part of the lavabalance Worker.
- **No gzipped upload bodies for now** — plain JSON only; revisit only if
  month-sized uploads become the norm.
- **No seasons** — one rating bucket, matching LOS today. (If that ever
  changes: a `season` column on `games`/`game_players` plus a per-season
  `players` table; the uploader's day files already contain everything
  needed.)
