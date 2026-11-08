# test/

## OVERVIEW
vitest 4, two projects in `vitest.config.ts`: `unit` (Node pool) and `workers` (workerd via `@cloudflare/vitest-plugin`, loads `cloudflare.config.ts`).

## WHERE TO LOOK
| Need | File |
|------|------|
| Project split, pinned vars | `vitest.config.ts` (`miniflare.bindings`: `BOT_USERNAME=huk123`, `SRC_MODES=teiserver,proxy,rtsapi`) |
| Dispatcher end-to-end replay | `dispatcher.replay.workers.test.ts` + `fixtures/lobby-session.log` |
| Replay scaling / stall guard | `dispatcher.replay-large.workers.test.ts` (generates its own log in code) |
| LOS API + LosDO | `los.workers.test.ts` (blocks: derived data, private profiles, ranking sort, rank history, inactive players, ignoring a game) |
| SQL row-cost accounting | `sqlstats.workers.test.ts`, `losCost.workers.test.ts` |
| Synthetic bar-rts replays | `losFixtures.ts` (`lavaReplay(opts)` → `ReplayDetail`) |
| Calling admin routes | `adminFetch.ts` (`adminFetch`, `fetchAs`) |
| `cloudflare:test` + `?raw` types | `env.d.ts` |
| Access JWT check itself | `access.test.ts` (unit) |
| Inlined page markers | `ui.test.ts` |

## CONVENTIONS
- Pool is chosen by filename only: `*.workers.test.ts` → `workers`; every other `test/**/*.test.ts` → `unit`.
- Anything importing `cloudflare:test` / `cloudflare:workers` (directly or via `src/` modules that do, e.g. DOs, `src/index.ts`) MUST be `*.workers.test.ts`; Node cannot resolve those modules.
- Pure parser/state tests stay `unit` (fast, no runtime).
- Vars are pinned in `vitest.config.ts`, not inherited from `cloudflare.config.ts`: fixtures are captured as `huk123` and src-mode tests need all three sources. Changing production vars must not break the suite.
- `fixtures/lobby-session.log` format: one line per message, `c <line>` (client→server) or `S <line>` (server→client); TAB characters inside lines are significant. Loaded via `import log from "./fixtures/lobby-session.log?raw"` (no `node:fs` in workerd), parsed to `{ts, src, msg}` envelopes, fed through the Dispatcher `ingest()` RPC inside `runInDurableObject`.
- `.gitignore` has `*.log` plus `!test/fixtures/*.log`; a new fixture log must live in `test/fixtures/` or it is silently untracked.
- DO SQLite persists across tests in the pool: LOS tests reset in `beforeEach` with `POST /api/reset?confirm=true`, then upload what they need through real routes.
- `/api/reset` wipes LOS tables only; avoids and scout cards have their own `POST /api/avoids/reset` / `/api/scout/reset`.
- Fixture game dates are relative to today (`day(d, h, id)` / `staleDay()` in `los.workers.test.ts`, base = now − 10 days). `staleDay` = −45 days, past `INACTIVE_DAYS`.
- `SELF.fetch` is a visitor. Admin routes go through `adminFetch` (runs the worker with `ADMIN_OPEN: "true"`); `fetchAs(visitorFetch)` routes by the `ADMIN_PATH` regex, so extend that regex when adding an admin-only route under test.
- `losFixtures.lavaReplay` defaults: 8v8, userIds 101–108 vs 201–208, team 0 wins, core lava tweak signatures, `startmetalstorage=4000`. `gameSettings: {}` = non-lava; `winner: null` = unrateable.

## ANTI-PATTERNS
- Hard-coded calendar dates in LOS fixtures: every player lapses once real time passes `INACTIVE_DAYS` and ranking assertions fail.
- Assuming a clean DB per test, or ordering tests to share state.
- Naming a DO test `*.test.ts` (lands in Node, fails on `cloudflare:*` imports) or a pure test `*.workers.test.ts` (slow for nothing).
- Reading fixtures with `node:fs` in workers tests; use `?raw`.
- Trusting stale file-header comments over `vitest.config.ts`: `los.workers.test.ts` mentions a `lavaos-workers` project / `wrangler.lavaos.toml` (gone); the replay test header mentions `/dispatcher/ws` while the code uses `ingest()`.
- Bumping `BOT_USERNAME` in the test bindings: fixtures and `dispatcher.replay-large` hard-code `huk123`.

