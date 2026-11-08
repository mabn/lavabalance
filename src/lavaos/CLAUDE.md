# src/lavaos — LOS rating engine

## OVERVIEW
Pure, Worker-safe rating math: BAR's OpenSkill port + LAVA-game classifier, eligibility, rookie handicap, win predictor.

## WHERE TO LOOK
| Task | Location | Notes |
|---|---|---|
| OpenSkill port (`rate`, `predictWinLib`, constants) | `openskill.ts` | PlackettLuce, τ=1/3, prevent_sigma_increase; pinned to openskill.ex vectors |
| LOS win chance | `lava.ts` `predictWin` / `predictWinFromSums` | per-PLAYER β term; NOT `predictWinLib` |
| Lava detection / eligibility | `lava.ts` `isLavaGame`, `unrateableReason`, `eligibilityReason`, `startMetalReason` | tweak-stack signatures; 2-team 8v8, Supreme Isthmus, ≥6 min, 4000 start metal from 2026-10-01 |
| Rookie handicap | `lava.ts` `rookieHandicap`, `losEffectiveRating`, `ROOKIE_MU_HANDICAP_*` | 13·e^(−prior/25) for first 35 games |
| bar-rts replay shapes | `types.ts` | verbatim `/replays/:id` detail |
| Fold (stateful use of the engine) | `src/los/losGames.ts` `applyRatedGame` | must match `tools/lavaos/los.ts` byte for byte |
| Other consumers | `src/lobbyView.ts`, `src/balance/balancer.ts` | matchup strip `winProb`, balancer objective |
| Scrape / offline fold / upload | `tools/lavaos/scrape.ts`, `los.ts`, `upload.ts` | Node via tsx; `pnpm run lavaos:*` |
| Handicap fit | `tools/lavaos/handicap_fit.py` | full refold per candidate; `--check A,T,N` |
| Predictor calibration | `tools/lavaos/calibration.py` | `docs/los-calibration-2026-09.md` |
| Port test | `test/lavaos-openskill.test.ts` | rate exact to 1e-9, predictWin to 1e-6 |
| Design history | `docs/los-rookie-handicap-2026-09-*.md`, "Reference" below | long-form rationale |

## CONVENTIONS
- No `node:*`, no `Buffer` in `src/lavaos/` — the Worker and DOs import it; base64 decoding is a lenient hand-rolled decoder.
- `openskill.ts` = BAR exactly. Every LOS deviation lives in `lava.ts`.
- Deliberate deviations from BAR: `ranked_game` ignored; one bucket (no game type/season); strictly 2-team 8v8; min duration 6 min (BAR 90 s); start-metal rule.
- `predictWin` uses (|A|+|B|)·β² (16β² for 8v8) instead of the lib's 2β² — better calibrated (slope 0.93 vs 0.80). Used for every shown or optimised chance. `rate()` is unchanged by it.
- Rookie handicap applies wherever team strength is computed (`rate()` inputs and `predictWin`); the update delta lands on the real μ.
- `UNRATED_LOS` ≈ 3.7 (25 − 13 − 8.33) = a debutant's assumed rating; unrated players are a debutant everywhere, never 0 or skipped.
- Any change to what a game's rating update computes (handicap curve, eligibility, `rate()` inputs) bumps `ALGO_VERSION` (`src/los/losGames.ts`). Stored ratings keep the old curve until an admin rebases from the oldest stored game.
- A pure predictor change (`predictWin`) needs no bump: `predictedWin` is computed on read from stored `_before` ratings.
- `tools/` is not typechecked (only `src/`, `test/`); `data*/` scraped day files are gitignored.

## ANTI-PATTERNS
- Fitting a handicap on already-folded ratings — undersizes it (the v2 mistake). Score each candidate with a full refold (`handicap_fit.py`); its first line checks the refold against stored μ.
- Replacing the handicap with a lower starting μ — OpenSkill is exactly invariant to shifting every μ by a constant; only a relative, decaying discount works.
- Seeding LOS from BAR OS or BAR rank/chevron — uncorrelated with lava skill (r≈0.03) and adds nothing out of sample.
- Calling `predictWinLib` for anything shown — it exists only for the test-vector pin.
- Changing the fold in `src/` without `tools/lavaos/los.ts` (or vice versa).
- Keying lava detection on lobby title or `autohostname` — replays have no title; require ≥1 core lava signature + ≥2 total.
- Recomputing win odds client-side — the UI prints the server's `predictWin`.
- Scraping politely is part of the contract: keep 2-way concurrency, delays and the latency watchdog in `scrape.ts`.

