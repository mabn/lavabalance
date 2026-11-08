# src/los — LosDO store + LOS public API

## OVERVIEW
Singleton `LosDO` (SQLite: games, game_players, players, meta, counts, rank_history) and the `losApp` Hono routes mounted into the main Worker.

## WHERE TO LOOK
| Task | Location | Notes |
|---|---|---|
| Schema, upload, rebase, reads | `losDO.ts` | single writer; also hosts avoids, polls, scout, auth sessions, game starts |
| Fold step, classify, `ALGO_VERSION`, `shownLosOf` | `losGames.ts` | pure, Node-pool testable |
| Routes, admin gate, caching, `losStub` | `index.ts` | `view()` = admin body or `stripLos(body)` |
| Tiers, hysteresis, `stripLos`, `LOS_KEYS` | `tiers.ts` | cutoffs fitted 2026-11-01 |
| Schema / upload contract / endpoints | `docs/lavaos-cloudflare-data-model.md` | start here |
| Store tests | `test/los.workers.test.ts`, `test/losFixtures.ts` | workerd pool |
| Row-cost guard | `test/losCost.workers.test.ts`, `test/sqlstats.workers.test.ts` | rows read per route + query plans |
| Pure-logic tests | `test/losGames.test.ts`, `test/tiers.test.ts` | unit pool |
| Deployed-store repair | `tools/lavaos/backfill-ranks.ts`, `backfill-start-metal.ts` | SQL on the DO / duplicate re-upload |

## CONVENTIONS
- Everything goes through `losStub(env)` (`idFromName("singleton")`); LosDO is the only writer. Upload commits each batch in one `transactionSync`.
- Fold is forward-only. Behind the fold head → stored as `ignored` ("uploaded too late"); `skipped`/`rejected` are stored nowhere. Producers track what they offered.
- Duplicate upload only backfills NULL columns (`lobby`, `start_metal_storage`); never touches the fold.
- `ALGO_VERSION` lives in `meta.algo_version`; only a rebase from the oldest game (`POST /api/games/<first id>/rebase`) restamps it. Re-fit tier cutoffs after a version change.
- Rebase refolds from stored rows only: honours `games.excluded`, re-judges off-map by stored map, 409s while a post-cutoff game lacks `start_metal_storage`, snapshots + `restorePrivate`s hidden players (it recreates `players`).
- Displayed LOS = `shownLosOf` = max(μ − handicap − σ, 0) on every wire field and bot message. `players.los`, leaderboard order, `rank_history`, `los_change_7d` stay on raw μ − σ.
- Tiers: `players.tier` updated with hysteresis inside `upsertPlayer` (`DEMOTE_MARGIN`); a past roster's tier = plain cutoff of `losBefore`.
- LOS is admin-only: non-admin bodies go through `stripLos` server-side (nulls every `LOS_KEYS` field at any depth; `tier` kept). Visitors' `/api/ranking` is forced to `sort=tier`. The bot reads real ratings via `/api/bot/players/lookup`.
- Admin view = `?includePrivate=true` granted only to an admin; answered `no-store`. Public GETs `max-age=60`.
- Game-level numbers (`predictedWin` — computed on read, never stored —, `avgLosBefore`, `teamStats`) come from full ratings BEFORE private/LOS blanking.
- Derived data (`counts`, `rank`/`public_rank`/`ranked`/`inactive`, `rank_history`) is written by upload (`bumpCount`, `refreshRanks`) or admin rebuild — never by a read.
- Constructor order is load-bearing: `ensureSchema` → `migrateColumns` → `ensurePlayerIndexes` → `ensureDerived(added)`. New column = `migrateColumns` entry; index on it goes in `ensurePlayerIndexes`, not the CREATE TABLE.
- Each ranking ORDER BY must be an index scan; nullable change columns need one index per direction with the `IS NULL` key repeated verbatim.
- `reset()` drops `counts` and `rank_history` too.
- Tests: start each with `POST /api/reset?confirm=true` (pool SQLite persists); fixture dates are relative to today (`day()`/`staleDay()`), so `INACTIVE_DAYS` cannot lapse them.