# Reference

## Tests (detail)

`vitest.config.ts` runs two projects in one `pnpm test`:

- **`unit`** — the pure protocol/parser/state tests (`test/*.test.ts`), in the default
  Node pool (no runtime).
- **`workers`** — tests that exercise the Durable Object inside the real **workerd**
  runtime via **`@cloudflare/vitest-plugin`** (its `cloudflareTest` vite plugin
  loads `cloudflare.config.ts`, so the bindings and DO exports match production). These
  are named **`*.workers.test.ts`**. **Vars are pinned for the tests** in
  `vitest.config.ts` (`miniflare.bindings`: `BOT_USERNAME=huk123`, `SRC_MODES=
  teiserver,proxy,rtsapi`) — the fixtures/scenarios are captured as huk123 and the
  src-mode tests need every source enabled — so changing the production vars in
  cloudflare.config.ts (bot account, enabled sources) does NOT break the suite.

  `test/dispatcher.replay.workers.test.ts` is the end-to-end DO test: it loads the
  example command log `test/fixtures/lobby-session.log` (`c <line>` / `S <line>`, the
  format the old proxy tap wrote), feeds every line to the live Dispatcher as
  `{ts, src, msg}` envelopes through its `ingest()` RPC (via `runInDurableObject`),
  then asserts the rebuilt battle/roster/skills via the control plane and DO RPC. The fixture is checked in (a `!test/fixtures/*.log`
  negation in `.gitignore` exempts it from the `*.log` rule). Note `cloudflare:test`
  types are wired up in `test/env.d.ts`.

  `test/los.workers.test.ts` exercises the LOS API + LosDO the same way (the DO's
  SQLite persists across tests in the pool, so each test starts with
  `POST /api/reset?confirm=true`; synthetic replays come from `test/losFixtures.ts`).
  `test/sqlstats.workers.test.ts` pins the SQL row-cost accounting (attribution to
  the public method, helpers billed to their caller, the `/api/sqlstats` shape);
  the "derived data" block in `los.workers.test.ts` pins `counts`/`rank` upkeep and
  the one-time migration (`ensureDerived`), and its "private profiles" block pins
  the hidden-profile behaviour end to end (the rankless tail and its paging,
  search, the recency ordering, the admin's true-order view, the player reads, the
  query plans behind both halves of the page, and the flag surviving an upload
  and a rebase); `test/losCost.workers.test.ts` is the row-cost guard described
  in the `los/losDO.ts` file-map row; a "ranking sort" block covers ?sort=/?dir= (the default unchanged and echoed, an unknown key falling back, # ascending ≡ LOS descending, both movement columns both ways with the no-baseline rows last in EITHER direction, `rank` staying the player's standing rather than their place in the sorted page, the public tail left unsorted, and a search ordered by the same rule);
  a "rank history" block covers the `rank_history` table and the two 7-day change
  columns (one snapshot per UTC day and no more; no change at all while nothing is
  old enough to compare with; the admin rebuild redrawing 8 days from the game log,
  idempotently, and the movement it derives — including the permutation invariant
  that rank changes over an unchanged population sum to zero; a player who had not
  played by the baseline getting NULL rather than a fabricated zero; the movement
  surviving a private row's redaction; reset and retention clearing it);
  an "inactive players" block covers the lapsed half of that tail
  (unranked but in NO way hidden, SQL-paged, ranked again on playing, and
  re-derived by the time-based sweep with no upload involved). NOTE its fixture
  games are dated **relative to today** (`day()` / `staleDay()` in
  `los.workers.test.ts`), not pinned to a month — hard-coded dates would lapse
  every fixture player, and every ranking assertion with them, once real time
  moved past `INACTIVE_DAYS`. `test/ui.test.ts` pins the
  inlined pages' markers — including both admin row menus (the ranking's private
  toggle and the games table's re-run/ignore pair), the modal dialog that
  replaced `alert`/`confirm` on both pages, and the player page's private
  notice. `los.workers.test.ts`'s "ignoring a game" block pins the marker end to
  end: that the toggle moves no rating, that the re-run is what acts on it, and
  that clearing it and re-running restores the store exactly.

Beyond the tests, verify protocol behavior with `connect-test` against the real server,
and the Worker via `/battles/:battle/status` + `/battles/:battle/log`.