# Reference

Guidance for the **lavaos** module inside lavabalance. General lavabalance
guidance: the root `CLAUDE.md`. lavaos was a standalone top-level subproject
before 2026-08-31; it now shares lavabalance's toolchain, package.json,
tsconfig and vitest setup.

## What this is

**LOS ("lava OS")**: OpenSkill ratings for players of the Supreme LAVA lobby
(8v8 lava-tweaked games on Supreme Isthmus), computed with BAR's exact rating
algorithm but over lava games only — BAR itself never rates them (tweaked
games are unranked). A scraper + offline rating job today; `src/lavaos/` is
Worker-safe (no node: APIs, no Buffer) so the bot/DOs can import the rating
math directly (e.g. to balance lobbies or serve LOS).

LOS is also served publicly by the LOS API (`../los/`, mounted into the
lavabalance Worker — formerly a separate "lavaos" Worker — reachable at
lavabalance.fogofwar.dev). In production it is fed by **barreplay's lava sync**
pushing each finished game as it is mirrored; the scraper + `lavaos:upload`
below are the backfill path — see `docs/lavaos-cloudflare-data-model.md`
and the upload-contract bullets in the root `CLAUDE.md`. Its fold must stay
byte-identical to `tools/lavaos/los.ts`; change the rating rule in
`src/lavaos/` and both consumers together.

```bash
# from the lavabalance root
pnpm run lavaos:scrape -- --from 2026-08-01 --to 2026-08-30   # see --help
pnpm run lavaos:los -- --min-games 10                         # see --help
pnpm run lavaos:upload -- --url https://lavabalance.fogofwar.dev   # push data/ to the LOS service
pnpm run lavaos:backfill-ranks -- --dry     # repair bar_rank on the deployed store (SQL on the DO)
pnpm test          # includes test/lavaos-openskill.test.ts (unit project)
```

## File map (paths relative to lavabalance root)