## ANTI-PATTERNS
- A second writer, or writing LOS SQL from outside LosDO (repair tools are the documented exception).
- A read whose rows-read tracks table size — invisible in JSON, caught only by `losCost.workers.test.ts` / `/api/sqlstats`. Update its pinned numbers deliberately, never to make it pass.
- `CREATE INDEX` in `ensureSchema` on a migrated column — throws on an old store and bricks the DO.
- Hiding LOS only in the page; any new LOS field must join `LOS_KEYS`.
- Averaging or ranking from a redacted roster — leaks hidden ratings by subtraction.
- Serving raw `losOf` where a player sees LOS, or ordering the leaderboard by `shownLosOf`.
- Hard-coded fixture dates in LOS tests.
- Setting `excluded` from an upload, or expecting the ignore toggle itself to move a rating.

# Reference

## Rank tiers: LOS is admin-only (since 2026-11-01)

Only an admin (Access superadmin, i.e. the `?includePrivate=true` admin view —
the page's `withAdmin`) sees LOS. Everyone else sees a **rank tier**:
Placing (under 5 rated games), Bronze (<12 shown LOS, the bottom ~half on
purpose), Silver 12, Gold 16, Platinum 21, Diamond 28+ — fixed cutoffs fitted to
the live population on 2026-11-01; re-fit them when ALGO_VERSION changes. No
special badge for the top players; only the ranking page shows order. All of it
is in `src/los/tiers.ts`.

- **Stored with hysteresis.** `players.tier` (index 0–5) is updated in
  `upsertPlayer`'s own statement: up at the cutoff, down only once shown LOS is
  `DEMOTE_MARGIN` (1.5) below it. Seeded once from the plain cutoffs
  (`seedTiers`, meta `tiers_seeded`); a rebase restarts from the plain tier at the
  rebase point. A tier for a past moment (a roster's "going into this game") is
  the plain cutoff tier of `losBefore`.
- **Server-side, not just hidden.** Every LOS read route (`src/los/index.ts`
  `view()`, and the lobby detail in `src/index.ts`) passes a non-admin body
  through `stripLos`, which NULLS every `LOS_KEYS` field however deep (los, μ/σ,
  losBefore/After/Delta, losChange7d, team averages…); `tier` stays. The history
  route serves no points outside the admin view.
- **The visitors' ranking is the tier board**: `/api/ranking` forces
  `sort=tier` (tier desc, then games desc; `idx_players_tier_ranked`) for a
  non-admin, whose `?dir=` only flips it. `rank` is the place on that board (a
  search match gets null: its place would need a count), `rankChange7d` is
  nulled, and `/api/players/:id` serves `rank`/`rankedOf` null — the leaderboard
  position is the LOS order. Admins keep the LOS leaderboard, both Δ(7d)
  columns, and can sort by `tier` too.
- **Rosters keep LOS order for visitors**: game teams are served sorted by
  `losBefore` (after blanking hidden players, who go last); lobby players carry
  `losOrder` (place by displayed LOS). The visitor page keeps that order.
- **Name colours**: like the lobby, past games colour names with BAR's
  two-team autocolor palette (`TEAM_COLORS` in SHARED_JS) by place in LOS
  before the game — row N of a team wears colour N (`teamTint`).
- **The bot** reads real ratings from `GET /api/bot/players/lookup` (bot Access
  service token, like `/api/bot/auth/*`); the public `/api/players/lookup` is
  stripped like everything else. Bot lines in the lobby chat still show LOS.
- **Pages**: emblems are SVG drawn client-side (`rankEmblem` in SHARED_JS;
  detail dropped under 32 px). Icon only on the lobby and game rosters (name in
  the tooltip), emblem + name on the ranking and the player card. Admins see the
  emblem beside the LOS pill and keep every LOS column, average and chart.


`/lobby/:id` shows **LOS** — OpenSkill over the LAVA lobby's own games (see
`src/lavaos/CLAUDE.md`) — instead of Lavabar (skyride) elos. The route resolves the
roster in ONE bulk RPC to the singleton LosDO (`src/losRatings.ts` →
`losStub(env).playersByNames(names)`, exact case-insensitive current-name match) and
applies it via `src/lobbyView.ts` (the HTTP equivalent,
`GET /api/players/lookup?names=a,b,c`, which is LOS-stripped for non-admins — see
"Rank tiers" above):

- per-player `los` (max(μ−σ, 0), 2-dp on the wire) / `losGames` / `losUserId` /
  `losHandicap` (the rookie mu discount, 0 once established — the LOBBY pill shows
  `los − losHandicap`, the value balancing/predictWin use, with a superscript (i)
  hint explaining the discount on rookies; rosters sort by that displayed value); null for
  a name LOS has never rated — balancing and the averages count them as
  **`UNRATED_LOS` ≈ 3.7** (a debutant's effective rating: μ25 − 13 rookie handicap − σ8.33),
  and the UI shows that assumed value as their pill with its own (?) hint;
- per-team `teamStats`: mean LOS, `assumed` count, and (two-team lobbies only) each
  side's **`winProb`** from `predictWin` over every player's μ/σ (rookie-handicapped;
  unrated = a debutant) — the SAME predictor the LOS fold is calibrated with. The UI
  never recomputes odds locally; the old Elo win formula and the fitted elo swing are gone
  (tools/fit-lava-k.ts remains for the bot-side Lavabar work only).
- LOS pill bands (ui.ts `ratingClass`): blue ≥ 30, green ≥ 20, orange ≥ 12, gray below;
  values render with one decimal (`fmtLos`).
- a lavaos failure degrades to an unrated roster (empty map + console.warn), never a 502.

The list page (`/`) is unchanged (it never showed ratings).


## The LOS public API (src/los/ — merged into the bot Worker)

Historically a **separate Worker** ("lavaos", `wrangler.lavaos.toml` — deleted); since
the merge its routes (`/api/games`, `/api/ranking`, `/api/players[…]`, `/api/reset` —
disjoint from the lobby API) are mounted into the bot Worker's Hono app, the `LosDO`
is one of the Worker's Durable Object exports in `cloudflare.config.ts` (created by the
old wrangler migration v6), and the **lavabalance.fogofwar.dev** custom domain
routes to the merged Worker (`worker.domains`; `workersDev: true` keeps the bot
UI's workers.dev URL). The design is `docs/lavaos-cloudflare-data-model.md` (start
there; it documents the schema, the upload contract and every endpoint). NOTE: DO
storage did NOT move with the merge — after the first merged deploy, delete the old
lavaos Worker (it holds the custom domain) and re-upload the day files
(`pnpm run lavaos:upload -- --url …`) to rebuild the fold. Key facts:

- **No scraping**: the Worker never goes looking for games; they are POSTed to
  it. **In production the producer is barreplay's lava sync** (`mabn/barreplay`,
  `worker/src/worker/lavasync.ts`, over its LAVABALANCE service binding): it
  offers every lava-shaped game its mirror holds — the verbatim `/replays/<id>`
  detail, `lobbyName`/`lobbyDetails` attached — on the tick it mirrors one, plus
  an hourly sweep. The CLI below is the BACKFILL path, not the live one.