| File | Purpose |
|---|---|
| `src/lavaos/openskill.ts` | Faithful port of BAR's rating math: PlackettLuce `rate()`, `predictWinLib()`, constants, `ratingValue` (μ−σ) / `leaderboardRating` (μ−3σ). Worker-safe. |
| `src/lavaos/lava.ts` | **`predictWin`** (the LOS win chance — per-player β term, see deviations), lava-game classifier, rating eligibility (`unrateableReason` = `onRatedMap` + the map-independent `eligibilityReason` + the start-metal rule `startMetalReason` — off-map and wrong-storage lava games are stored unranked, see losDO), rookie handicap (`losEffectiveRating`), lenient base64 decoder. Worker-safe. |
| `src/lavaos/types.ts` | Shapes of the bar-rts API responses / on-disk day files. |
| `tools/lavaos/scrape.ts` | Scraper (Node, tsx). Discovers game ids via onetricklava.com, fetches verbatim details from api.bar-rts.com, writes one `data/YYYY-MM-DD.json` per UTC day (lava-lobby games only, ~20–40/day; a month ≈ 3 min). Resume = re-run (existing day files skipped; today skipped unless `--force`). |
| `tools/lavaos/los.ts` | The rating job (Node, tsx): replays day files chronologically, prints the leaderboard (LOS, μ, σ, games, W-L, last game date, BAR OS), writes `data/los.json`. |
| `tools/lavaos/backfill-ranks.ts` | Repairs `game_players.bar_rank` on the DEPLOYED store by running SQL **straight against the Durable Object** — `POST /accounts/<acct>/workers/durable_objects/namespaces/<ns>/query` on api.cloudflare.com, with a normal account token. Needed because nothing in the service can do it: only an upload carries the chevron and a re-upload of a stored game is a deliberate no-op, so games stored before the column shipped would keep NULL forever. Reads each chevron from the verbatim replay detail — a local day file first, the BAR API otherwise — and writes one `UPDATE ... CASE user_id ... WHERE game_id = ? AND bar_rank IS NULL` per game (one statement per game, not per player: ~5k round trips instead of ~80k). `--dry`, `--limit`, `--sql` (an arbitrary read, the escape hatch), `--cf` (point it at a stub). **The query route is UNDOCUMENTED** — absent from Cloudflare's OpenAPI schema though it routes — so the contract is taken from what the dashboard's SQL console sends: `{"queries":[{"sql":"..."}],"durable_object_id":"<64-hex>"}`. **The object id is required and is the trap**: a namespace holds many objects, and naming only the namespace answers a bare `Bad request` that says nothing about which field is missing. It is discovered through the DOCUMENTED objects endpoint (the singleton is the one object holding data), never pasted. `probe()` still tries variants around the known shape and, if all fail, prints each server reply and points at the object id first. It takes no bound parameters for the same reason (a shape that ignored them would send `?` as a literal); values are inlined behind a hex/integer check instead. Finding the namespace uses the DOCUMENTED list endpoint and refuses a namespace holding another class, so it cannot write to the wrong database. Idempotent — the `IS NULL` guard means a re-run is free and an interrupted run resumes. |
| `tools/lavaos/backfill-start-metal.ts` | Fills `games.start_metal_storage` on a deployed store for games since the start-metal cutoff: lists them via `GET /api/games`, fetches each verbatim detail from api.bar-rts.com and re-POSTs it (a duplicate upload only fills NULL columns, never touches the fold; anything but "duplicate" aborts). `--dry` prints each game's value. Run before the ALGO_VERSION 4 rebase. |
| `tools/lavaos/upload.ts` | Uploader (Node, tsx): POSTs the day files verbatim to the LOS service's `/api/games` — all of `--data` (default `data/`) by default, sorted by filename ascending (= chronological, the order the forward-only fold needs), `--from`/`--to` to narrow, `--url` default `http://localhost:8787` (wrangler dev). Aborts on the first failure (continuing would advance the fold head past the failed day); idempotent, so re-running resumes. |
| `tools/lavaos/calibration.py` | Offline calibration check of `predictWin` over the public games API (reliability/slope, balanced-game tests, per-player and per-experience residuals). Standard-library Python. Findings and method: `docs/los-calibration-2026-09.md`. |
| `tools/lavaos/handicap_fit.py` | Fits the rookie handicap curve with a **full refold per candidate** (Python port of the fold, checked against the stored μ) and a leave-one-month-out grid; `--check A,T,N` scores one curve against the server's. Standard library; the method behind ALGO_VERSION 3 (`docs/los-rookie-handicap-2026-09-27.md`). |
| `test/lavaos-openskill.test.ts` | Pins the port to `beyond-all-reason/openskill.ex`'s own test vectors (rate exact to 1e-9; predictWin to 1e-6, limited by the erfc approximation). |

`data*/` is gitignored — never commit scraped data. Like the rest of
lavabalance, `tools/` is not typechecked (no @types/node in this project;
tsx runs it) — only `src/` and `test/` are. An old standalone full-map
scraper (every Supreme Isthmus game via bar-rts date windows) is in git
history under `lavaos/` if ever needed; day files it produced are compatible.

## BAR's rating algorithm (read from source — don't relearn)

Sources: `beyond-all-reason/openskill.ex` (the lib prod runs),
`beyond-all-reason/teiserver` `lib/teiserver/game/libs/match_rating_lib.ex`
(match pipeline), `lib/teiserver/battle/libs/balance_lib.ex` (display),
`lib/teiserver/libs/teiserver_configs.ex` (config defaults).

- Model: **OpenSkill Plackett-Luce**. Constants: μ₀=25, σ₀=25/3, β=25/6,
  ε=0.0001, z=3. Team μ = Σ member μ, team σ² = Σ member σ².
- A 2-team match is `rate([winners, losers])` with **τ=1/3** (site config
  `rating.Tau`; σ inflated to √(σ²+τ²) pre-model) and
  **prevent_sigma_increase=true** (new σ never above pre-match σ). Team rank =
  list order; the Elixir model ignores the ranks option (ties unsupported).
- Displayed "OS" (`rating_value`, the lobby number) = **max(μ−σ, 0)**;
  leaderboard rating = max(μ−3σ, 0). New player: 25/8.333 → OS 16.67.
- BAR rates a match only if: winner exists, ≥2 teams all the same size,
  duration ≥ 90 s, no bots, not `ranked_game="0"`, no cheating flag; per game
  type (Duel/Large Team/…) and per season.
- Win probability: `predict_win` = Φ((μ_A−μ_B)/√(n·β²+σ_A²+σ_B²)), n = team
  count (2β²). Ported exactly as `predictWinLib` for the test-vector pin, but
  **LOS does not use it** — see `predictWin` under deviations.
- **Port validated against reality**, not just test vectors: on August
  Supreme Isthmus ranked games, predicted post-game ratings matched BAR's
  actual next-shown values within display rounding for 80% of 1,990 clean
  update pairs (median error 0.01 OS). Same model, same constants confirmed.
- σ shrinks *slowly* in 8v8 (16 players share one outcome bit): ~8.3 → ~8.0
  after 10 games, ~6.5 after 100, ~4 only after years. BAR population median
  shown uncertainty is 4.67. The match-history page caption confirms the
  μ−σ / μ−3σ formulas.

## LOS deviations from BAR (all deliberate, in `src/lava.ts`)

- `ranked_game` flag ignored — lava games are unranked by definition.
- One rating bucket (no per-game-type / season split).
- Strictly **2-team 8v8** (BAR only requires even teams — keeps sandbox
  1v1s/small games out) on a **Supreme Isthmus** map (any version).
- **Start metal storage 4000** from **2026-10-01 00:00 UTC** (game start
  time; `startMetalReason` in `lava.ts`, ALGO_VERSION 4): a game's
  `gameSettings.startmetalstorage` must be `4000` to be rated. Earlier games
  are rated whatever the value. A game under the rule with another value is
  stored unranked (reason `start metal storage`, like off-map); one whose
  replay has no value is skipped. The value is kept on `games.start_metal_storage`
  so a rebase can re-judge stored rows; rows stored before that column get it
  from a duplicate re-upload (`pnpm run lavaos:backfill-start-metal`), and
  rebase refuses (409) while a game since the cutoff still lacks it.
- Duration minimum **6 min** instead of 90 s (real lava 8v8s run 10 min+;
  sub-6min "wins" were rush-kill oddities, one lasted 6 seconds).
- **Win predictor `predictWin` / `predictWinFromSums`** (`src/lavaos/lava.ts`,
  NOT openskill.ts):
  the same Φ form but with a per-PLAYER β term, (|A|+|B|)·β² = 16β² for an
  8v8, instead of the lib's per-team 2β². With the lib's term the denominator
  is almost all Σσ² and confident predictions run too hot: over 393 games
  (Aug 15 – Sep 15 2026) the lib's 90%+ predictions won 94.5% (calibration
  slope 0.80); the per-player term gives 96.1% (slope 0.93). Adopted
  2026-09-15 (`docs/los-calibration-2026-09.md`). Used everywhere a chance is
  shown or optimised: the game/API `predictedWin` (computed on read from the
  stored `_before` ratings, so past games re-score too), the lobby matchup
  strip, the bot's announcement, and the balancer's objective (a monotone
  change, so the chosen split is the same). `rate()` is untouched: stored
  μ/σ did not change. An August note said both terms calibrated the same on
  602 games — that no longer held with more data.
- **Rookie handicap** (`rookieHandicap`, ALGO_VERSION 3 since 2026-09-27):
  a player's μ is discounted by **13·e^(−prior/25)** for their first 35
  rated lava games (13 in game 1, ~11.1 in game 5, ~9.1 in game 10, ~6.1 in
  game 20, ~3.3 in game 35, then 0) wherever team strength is computed (`rate()` inputs and
  `predictWin`, via `losEffectiveRating`), update delta applied to the real
  μ. NOTE a flat lower starting μ CANNOT express this — OpenSkill is exactly
  invariant under shifting every player's μ by a constant (verified:
  byte-identical output) — hence the relative, decaying handicap. History:
  the first fit (Aug 2026, 602 games) was 3.9/3.4/2.4 for games 1–3; on the
  full history that was too small and too short (a side with one extra
  player in games 1–10 won 39% of near-even games), so v2 (2026-09-16) was
  8.5·e^(−prior/15) over 20 games — `docs/los-rookie-handicap-2026-09-16.md`.
  v2 was fitted on already-folded ratings and still left ~4 pp per extra
  rookie on Sep 4–27; v3 was fitted with a full refold per candidate (leave-
  one-month-out log-loss 0.489 → 0.483, 9 of 10 months better) —
  `docs/los-rookie-handicap-2026-09-27.md`. **Fit a handicap with a refold
  per candidate**, never on stored ratings.
  BAR rank (hours played) was tested as an extra input and adds nothing out
  of sample. Changing the curve changes every stored rating: bump
  `ALGO_VERSION` and refold (rebase from the first game, or reset + upload).
  A debutant's assumed LOS is therefore 25 − 13 − 8.33 ≈ 3.7
  (`UNRATED_LOS`).
  **Displayed LOS includes the handicap** (since 2026-11-01): every page, API
  `los`/`losBefore`/`losAfter`/`losDelta` field and bot message shows
  `shownLosOf(μ, σ, games)` = max(μ − handicap − σ, 0) (`src/los/losGames.ts`).
  The stored `players.los` column, the leaderboard order, `rank_history` and
  the 7-day change stay on the raw μ − σ.