- **A producer must keep its own record of what it offered**, because this API
  is not one: a `rejected` or `skipped` game is stored NOWHERE, so nothing here
  afterwards distinguishes "declined" from "never seen". Anything deriving its
  queue from what IS stored re-offers every game this API declined, forever.
  That is not hypothetical — it is how new games stopped appearing for three
  days from 2026-09-11: barreplay took the newest game in `GET /api/games` as a
  watermark, one night of non-lava modded lobbies put 33 games it would reject
  in front of its 20-game batch, and the queue never moved again (fixed in
  barreplay#64, which keeps a per-game offered mark instead).
- Uploading BY HAND (a backfill, a re-upload after a reset): the scraper's day
  files verbatim — `pnpm run lavaos:upload` (tools/lavaos/upload.ts: all of
  `data/` sorted by filename ascending, `--url`/`--from`/`--to`; aborts on first
  failure, idempotent re-run resumes), or
  (`curl -XPOST --data-binary @data/2026-08-15.json <host>/api/games`). Per
  game the response says `rated` / `ignored` (stored, never rated: reason
  `"uploaded too late"` (behind the fold head) or `"off-map"` — every
  eligibility rule except the map applied; a too-late game is recoverable via
  POST /api/games/:id/rebase, "Re-run LOS from here" in the games table's
  admin-only row menu — its dialog asks whether to also rate off-map games
  ({includeOffMap:true}, default off) and it re-folds from that game onward
  purely from stored rows, judging off-map by the stored map rather than the
  reason label, so a default re-run resets a wrongly-rated off-map game to
  unranked; a game an admin marked IGNORED is skipped by every re-run until
  the marker is cleared, see below) /
  `skipped` (ineligible — reported, NOT stored)
  / `duplicate` / `rejected` (not lava — not stored). Only order ACROSS
  uploads matters; each batch is sorted and committed atomically.
- **Lobby info rides the upload** (barreplay's lava sync attaches `lobbyName`
  + `lobbyDetails` — the party roster among them — as extra top-level fields
  on the verbatim detail; `extractLobby` in `los/losGames.ts` collects them):
  stored verbatim as JSON in the games table's nullable `lobby` column and
  served ONLY by `GET /api/games/:id` (the list shape is unchanged). A
  duplicate upload **backfills** a NULL `lobby` (the first submission may
  predate the lobby match; what an earlier upload stored is never
  overwritten). Nothing filters or rates on it.
- The fold is **strictly forward-only**; incorporating ignored games =
  `POST /api/reset?confirm=true` + chronological re-upload. An algorithm
  change (`ALGO_VERSION` bump) is applied by a **rebase from the first stored
  game** (`POST /api/games/<first id>/rebase`), which refolds everything from
  the stored rows and stamps the new version in `meta` — how ALGO_VERSION 2
  (the 2026-09-16 rookie-handicap curve) and 3 (its 2026-09-27 refit) were
  rolled out.
- **Currently unauthenticated** (upload and reset included) — deliberate,
  auth deferred.
- **Private profiles**: `players.private_profile` (0/1, admin-set via
  `POST /api/players/:userId/private` with `{"private": true|false}` — the
  ranking page's `⋯` row menu; 404 for an unrated user id, and the response's
  `changed` says whether the flag actually moved). It is a **read filter on the
  site, not access control** — the fold still rates a hidden player, their rows
  in every game's roster and `/api/games/:id` are untouched, and
  `/api/players/lookup` still answers with their real rating, so the bot keeps
  balancing on it.
  What a visitor gets instead: on `/api/ranking` they are **listed in the
  rankless tail** (see below) with `rank` and every rating field
  (`los`, `mu`, `sigma`, `leaderboardRating`, `barOs`) **null** — `games`,
  `wins`, `losses` and `lastPlayed` stay, being what the public games list
  already tells anyone. `/api/players/:id` answers name +
  `privateProfile: true` and nothing else, `…/history` has no points, and
  `…/games` keeps every row but nulls this player's
  `losBefore`/`losAfter`/`losDelta` and their own roster entry's ratings —
  everyone else's kept, and `predictedWin` is computed BEFORE the redaction so
  the game's own prediction survives.
  The **lobby view** (`/api/lobbies/:id` → `/lobby/:id`) withholds it too:
  `finalizeLobby` sends `los`/`losHandicap` null with `losPrivate: true`, and the
  page draws the same `– (?)` the game page does, sorting those rows last (an
  ordering taken from the hidden number would put it back on screen as a
  position). `teamStats` — the team average and the win chance — is computed
  from the FULL ratings first: those are the MATCH's numbers, and averaging what
  a visitor can see would count the hidden player as a debutant, both moving the
  figure and leaking their rating by the difference. `playersByNames` itself
  still answers with the real rating plus a `privateProfile` flag, because the
  bot balances on it — hiding is the display surface's job.
  A private player's entry in any **game roster** — `/api/games`,
  `/api/games/:id` and the rosters inside `…/players/:id/games` — is blanked the
  same way but **keeps its `losDelta`** (only the player page's own table drops
  the delta as well, being asked to show no LOS changes at all for its subject).
  Every game-level number is computed BEFORE the blanking and so reads the same
  for everyone: `predictedWin`, and `avgLosBefore` — the per-team mean the pages
  render instead of averaging the roster themselves, since averaging what is
  left would drop the hidden player and leak the rating by subtraction.
  **`?includePrivate=true`** on any of those reads is the admin view and
  serves everything, the ranking included **in its true order** — hidden players
  in their real places with their real rank; it is open like the rest of this
  API and answers `Cache-Control: no-store` (the admin view must never reach the
  next reader from the edge cache, and a toggle has to show immediately).
  A **rebase** drops and recreates `players` rows, so `rebaseSync` snapshots the
  hidden user ids up front and `restorePrivate`s them before recounting.
- **Ignoring a game**: `games.excluded` (0/1, admin-set via
  `POST /api/games/:id/ignored` with `{"ignored": true|false}` — the games
  page's `⋯` row menu; 404 for a game never stored, and `changed` says whether
  the marker actually moved). It is a **marker for the fold, not a rating
  change**: the call writes one flag and recomputes nothing — `status`, `seq`,
  every stored μ/σ and every count stay as they are — so the score moves only
  when the LOS fold is re-run from the game (the menu's other entry). The
  response's `needsRebase` says whether the marker and the stored ratings
  currently disagree, which is what the page badges ("ignored · pending") and
  says in a note above the table. `rebase` honours the marker whatever the map
  and whatever `includeOffMap` asked for — an exclusion is a decision, not a map
  verdict — leaving the game unrated with `unranked_reason = 'excluded'`;
  clearing it and re-running restores the store exactly (pinned in
  `los.workers.test.ts`). Never set by an upload, and it survives a rebase.
  Served as `excluded` on every game the list and detail routes return.
- **Inactive players**: `players.inactive` (0/1) — no rated game in
  **`INACTIVE_DAYS` = 35**, derived from `last_played`, nobody's decision. Such a
  player is **off the leaderboard and nothing else**: no rank (`public_rank`
  NULL, and they sit in `/api/ranking`'s rankless tail like a private profile),
  but their rating, record, chart, games and profile are as public as anyone's —
  the ONLY difference from a normal player is the missing position. `player()`
  serves `inactive` plus `inactiveDays` so a page can say why the rank is a dash;
  the ranking's rows carry `inactive` and the list carries `inactiveDays`.
  Playing again ranks them again, on the next upload.
- **Search reads its matches ONCE**, through `idx_players_name`, and does the
  ordering, partitioning and paging in JS. In SQL it took four passes (two
  counts and a page of each half), and an `AND ranked = ?` beside the LIKE was
  enough for the planner to prefer `idx_players_ranked` and walk every ranked
  player instead of the handful the prefix matches — 744 rows for one search of
  a 720-player store. Note the deliberate absence of an `ORDER BY` on that
  query: adding one is what lets the planner reach for a ranking index and read
  the table instead of the match.
- **The hidden-player set is cached in memory** on the DO instance
  (`privateUserIds`, invalidated by `forgetPrivateIds` in `setPrivateProfile`,
  `rebase` and `reset`). Blanking a roster asks "is this one private?" sixteen
  times per game, and a games page carries hundreds of roster rows: as a SQLite
  lookup that cost ~800 extra rows on every view of `/games`. The set is a
  handful of admin-set flags and this DO is its only writer, so it is loaded
  once per instance (the one bare `SCAN players` in the file) and free after.
- **How the ranking's two halves stay cheap.** The leaderboard's membership is
  `players.ranked` = `private_profile = 0 AND inactive = 0`, MATERIALIZED because
  the head keys on that conjunction and the tail on its OR-negation — and an OR
  cannot drive a range scan, so the tail would go looking for its rows by
  scanning. Two indexes key on it: `idx_players_ranked (ranked, los DESC,
  user_id)` for the head (no sort, not one unranked row read) and
  `idx_players_unranked (ranked, last_played DESC, user_id)` for the tail, which
  is **paged in SQL** — it holds every lapsed player, which in a mature store is
  most of them. Both pinned by an `EXPLAIN QUERY PLAN` test. The tail's order is
  *most recently seen first*: ordering the unranked by RATING would read as a
  ranking and, for the private rows whose rating is blanked, leak the very thing
  the blanking hides. The split point between the halves is the maintained
  `counts.players_ranked`, so no read counts rows to find it.
- **Two materialized ranks and the activity flag, all from one walk.**
  `refreshRanks(now)` walks `idx_players_ranking` once and derives everything:
  `inactive` (against a `now − 35 days` cutoff — `last_played` is an ISO instant,
  so the string compare IS the date compare), `ranked`, `players.rank` (the TRUE
  position over everyone, what the admin sees), `players.public_rank` (the
  position among ranked players, NULL otherwise, so a visitor's list runs 1..N
  with no gap where a hidden or lapsed player sits) and `counts.players_ranked`.
  Only rows whose derived values actually moved are written. Called by every
  upload that rated a game, by `setPrivateProfile`, by `rebase`, by
  `ensureDerived` — and by `sweepActivityIfDue()`, which the ranking and player
  reads call: a player lapses because NOTHING happened, so no write can notice,
  and a stored `activity_swept_at` keeps that to one walk per
  `ACTIVITY_SWEEP_MS` (6h) however much traffic arrives.
- Verification oracle: `pnpm run lavaos:los` over the same day files must be
  byte-identical to `/api/ranking` (checked for Aug 2026: 2,013 players
  exact; ordering differs only inside exact-tie groups, API tiebreak =
  user_id).