## Empirical findings (Aug 2026 data — the "why" behind the design)

- **Lava skill is uncorrelated with BAR OS**: r=0.03 (Spearman 0.02, n=182
  regulars), flat in every OS range, and high-OS debutants underperform MOST
  (−3.8pp vs −0.8pp for OS<10). Never seed LOS from BAR OS. Top lava players
  carry BAR OS 8–17; lava regulars' BAR OS is also frozen/stale (unranked
  games don't update it).
- **"No winning team" ≡ `gameEndedNormally:false`** (exact 1:1). ~15–20% of
  lava games; nearly all are <5 min false starts (drop at load, vote-restart)
  — the longer ones are sandbox/vs-bot sessions ended by quitting. No real
  8v8 lost its result in August. BAR skips these identically.
- **Replay-shown OS lags a game behind** (Teiserver rates asynchronously): in
  back-to-back lobby games, 82% of next-game rows still show the pre-game
  rating. If ever seeding from shown skill, take it after a long gap.
- predictWin calibration (602 rated games, sequential pre-game ratings, with
  rookie handicap): favorite wins 81%, bucketed predicted-vs-actual agrees
  within a few pp from 50–60% up to 90%+. A third of lava games are 90%+
  blowout predictions — the lobby really is that unbalanced.
- Fair splits exist: brute-forcing C(16,8)/2 = 6435 partitions with
  predictWin finds ~50/50 splits for real stacked lobbies (balancer is still
  a scratch script, not committed).

## Lava-game detection (`src/lava.ts`)

Replay data has **no lobby title**; the LAVA lobby is recognized by its tweak
stack: decode `gameSettings.tweakdefs*`/`tweakunits*` (base64, sometimes with
corrupted padding — Buffer decodes leniently) and match the lavapack file
headers, stable across versions (`LavaPack (Djarshi)`, `Lava QoL`,
`Lava Sky Ops`, `OneBigNuke`, `Riot Titan`, `Roomba`, `TacMissileNerf`,
`Legendary Converter`). Rule: ≥1
core lava signature + ≥2 total (single files circulate in other lobbies).
Don't key on `hostSettings.autohostname` (autohost assignment varies).
Even with onetricklava discovery the classifier still gates every game.

## API facts (verified live, 2026-08 — don't relearn)

### onetricklava.com (game discovery)

- `GET /api/games?sort=started&order=desc&limit=100&offset=N` →
  `{total, games:[{id, start_time, map_name, players, winner_team, …}]}`,
  newest first, **lava games only**, `id` = the bar-rts replay id. ~11.3k
  games ≈ the lobby's full history (~1 year); backfilling all of it ≈ 40 min.
- Offsets shift as new games finish → binary-search the date-range boundary
  offsets, then walk pages of 100 **stepping 90** and dedupe by id (the
  overlap absorbs shifts). Slightly curated: omits some bot/sandbox games the
  classifier would reject anyway.

### api.bar-rts.com (game content)

- `GET /replays/:id` (~16 KB) is the source of truth stored on disk: `userId`
  (stable identity — names change), `AllyTeams[].winningTeam`, `faction`,
  `gameEndedNormally`, `hasBots`, `preset`, lobby `skill` ("[12.93]" = OS) +
  `skillUncertainty`, `gameSettings` tweaks. `trueSkillMu*` fields are legacy
  and always null.
- List endpoint quirks (matters only if the full-map scraper is revived): map
  filter is the plain `maps=` param (`maps[]=` silently ignored); two `date=`
  params form an end-exclusive UTC day range (`date=D&date=D+1` → day D);
  `totalResults` is always −1 (paginate until a short page); **never paginate
  deep without a date window** — offset 5000 took ~26 s/page.
- Warm keep-alive requests ~0.15–0.2 s (fresh connection ~0.7–1 s TLS). Be
  polite: 2-way concurrency + 150 ms delays + the latency watchdog (pause
  30 s, then abort when the rolling mean exceeds 500 ms) — keep that behavior.
