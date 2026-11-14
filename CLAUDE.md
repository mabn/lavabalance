# CLAUDE.md — lavabalance

Quick reference first; the detailed reference (rationale, history, per-feature notes) follows under "Reference". Subdirectories have their own CLAUDE.md.

## OVERVIEW
Team-balancing bot + rating site for Beyond All Reason's LAVA lobby. Cloudflare Worker (Hono) + SQLite Durable Objects; the bot is a plain Node process in a Cloudflare Container. TypeScript, pnpm, vitest. No frontend build: pages are server-rendered strings with vanilla JS.

## STRUCTURE
```
./
├── src/index.ts        # Worker entry: routes, cron (keeps bot alive), DO exports
├── src/ui.ts           # every HTML page (STYLES / SHARED_JS / sidebar), ~6k lines
├── src/bot/            # the Node bot (see src/bot/CLAUDE.md)
├── src/los/            # LosDO store + LOS API (see src/los/CLAUDE.md)
├── src/lavaos/         # rating engine, pure (see src/lavaos/CLAUDE.md)
├── src/protocol/       # Spring lobby protocol (see src/protocol/CLAUDE.md)
├── src/balance/        # balancer: pure, party/avoid aware
├── src/rating/         # legacy Lavabar rating cache (RatingsDO); /api/scores only
├── tools/              # Node CLIs via tsx (scrape, upload, backfills, fits, connect-test)
├── test/               # vitest unit + workerd suites (see test/CLAUDE.md)
├── container/          # shell config copied into the bot image
├── public/             # static assets (ranks = CC BY-NC-ND, keep License.txt)
└── docs/               # data model, protocol notes, dated rating analyses
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Add/change a route | `src/index.ts`, `src/*Routes.ts`, `src/los/index.ts` | sub-apps mounted into the main Hono app |
| Change a page | `src/ui.ts` | `test/ui.test.ts` pins page markers |
| Lobby list/detail data | `src/teiserver.ts` (pure parse) + `src/teiserverDO.ts` (session) | `src=teiserver` default; `rtsapi`, `proxy` alternates (`SRC_MODES`) |
| LOS shown in a lobby | `src/lobbyView.ts`, `src/losRatings.ts` | one bulk `playersByNames` RPC; degrade, never 502 |
| Lobby state machine | `src/tracker.ts` (`SessionTracker`), `battle.ts`, `user.ts` | shared VERBATIM by Dispatcher DO and bot |
| Admin auth | `src/access.ts` | Cloudflare Access JWT (`ACCESS_AUD`); bot uses `ACCESS_BOT_AUD` service token on `/api/bot/*` |
| Website login | `src/auth.ts`, `src/authRoutes.ts` | `.login` whisper → one-time link; session cookie `__Host-lb_session` |
| Avoid lists / scouting / polls | `src/avoids.ts`, `src/scout.ts`+`scoutRoutes.ts`, `src/polls.ts`+`pollRoutes.ts` | pure half + routes half |
| Game-start roster | `src/gameStart.ts` | wire shape shared by bot uplink, LosDO, lobby view |
| SQL cost accounting | `src/sqlStats.ts`, `/sql` page | wraps `ctx.storage.sql.exec` |
| Env / vars / secrets | `src/config.ts` (`Env` extras), `wrangler.jsonc`, `BOT.md` | |
| Bot operations | `BOT.md` | chat commands, env, SSH, logs, deploy |

## CONVENTIONS
- **Pure vs runtime split.** Logic that imports `cloudflare:workers` lives in `*DO.ts`; parsing/rules live in a sibling pure file (`teiserver.ts`/`teiserverDO.ts`, `ratingsClient.ts`/`ratingsDO.ts`, `los/losGames.ts`/`losDO.ts`). Keeps the pure half testable in the Node pool. Never merge them.
- DOs `extends DurableObject<Env>`; state via `this.ctx.storage`. All DOs are singletons (`idFromName("singleton")`), except `BotContainer` (`"bot"`).
- DO RPC that can fail upstream returns errors as values (`TeiserverDO.lobbies()` → `{ok:false,error}`), not throws: a throw across RPC logs as a bare `Uncaught (in promise)`.
- Extensionless imports only.
- Runtime types: `worker-configuration.d.ts`, regenerate with `pnpm exec wrangler types --strict-vars=false` after editing `wrangler.jsonc`. Optional vars/secrets are re-declared in `src/config.ts`.
- `tools/` and `src/bot/bot.ts` are outside tsconfig (Node `node:*`, no `@types/node`); run with `tsx`.
- Upstream fetch failures name the request (`<svc> <METHOD> <path>`) and separate timeout vs HTTP error. Public upstreams are traced `→`/`←` always; the Teiserver scraper only with `DEBUG=true` (password redacted).
- Non-admins never see raw LOS: tiers only, stripped server-side (`los/tiers.ts` `stripLos`).

## ANTI-PATTERNS (THIS PROJECT)
- Gating dev-only features on request URL/hostname. Use env vars in `.dev.vars` (`DEV_LOGIN`, `ADMIN_OPEN`); wrangler rewrites `request.url` in dev.
- Adding `@types/node` (pollutes the Worker typecheck).
- Keeping must-survive state only in DO memory (evictable).
- Naming a DO method `connect` or `fetch` (clash with base class).
- Committing `.dev.vars`, `.env`, `*.log` (except `test/fixtures/*.log`), `data*/`.
- Putting personal account emails or credentials in `wrangler.jsonc`: secrets via `wrangler secret put` (`BOT_PASSWORD`, `TEISERVER_EMAIL`, `TEISERVER_PASSWORD`, `CONTROL_TOKEN`, `ACCESS_BOT_CLIENT_*`).

## COMMANDS
```bash
pnpm install
pnpm run typecheck        # tsc --noEmit
pnpm test                 # unit (Node) + workers (workerd)
pnpm run dev              # wrangler dev, localhost:8787; settings in .dev.vars
pnpm run bot              # bot locally; credentials in .env (see .env.example)
pnpm run deploy           # Worker + container image (needs Docker)
pnpm exec wrangler deploy --containers-rollout=none   # Worker only
pnpm run bot:kick         # restart bot now (needs $CONTROL_TOKEN)
pnpm run bot:logs -- --hours 3 > logs.json   # bot container stdout as structured JSON (CLOUDFLARE_API_TOKEN, else your `cf auth login`)
```

## NOTES
- **Deploy scope.** Bot code changes need the full deploy (container rebuild); Worker-only leaves the old bot image running. The bot reads secrets/vars only at container start: restart it after `wrangler secret put`.
- A secret can't be created while a var of the same name is deployed (code 10053): deploy the var removal first.
- Cron (`*/5`) restarts the bot after any non-fatal exit; exit code 42 = fatal (bad login/config), stops retries until `POST /bot/start`.
- Container stdout is not in `wrangler tail`; it's in the dashboard Logs and the Workers Observability API (dataset `containers`), which `pnpm run bot:logs` reads (`tools/botlogs/`; `--hours`, `--since/--until`, `--ndjson`, `-o`). The bot writes EVERY stdout line as one JSON object: `logEvent` for its own events, `chat()` for chat (`kind: "chat"`, `channel` = `game` (in-game, `via` = the relaying host) / `lobby` / `whisper` (`direction` in/out, `to`; the bot's own whispers included) / `channel`, plus `cmd`, `from`, `text`), and the console wrapper turns anything else into `{ts, level, msg}`. Keep new output in that shape. `bot:logs` passes these through and still parses the older text lines.
- `wrangler deploy --dry-run` still needs Docker unless `--containers-rollout=none`.
- Some sandboxes block outbound TCP :8200; test the bot from a normal network.
- The Dispatcher's `src=proxy` view is fed only by `ingest()` (tests); empty in production.

# Reference

## barreplay's game summary (imported at view time)

The game page's summary section is barreplay's own code (mabn/barreplay
`worker/src/summary/embed.ts`), loaded with a dynamic `import()` of
`https://replay.fogofwar.dev/embed/summary.js` when the slot nears the
viewport. That URL is a no-cache loader re-exporting barreplay's current
fingerprinted build (CORS-open), so a barreplay deploy reaches this page with
no change, pin or redeploy here; nothing of it is in this repo or its build.
Its `mountGameSummary(el, gameId)` finds the replay's revision on
replay.fogofwar.dev and its insights file on cdn-bar.fogofwar.dev, so where
barreplay keeps things is barreplay's business. Only `replay.published` games
try it (insights files run to megabytes); a game whose summary is not built yet
leaves no trace, and a load or mount failure only shows an error inside the
slot (the import is wrapped in try/catch). Its colours are the `--brs-*` custom
properties, overridden on `.summary-slot .brs-root` in `STYLES`. A clicked
moment plays in barreplay's clip window over the page (an iframe of
`/replays/<id>?embed=clip`); "Open in Replay" opens the replay at that moment in
a new tab.

## Architecture

```
HTTP ─▶ Worker (src/index.ts, Hono control plane, bearer auth)
          ├─▶ single Durable Object  getContainer(env.BOT_CONTAINER, "bot")
          │      BotContainer (src/botContainer.ts) — THE BOT'S SUPERVISOR
          │      • a @cloudflare/containers `Container` DO: starts/stops ONE
          │        container instance (./Dockerfile = `tsx src/bot/bot.ts`),
          │        hands it BOT_LOGIN/BOT_PASSWORD/… as env vars
          │      • `desired.running` in DO storage; onActivityExpired() renews
          │        (never idles out); the cron trigger (*/5 min → `scheduled`)
          │        calls ensureRunning() so platform restarts don't kill the bot
          │      • POST /bot/start|restart|stop, GET /bot/status
          │      • the bot process inside: own TCP session to Teiserver, chat
          │        commands, .balance moves, and the idle lobby finder (in no
          │        battle → join a lava+unranked Supreme Isthmus v2.1 lobby
          │        with 8+ players, src/bot/idleLobby.ts) — see `src/bot/bot.ts` below
          ├─▶ single Durable Object  env.DISPATCHER.idFromName("singleton")
          │      Dispatcher (src/dispatcher.ts)
          │      • persisted runtime config (lava_lobbies) + auto-pick throttle
          │      • a SessionTracker view fed ONLY via its ingest() RPC (tests);
          │        the WebSocket tap / proxy / bot uplink were removed, so the
          │        src=proxy lobby view is empty in production
          ├─▶ single Durable Object  env.TEISERVER.idFromName("singleton")
          │      TeiserverDO (src/teiserverDO.ts)
          │      • backs GET /api/lobbies?src=teiserver
          │      • holds a logged-in session (cookie jar) to Teiserver's web UI
          │        and scrapes /battle/lobbies[/show/:id] on demand
          ├─▶ single Durable Object  env.RATINGS.idFromName("singleton")
          │      RatingsDO (src/rating/ratingsDO.ts)
          │      • owns the Lavabar player-rating cache, persisted in SQLite
          │      • backs POST /api/scores + the bot's chat commands; Lavabar
          │        fetches are isolated on this DO's own subrequest budget
          │        (fixes "Too many subrequests by single Worker")
          └─▶ single Durable Object  env.LOS.idFromName("singleton")
                 LosDO (src/los/losDO.ts)
                 • the whole LOS store + single writer (SQLite): games,
                   game_players, players, meta — merged from the former
                   separate lavaos Worker
                 • backs the LOS public API (src/los/index.ts routes) AND the
                   detail view's rating resolution (losRatings.ts →
                   playersByNames RPC)
                 • also holds the bot-uploaded game-start rosters (lobby_states
                   table, POST /api/gamestart|gameend) the lobby detail view
                   freezes on while a game runs
```

- **The RatingsDO is a singleton** (`idFromName("singleton")`): one persistent
  SQLite-backed rating cache shared by all sources.
- **The bot runs in a Container, not a DO** (`BotContainer`, one instance named
  `bot`; one bot account = one lobby session, Teiserver rejects duplicate logins).
  Why: a resident Durable Object is billed 128 MB of duration for every second it
  is alive (~324k GB-s/month 24/7), whereas a `lite` container (1/16 vCPU, 256 MiB)
  runs the unmodified Node bot for roughly $1.70/month on the Paid plan. A
  bot-as-a-DO PoC (`LavaBot`, `cloudflare:sockets` + alarm heartbeat, migration
  v7) was built first and is in git history (commit 6363918) should it ever be
  wanted again. **Keeping the container up without requests**: nothing routes HTTP
  to it, so (1) `desired.running` is persisted, (2) `onActivityExpired()` renews the
  activity timeout instead of stopping, (3) the Worker's cron calls
  `ensureRunning()` every 5 min — Cloudflare guarantees no instance lifetime (host
  restarts, image rollouts on every deploy send SIGTERM; the bot handles it and the
  cron restarts it, so each deploy = one re-login). Disk is ephemeral (the bot's
  `commands_*.log`/`bot_*.log` files vanish on restart; stdout goes to Workers logs). **Not yet
  verified live**: the Containers docs only spell out port rules for
  `enableInternet=false` (80/443/DNS); with the default `true` "internet access"
  is allowed; plain TCP to :8200 is not explicitly documented but VERIFIED to work
  (first deploy 2026-09-05: the bot connected and got Teiserver's reply).
- **The Dispatcher is a singleton** (`idFromName("singleton")`). The upload path
  into it is GONE: the TCP proxy (`tools/proxy.ts`), the bot's uplink
  (`src/bot/bot_uplink.ts`), the `/dispatcher/ws` WebSocket sink, the dev replay
  launcher (`tools/dev.ts`, `/dispatcher/ready`, `REPLAY_GATE`) were all removed
  once the container-hosted bot became the lobby client itself. (The bot's
  new `src/bot/uplink.ts` is NOT that protocol uplink coming back: it is two
  one-shot HTTP POSTs — the game-start roster and the game-over notice — to the
  open `/api/gamestart|gameend` routes, stored in the LosDO.) What remains: the
  persisted runtime config (`lava_lobbies`, used by the teiserver/rtsapi sources
  and `/admin/config`), the auto-pick throttle, and the `SessionTracker` view
  behind `src=proxy` — fed only by the `ingest()` RPC, which the workers tests use.
  In production `src=proxy` is therefore empty; either feed it from the bot later
  or drop the mode.

## Server (hard-coded)

`src/config.ts` `LOBBY_SERVER`: **server4.beyondallreason.info:8200**, Spring
protocol, **plaintext (no TLS)** (BAR / byar). Only this one server is supported.

## Control plane (Hono, `src/index.ts`)

| Method & path | Purpose |
|---|---|
| `GET /` | **Redirect: land IN a lobby.** Resolves the same source + lava filter as `/api/lobbies` (carrying `?src=`/`?all=`) and 302s to `/lobby/<first lobby's id>`, so the URL bar ends up on the lobby. With no open lobby, or a failing/invalid source, it serves the list page instead (whose own fetch shows the empty/error state — with a **"Select a lobby"** button to `/lobbies` — that fallback is the list page's ONLY entry; there is no menu item for it). The sidebar's "Lobby" item points here; any other lobby opens directly by id at `/lobby/:id`. **Auto-pick** (`src/autoLobby.ts`): when `lava_lobbies` is EMPTY, this route first asks Teiserver's lobby index for open lobbies whose name contains `lava` (case-insensitive) and configures the one with the most players as the sole `lava_lobbies` entry — at most **once per 5 minutes** (`Dispatcher.claimAutoPick`, a check-and-set timestamp in DO storage, so the limit holds across isolates; a failed/empty lookup spends the slot too). Nothing happens while at least one lobby is configured, even if it is closed. |
| (lobby pages) | The **Auto-refresh** toggle in the header of `/`, `/lobbies` and `/lobby/:id` is **admin-only**: hidden by CSS outside **admin mode** (the same `body.admin-mode` switch as the SQL entry; see "Superadmin" below), and the 3s timer never runs without it, whatever the stored `autoRefresh` preference says. |
| `GET /lobbies` | HTML UI: the **lobby picker** — every open lobby on Teiserver with at least one player (`/api/lobbies/all`) as a table: name, `#id`, map, status badges (in lobby / in progress, locked, password), players, spectators; lobbies with `lava` in the name first (their names in the button's orange), then most players first. A click on a row (or its name link) opens `/lobby/:id` (carrying `?src=`/`?all=`) — which, for a lava-named lobby, adopts it as the configured lava lobby via the detail endpoint's side effect (below). Reached from the "Select a lobby" button in the lobby pages' empty states and from the orange-ringed **"🔎 View all lobbies"** header button that sits left of the Auto-refresh toggle on `/` and `/lobby/:id`. |
| `GET /ranking` | HTML UI: the paged **LOS leaderboard** (polls `/api/ranking`; every rated player — no min-games filter; Prev/Next pager with the player count and a 10/20/50/100 per-page dropdown (default 50, `?per=`) in a toolbar ABOVE the table — the same controls as the games tables). A **search box** next to the pager (left group) filters by name **prefix** as you type (trailing 500 ms debounce → at most one request per half second of typing; stale responses dropped; `?q=` kept in the URL alongside `?page=`; a new query resets to page 1). The filter is server-side (`/api/ranking?q=`), so `#` stays each player's **overall** rank. Every row links to `/player/:userId`. The list is the ranked players **and then a rankless tail**, most recently seen first, holding everyone the leaderboard leaves out for either of two reasons: a **private profile** (orange `private` badge; a `–` for the rank AND the LOS, and no BAR OS — games / W–L / Win% / Last game stay, since the public games list already tells anyone that) or an **inactive** one (gray `inactive` badge; no rated game in 35 days — the rank is a `–` and **nothing else changes**, the rating and the record are as public as ever). See "Private profiles" and "Inactive players" below. `#` therefore counts only the ranked players and has no gaps. In **admin mode** the page reads `/api/ranking?includePrivate=true` instead and gets the leaderboard **as it really is** — every player in their true place with their true rank and rating, the badges only marking which rows a visitor sees differently — and every row grows an admin-only **`⋯` actions column** on the right (the shared row menu — `rowMenuCell`/`rowMenuActions` in `SHARED_JS`, which the games table uses too; same `admin-col` CSS switch) whose menu offers **Make private** / **Make public** (`POST /api/players/:userId/private`, then a reload — the toggle shifts every rank below it). |
| `GET /games` | HTML UI: the paged **games table** (`/api/games?page=N&limit=M`, newest first, 20 per page by default with a 10/20/50/100 dropdown, pager ABOVE the table; `?page=`/`?per=` kept in the URL): started (local time, `1 Sept, 21:05`), duration, **LOS** = each team's pre-game average LOS as `20.5 vs 22.1` in the team colours with the winning side's number ringed by a **gold pill-shaped outline** (text keeps its team colour) (both numbers share the pill's padding in a fixed grid, so they align; dashes on ignored games), **%** = the winning team's pre-game predicted win chance (a `(?)` hover explains it; from the list's per-game `predictedWin`; gray above 75% = expected, bright green below 25% = upset, bold below 15%; no red here, every row is somebody's win), the rosters (three strongest names per team + `+N`, names link to `/player/:userId`), and the **Links** column: **OTL** (`onetricklava.com/games/<id>`), **BAR**, and — for games barreplay has — **replay** (`replay.fogofwar.dev/replays/<id>`, watchable in the browser). That third slot is resolved SERVER-side (the page asks `/api/games?…&replays=true`, see the LOS API row) so it is right the first time the row is drawn, and shows one of three things: the link when the replay is published, an ⏳ with a tooltip while barreplay is re-simulating the game (`jobState = processing`), and nothing at all otherwise — most games have no replay. The slot keeps its width in all three states so OTL/BAR do not shift from row to row. Any click on a row (outside its links) opens `/game/:id`; modifier-clicks open a new tab. In **admin mode** each row ends in a `⋯` **actions menu** (the shared row menu, same CSS switch as the ranking's): **Re-run LOS from here…** (`POST /api/games/:id/rebase`, asking in a modal dialog — with the off-map choice as a checkbox rather than a second confirm — and reporting the result in one) and **Ignore game** / **Un-ignore game** (`POST /api/games/:id/ignored`), which writes a marker and recalculates NOTHING: a marked game keeps its ratings until the fold is re-run from it, which the row badges "ignored · pending" and a note above the table says in words, with the re-run one click away. The note tracks EVERY outstanding marker and points at the earliest, because the fold runs forward from one game: a re-run started at a later game leaves an earlier marker exactly as it was, so only the markers a run actually reached are settled by it. |
| `GET /game/:id` | HTML UI: one game's page (`/api/games/:id`): matchup strip (team averages, LOS gap, the server's pre-game `predictedWin`, 🏆 on the winner), the facts row (started, duration, map, an `unrated` badge for ignored games, its tooltip the stored `unrankedReason` — off-map vs uploaded too late, Links: OTL + BAR + the server-resolved barreplay slot — a **replay** link or an ⏳ while it is being re-simulated; unlike the tables it reserves NO width for the empty case, a facts row having no column to hold open), and the two rosters side by side — every player (name → player page, faction) with a **LOS-before pill**, the **Δ LOS** the game caused (→ LOS after), and a **Games** column (their rated lava games so far, this one included). A player with a **private profile** shows a `–` plus the (?) hint "This player's profile is private" in place of the LOS-before pill and loses the `→ LOS after`; the **Δ LOS stays** (a change says nothing about the rating it moved). Admin mode shows the roster whole. Team averages come from the API (`avgLosBefore`), NOT from averaging the roster on the page: a mean taken from what is visible would silently drop the hidden player, and the gap between that and the full mean shown elsewhere would give their rating away by subtraction. 404 from the API renders as "No such game". Under the rosters, for a game barreplay has PUBLISHED, sits **barreplay's game summary** (who was winning, battles, awards, per-player reports) — see "barreplay's game summary" below. |
| `GET /player/:userId` | HTML UI: one player's **LOS profile** — a profile card (LOS pill, rank #N of M over ALL rated players — the same unfiltered set the ranking shows — W–L, μ/σ, first/last game, BAR OS), the **LOS-over-time chart** (vanilla canvas over `/api/players/:id/history`: win/loss dots, hover crosshair + tooltip; the **X axis** is switchable with a Time / Games segmented toggle under the axis — time = the game's start timestamp up to the end of today, games = the 1..N ordinal, equidistant; preference persisted as `chartAxis`; X ticks are as many as the width fits (~70px apart) at calendar-aligned UTC steps (hours/days/Mondays/months/years) in time mode and 1-2-5 ordinal steps in games mode, with faint vertical grid lines — and **zoomable on X only**: drag a range on the canvas to zoom into it, double-click or "reset zoom" to restore; switching modes resets the zoom), and **every game they played**, paged 10 at a time by default (10/20/50/100 dropdown) with the pager above the table (`/api/players/:id/games?page=N&limit=M` → `{games, page, perPage, total}`; each entry = the full list-shape game + `team`/`won`/`losBefore`/`losAfter`/`losDelta` — the same rows `/api/players/:id` still serves as its first-20 `recentGames`) in the `/games` table layout seen from this player: started, duration, W/L, **their side's** pre-game win chance — coloured like `/games` but keyed to the chance of the RESULT THIS PLAYER GOT (the shown win chance when they won, its complement when they lost): gray above 60%, plain in between, and below 25% the upset takes the player's side — green for one they won, red for one they lost — bold under 15% (the number shown is always the win chance), their LOS-before pill, Δ LOS, both rosters with the player leading their side in bold+underline, and a **Links** column on the right carrying the same server-resolved barreplay slot as the `/games` table (`replayCell` → `replaySlot`: a **replay** link, an ⏳ while it is being re-simulated, or nothing; the page asks `…/games?…&replays=true`); rows open `/game/:id`. 404 from the API renders as "no rated lava games yet". A **private profile** shows a non-admin visitor a 🔒 "<name>'s profile is private" card where the profile card and the chart would be, and its games table keeps every row but drops the **LOS before** and **Δ LOS** columns (the win-chance column stays — it is the game's own prediction, public on `/games` whoever asks). Admin mode shows the whole profile, badged `private`, with its TRUE rank. An **inactive** profile (35 days without a rated game) is completely public and simply shows a `–` for the rank, with a gray `inactive` badge and a tooltip saying why. Note "#N of M" means what the ranking the reader came from means: a visitor's position among the ranked players (`public_rank` / the ranked count), an admin's over everyone (`rank` / all players). |
| `GET /sql` | HTML UI, **admin-only** (admin mode): the **SQL stats** page — what each method of the two SQLite-backed DOs (RatingsDO, LosDO) has cost in SQLite rows since its instance started, one table per DO (calls, rows read/written, per-call averages, and each method's spend projected onto the Workers Free plan's daily budgets — 5M reads / 100k writes per account — with a grand total across the DOs) + Reload. Ported from barreplay's SQL tab. The sidebar's 🗄️ SQL entry is hidden outside admin mode (SHARED_JS marks `<body>` `admin-mode`); there the page fetches nothing and offers the admin login. `GET /api/sqlstats` itself is admin-only (401 otherwise). |
| `GET /api/sqlstats` | JSON behind the SQL page: `{dos: [{name, description, since, elapsedSec, ops: [{op, calls, rowsRead, rowsWritten}], totals}]}`, one entry per DO (`RatingsDO`, `LosDO`), ops most expensive first. **In memory only** (`src/sqlStats.ts`): persisting a measurement of the write budget would spend it, so each DO's window is its own instance lifetime (deploy/eviction resets it) and `since` says when it started. Unauthenticated (method names + counts). |
| `GET /lobby/:id` | HTML UI: the single-lobby **detail** view — a dense table per team (flag · name · skill · ready · **LOS**), (no back link). The page reads `:id` from its URL, polls **`/api/lobbies/:id`** (the single-lobby endpoint, which resolves **LOS** ratings), and renders it (or a "not open" note). Served for any `:id` (the client resolves existence) — and the API serves ANY open battle id, so e.g. `/lobby/1627` works for whatever lobby 1627 is. Also carries the **matchup strip** (team average LOS + OpenSkill win probability, both computed server-side) above the two rosters. While a game runs and the bot uploaded its launch roster, the tables show the **game-start roster** by default with a **📌 at game start / 🛋️ live lobby toggle** in the title bar (see `POST /api/gamestart` below); the toggle refetches with `?roster=live` — never re-shuffles client-side — and disappears (resetting to the bot view) once the upload is gone. The old "📊 Fetch scores" button, skyride profile links, hidden-rating pills and the fitted elo swing were removed with the LOS switch. |
| `GET /api/lobbies[?src=…][&all=true]` | JSON backing the UI's **list** page: each tracked battle's lobby status + players, in one shape regardless of source. **Does NOT resolve Lavabar ratings** (the list doesn't show them; resolving every player across every lobby was a large fan-out that overflowed SQLite's 100-param limit) — per-player `rating`/`ratingPlayerId`/`games` are null here. **`src` selects the source**; the set of enabled sources and the default (used when `src` is omitted) come from the `SRC_MODES` var (`enabledSrcModes` in `src/config.ts`): a comma-separated list whose **first entry is the default**, with any known mode not listed **disabled** (its requests → **`400`**, same as an unknown value). `SRC_MODES = "teiserver,proxy,rtsapi"`, so the default source is `teiserver`. Sources below. **`all=true`** returns **every** open battle on the server instead of just the configured `lava_lobbies` (each source drops its lava filter). The UI (`/`) propagates its own `?src=`/`?all=true` params to this call. |
| `GET /api/lobbies/all` | JSON behind the picker page: Teiserver's own `/battle/lobbies` index rows (`TeiserverDO.lobbyIndex()` — one cheap scrape, no per-lobby roster pages; the `IndexLobby` shape: `id, name, map, inProgress, locked, passworded, memberCount, playerCount, spectatorCount`) filtered to `playerCount >= 1`, lava-named lobbies first, then most players first. Always the Teiserver index regardless of `SRC_MODES` (it is the server's list, not a lava view); no `?src=`. Registered before `/api/lobbies/:id` so `all` isn't parsed as an id. Login/upstream failure → `502`. |
| `GET /api/lobbies/:id[?src=…][&all=true]` | JSON backing the **detail** page: ONE lobby (by id), in the same shape, **WITH LOS ratings resolved** — one bulk `playersByNames` RPC to the singleton LosDO (`src/losRatings.ts`) for that lobby's roster, applied by `finalizeLobby` (`src/lobbyView.ts`): per-player `los`/`losGames`/`losUserId`/`losHandicap` (the rookie mu discount, 0 once established) plus per-team `teamStats` (mean LOS, `assumed` count, and — two-team lobbies — each side's OpenSkill `winProb` via `predictWin`, rookie handicap included). A LOS lookup failure only degrades the roster to unrated (never a 502). Returns the lobby object, or `null` when the id isn't an open battle. **Side effect — adopting the lava lobby** (`adoptLavaLobby`, `src/autoLobby.ts`, run via `waitUntil` after the response): if the viewed lobby's title contains `lava` and it isn't already configured, it REPLACES `lava_lobbies` with `[id]` — but only when nothing is configured, or no configured lobby is still open with players per Teiserver's index (the configured lobby is **sticky until empty or gone**; an index failure keeps the current config). This is how the `/lobbies` picker sets the main lobby. **No lava filter**: an explicit id is an explicit ask, so every source runs in its all-battles mode here (the configured-lava filter applies to the LIST only). Same source delegation as the list (default + enabled set from `SRC_MODES`); disabled/unknown `src` → `400`, non-numeric id → `400`, upstream/login failure → `502`. The sources themselves no longer attach any rating (src/rating is NOT used for this view). **Game-start roster substitution** (`src/gameStart.ts`): if the LosDO holds a fresh bot-uploaded snapshot for this battle (fresh = within the 3h TTL AND the live lobby says `inProgress`, softened by a 2-min post-launch grace), the response carries the LAUNCH roster in place of the live one (lobby-level facts stay live; `party` merged from the live roster by name; `finalizeLobby` runs over the substituted players so `teamStats`/`winProb` match the shown tables). `?roster=live` skips the substitution. The response says which body it is: `rosterSource: "bot"|"live"`, plus `botRoster: {gameStartAt, botBalanced}` (set on BOTH views while a fresh snapshot exists, null otherwise — what the page renders the toggle from). A snapshot lookup failure degrades to the live roster. |
| &nbsp;&nbsp;`src=teiserver` (default) | Delegated to the singleton **`TeiserverDO`** (`lobbies()` for the list, `lobby(id)` for the detail): a logged-in session to Teiserver's **web UI** that scrapes `/battle/lobbies` + `/battle/lobbies/show/<id>` (Phoenix LiveView dead-render HTML), filtered to the configured `lava_lobbies` (Dispatcher consulted only for that id list via `getConfig`). See `src/teiserver.ts` (pure parse/map) + `src/teiserverDO.ts` (the DO). Richer than the rtsapi scrape: `ally` from the page's "Team" (side) column so lobby teams group, `boss` from the boss list, per-player `party` (the Party column's cell colour as an opaque key — it doubles as the party's display colour), lobby-level `balanceAlgorithm` (the consul's "Balance algorithm" line — TEISERVER's own setting, e.g. `auto`/`loser_picks`, and NOT the SPADS `autoBalance` that decides whether the bot may force teams; the lobby page labels it "Teiserver balance algorithm" because a bare "Balance algorithm: auto" was read as the latter) and `inProgress`/`inProgressSec` (elapsed match seconds, parsed from the show page's "Match in progress - `[Nd ][H:]MM:SS`" heading). Other sources carry the same lobby/player keys with `party`/`inProgressSec`/`balanceAlgorithm` null (proxy/rtsapi derive `inProgress` from the founder's in-game bit). Gaps (not rendered for a normal account): `founder`/`gameName`/`engineVersion` → `""`, `rank`/`away`/`sync` → null/false/0, `team` (unique slot, moderator-only) → 0. `skill` = the page's "Rating" (OpenSkill) column. Login/upstream failure → `502`. |
| &nbsp;&nbsp;`src=proxy` | The **Dispatcher DO's** own view (`lobbies()` / `lobby(id)`), rebuilt from the proxied protocol stream. Battle-specific fields from the battle roster; room-independent ones (skill/OS, `rank`, `inGame`, `away`) from the global user directory (`UserRepository`). |
| &nbsp;&nbsp;`src=rtsapi` | Handled by the **Worker**: fetches the public BAR battle list from `https://api.bar-rts.com/battles`, filtered to `lava_lobbies` (`lobbiesFromRtsApi` for the list, `lobbyFromRtsApi` for the detail). See `src/rtsapi.ts`. Public-API gaps: **no allyteam** (each player has a unique `teamId` SPADS slot only → everyone `ally:0`), and no `engineVersion`/`sync`/`bosses`. `spectator` from a missing `teamId`; `skill` parsed from the bracketed OS string; `rank` shifted from bar-rts's raw 0-7 to the 1-8 display level. Upstream failure → `502`. |
| `POST /api/scores` | Bulk Lavabar elos (kept as an API + for the RatingsDO cache the bot ecosystem uses; the web UI no longer calls it — its button was removed with the LOS switch). Body `{"names": ["huk123", …]}` (bare array works too) → `{scores: {<lowercased name>: <public record> \| {"hidden": true}}, unknown: [...], cached: bool}`. Always fetches the balance endpoint (explicit user action, ≤16 names — trimmed, de-duplicated, capped server-side; over the cap → **400**) and records the elos into **`rating_hidden`** via `putScores`; serves the cache with `stale: true` only when the upstream fails, **502** when there's nothing cached either. A player without a public rating is `{"hidden": true}` — elo attached only with `?show_hidden_score=true`. |
| `POST /api/gamestart` / `POST /api/gameend` | The bot's **game-start uplink** (`src/bot/uplink.ts` → these routes; shared shape/validators in `src/gameStart.ts`): the container bot POSTs the FULL tracked roster (spectators included) the moment the founder's in-game bit goes 0→1, and a game-over notice on the host's verdict or the in-game bit dropping. Stored per battle id in the LosDO's `lobby_states` table (idempotent overwrite; lazily TTL-reaped at 3h); `gameend` deletes the row (idempotent). Consumed by `/api/lobbies/:id` above. **Open endpoints for now** (auth deferred, like the LOS API) — the strict payload validators are the only gate; 400 on garbage. |
| `GET /api/avoids/list` · `GET /api/avoids/pairs` · `POST /api/avoids/add|remove|reset` | **Avoid lists** (`src/avoids.ts`): "don't put me on the same team as X", one row per request in the LosDO's `avoids` table. `list?player=` is one person's own list (`{owner, entries, limit}`); `pairs?names=a,b,…` is what the balancer asks before every `.balance` — every entry touching the roster, plus `pairs`, the ones BOTH of whose people are in it; `add`/`remove` take `{player, avoid}` and are what the bot's `.avoid <player>`/`.avoidremove <player>` whispers call; `reset?confirm=true` wipes every list. Refusals are VALUES, not errors, so the bot can word each one: 404 `unknown-player` (with near misses — the target must be someone the ranking has rated), 409 `duplicate` / `self` / `limit` (10 per player). **Behind the control token** (`requireControlToken`, when `CONTROL_TOKEN` is set) unlike the open gamestart upload: a write here edits somebody else's list in their NAME, and only the lobby session proves who is asking — the bot gets the token as `BOT_CONTROL_TOKEN` from `BotContainer`. The lobby page never calls these: its admin view gets the roster's entries from `/api/lobbies/:id`. |
| `POST /api/scout/profiles` · `GET /api/scout[/:userId\|/boards]` · `POST /api/scout/reset` · `GET /scouting` | **Scouting** — onetricklava's play-style cards: the push (OTL's Access service token, verified against `ACCESS_SCOUT_AUD`, or an admin), the public reads (private LOS profiles filtered for a visitor), the admin wipe, and the Scouting page. The lobby detail route carries the same cards as per-player `scout` + the lobby `scouting` report (lane forecast). See "Scouting" below. |
| LOS API: `POST /api/games`, `POST /api/reset`, `POST /api/games/:id/ignored`, `POST /api/rank-history/rebuild`, `GET /api/ranking` / `/api/games[/:id]` / `/api/players[?q=]` / `/api/players/lookup` / `/api/players/:userId` / `/api/players/:userId/history` / `/api/players/:userId/games` | The LOS public API (`src/los/index.ts`, mounted `losApp`) — see "The LOS public API" in `src/los/CLAUDE.md` section below. Unauthenticated (deliberate, incl. the writes); GETs edge-cached 60s. `GET /api/ranking?q=<prefix>` narrows the leaderboard to names starting with `q` (case-insensitive; `%`/`_` literal): `total`/paging cover the matches, each row's `rank` stays global (the materialized `players.rank` column; the match itself is a range scan on the existing NOCASE `idx_players_name` — keep the query free of an explicit `COLLATE NOCASE`, which would defeat it). There is no `minGames` parameter (removed 2026-09-01). Every ranking row also carries **`rankChange7d`/`losChange7d`** — positions and LOS gained over the last `changeDays` (7, sent with the list like `inactiveDays` is), positive = up the board, `null` when there is no snapshot that old to compare against; they read from the materialized `players.rank_change_7d`/`los_change_7d`, so a row costs nothing extra. **`?sort=`/`?dir=`** order the list by any sortable column, either way: `sort` one of `rank`/`los`/`rankChange`/`losChange`, `dir` `asc`/`desc`; an unrecognized value falls back to the leaderboard rather than 400ing (a stale or hand-written URL must still answer with a list) and the response ECHOES what it used, so a page marks the column the rows are really in. `rank` and `los` are one ordering under two names (`rank` is materialized FROM `los`, so "# ascending" ≡ "LOS descending"); both keys exist so each header reads naturally. Two things survive every sort: each row's `rank` stays the player's STANDING rather than their place in the sorted page (the rule the name search always followed — only possible because the position is materialized), and the public list's rankless TAIL is never reordered (ordering those rows by a rating would read as a ranking and, for the private ones, restore the standing the blanking removes — the sort reaches the head only). Every ordering is index-backed; see `los/losDO.ts` below and "Sorting the ranking" in the data-model doc. They SURVIVE the private-profile redaction (which nulls `rank` and every rating field) for the reason a private player's Δ LOS survives on a game roster: a movement says nothing about the rating or the position it moved. **`POST /api/rank-history/rebuild`** redraws the last 8 days of `rank_history` from the game log and re-derives those two columns from it — the ranking page's admin button, open like `/api/reset` and the rebase; it rewinds stored μ/σ and never re-runs the fold, so it cannot change anybody's LOS. **No read runs a `COUNT(*)`**: totals come from the `counts` table and ranks from `players.rank`, both maintained by the upload (see `los/losDO.ts` below) — DO SQLite bills per row read, and the old scans cost ~2,000 rows per ranking page and ~24,000 per search (`/sql` tab). `GET /api/games` pages two ways: the original keyset cursor (`afterTime`+`afterId`, from the response's `next`) or **numbered** (`?page=N&limit=M`, 1-based, OFFSET-backed — what the Games page uses); every response carries `page`/`perPage`/`total` (the total honours `rated=true`), and every listed game carries `predictedWin` (per-team pre-game OpenSkill win chance, null on ignored games — previously only on `/api/games/:id`). Mixing `page` with a cursor → 400. **`?replays=true`** (served by all three routes a replay link is drawn from — this listing, `/api/players/:userId/games` and the single-game `/api/games/:id`, through the shared `replayAnnotated` helper, so the flag means one thing everywhere) additionally annotates each game with `replay` — `{published, jobState}` from **barreplay**'s own `GET /api/games?id=` (one request for the whole page, `src/barreplay.ts`), or `null` for a game it does not know. Opt-in rather than always-on: it costs an outbound request the API's other readers have no use for, and the annotated and unannotated bodies must not share the 60s edge-cache key. The lookup is best-effort — barreplay being down costs the links, never the listing — and how long it took comes back as `Server-Timing: barreplay;dur=<ms>;desc="<n> asked, <m> known"` (the failure reason in `desc` instead when it failed). |
| `GET /bot` | HTML UI, **admin-only** (admin mode, the same switch as `/sql` — the 🤖 Bot sidebar entry is hidden outside it): the **bot admin page** — a prominent banner naming the lobby the bot is in (linked to `/lobby/:id`, title fetched once per battle id from the public detail endpoint; "not in any lobby" / "joining #N" otherwise), the container status (intent, platform state, last stop/error, the bot's own `/health` fields), **Start / Stop** buttons, a **Join main lobby** button (labeled with the configured lava lobby id from `GET /admin/config`) and a **join-by-id** field — both POST `/bot/join`. Polls `GET /bot/status` every 5s. The PAGE is public (registered BEFORE the `/bot/*` auth middleware in `index.ts` — Hono's `/bot/*` pattern matches bare `/bot` too, pinned by `test/botPage.workers.test.ts`); the status/start/stop calls it makes go through `requireControlToken`, which a signed-in superadmin's Access cookie passes; the page's control-token field (localStorage, sent as the Authorization header) is the alternative. |
| `POST /bot/start` / `POST /bot/restart` / `POST /bot/stop` / `GET /bot/status` | The bot container (bearer auth): start persists `running=true` and boots the container if it isn't up; restart persists `running=true`, stops the current instance (waiting for it to exit) and starts fresh — the manual bounce (`pnpm run bot:kick` POSTs it); after a deploy the cron restarts the bot within 5 min (a kick right after the deploy races the rollout); stop persists `running=false` and SIGTERMs it (the cron then leaves it alone); status = `{running, status, exitCode?, lastStartedAt?, lastStop?, lastBattle}` (`lastBattle` = the persisted restart-rejoin target) (`status` is the platform's instance state: `running`/`healthy`/`stopping`/`stopped`/`stopped_with_code`). The bot's own view is in its stdout (Workers logs) — `.info` whispered to it dumps everything it tracks. |
| `POST /bot/join` | Make the bot join a battle (bearer auth) — the HTTP twin of the `.join` whisper: relayed through `BotContainer.joinLobby(id)` to the bot health server's `POST /join`, which calls the same `requestJoin` as the chat command. Body `{battle: <id>}`, or an EMPTY body to join the current **main** lobby (the configured `lava_lobbies[0]`, auto-picked via `ensureLavaLobbyConfigured` when empty). Async on the lobby protocol: 200 = accepted (outcome lands in `/bot/status`'s `bot.battle`/`bot.pendingBattle`); 400 bad body, 409 no main lobby resolvable, 502 container down / bot refused (`error` says why; `status` = fresh view). |
| `GET /polls[/:slug]` · `/api/polls/*` | **Polls** (`/polls` 302s to the newest poll's `/polls/<slug>`; that page carries the poll's Open Graph / Twitter-card tags from `pollMetaTags` — "🗳️ Poll: <title>", the question, the 1200×630 `ogImage` — so a pasted link unfurls in Discord) (`src/polls.ts` definitions, `src/pollRoutes.ts` routes, page `POLLS_HTML`; sidebar 🗳️ Polls, above "Does it work?"). The polls themselves (title, question HTML, options with their column heading, picture under `public/polls/`, caption and colour) are CODE in `POLLS`, newest first; `/polls` shows the first, `/polls/<slug>` any. The LosDO stores only `polls` (`id`, `slug`, `created_at`; the row is created the first time a slug is read) and `poll_results` (one row per `(poll_id, user_id)`: `name`, `choice` = option key, `voted_at`, `updated_at`, `changes`), so a vote is one per BAR account and changing it overwrites. `/api/reset` leaves both alone. `GET /api/polls` lists them; `GET /api/polls/:slug` → `{poll, results: {total, counts, byTier}, myVote, user, voters?}` (no-store, per user); `POST /api/polls/:slug/vote` `{choice}` needs the website session (401 `{login: "/login"}` otherwise; foreign Origin 403; unknown choice 400; closed poll 409) and answers the same body plus `previous`. `byTier` splits the votes by the voter's CURRENT `players.tier` (`unrated` = no LOS row), shown to everyone with full counts (every tier has many players). Admins also get `voters` (name, tier, choice, when, how often changed). The tally is cached in the DO's memory (dropped on every vote, 10-min TTL for tier drift). The page: a column per option (picture, click to enlarge), single choice, a big **Vote** button and **View results** (open by default once you voted). Pressing Vote while logged out saves the pick (`pollPendingVote`) and the way back (`setLoginReturn` in `SHARED_JS`, localStorage, 30 min) and goes to `/login`; the login page returns there after a successful login (`goBack`) and the poll page casts the saved pick. Pinned by `test/polls.workers.test.ts`. |
| `GET /login` · `/api/auth/*` | **Website login with a BAR account** (`src/auth.ts`, routes in `src/authRoutes.ts`). No passwords: the player whispers `.login` to the bot, the bot calls **`POST /api/bot/auth/issue`** `{name, userId}` (userId = the Teiserver account id from `ADDUSER`) and whispers back the one-time link `/login?t=<token>` on the Worker's own host (single use, 5 min, a new link voids the account's previous one). `/login` peeks at the link (`GET /api/auth/link?t=` — never consumed on GET, so link prefetchers cannot burn or use it) and shows "Continue as <name>"; the button POSTs **`/api/auth/redeem`** `{token}`, which deletes the link and creates a session in ONE transaction and sets `__Host-lb_session` (HttpOnly, Secure, SameSite=Lax, 30 days). `GET /api/auth/me` → `{user: {userId, name} \| null, bot}`; `POST /api/auth/logout` ends this browser's session; **`POST /api/bot/auth/revoke`** `{userId}` (the bot's `.logout`) ends all of the account's. The two bot routes sit under `/api/bot/*`, which a SECOND Cloudflare Access application fronts (its own audience, `ACCESS_BOT_AUD` in wrangler.jsonc): the bot sends an Access **service token** (`CF-Access-Client-Id`/`-Secret`, from the `ACCESS_BOT_CLIENT_ID`/`ACCESS_BOT_CLIENT_SECRET` Worker secrets passed into the container as `BOT_ACCESS_CLIENT_*`), Access swaps it for `Cf-Access-Jwt-Assertion`, and `botIdentity` (`src/access.ts`) verifies that JWT against the bot AUD — no control-token fallback, and the admin cookie (other AUD) does not pass. They **fail closed** (503) when `ACCESS_TEAM_DOMAIN`/`ACCESS_BOT_AUD` are unset, because an open issue route would let anyone log in as anyone. Browser POSTs refuse a foreign `Origin`. Storage: the LosDO's `auth_links` / `auth_sessions`, keyed on the SHA-256 of the token (raw tokens are never stored); `/api/reset` leaves both alone. The link goes bot → player on purpose: a "site shows a code, you whisper it" flow can be phished into logging the attacker in as the victim. Nothing is gated on the login yet. Every page's header shows it in its top-right corner (`renderAuthBox` in `SHARED_JS`, drawn synchronously from localStorage `authUser` — no request, no layout shift; the login page writes it on login and whenever its own `/api/auth/me` answers, and both Log out buttons clear it): the logged-in name (→ their player page) and a **Log out** button, or a **🔑 Log in** link to `/login` for a visitor; there is no sidebar entry. **Dev-only fake login**: with `DEV_LOGIN=true` in `.dev.vars` (`devLoginEnabled`; the var is the only switch), `/api/auth/me` reports `devLogin: true`, `/login` grows a dashed "Dev mode" box at the bottom, and **`POST /api/auth/dev-login`** `{name}` logs in as any RATED player (real account id from the ranking, 404 for an unknown name) with no bot; otherwise that route is a plain 404. `wrangler dev` would hand the Worker request URLs on the first route's host (lavabalance.fogofwar.dev), so the browser's localhost Origin never matched and every login POST was refused locally; `"dev": {"host": "localhost:8787"}` in wrangler.jsonc keeps them on localhost. Never put `DEV_LOGIN` in wrangler.jsonc or a deployed secret. Pinned by `test/auth.workers.test.ts`. |
| `GET /health` | liveness |
| `GET /battles/:battle/status` | observation snapshot; a numeric `:battle` includes that battle's state (players + lobby status) |
| `GET /battles/:battle/log?limit=N` | per-battle message log, newest-first (default 100, max 1000). A numeric `:battle` returns only that battle's lines; a non-numeric `:battle` (e.g. `unrouted`) returns the Dispatcher's unrouted buffer |
| `GET /admin/config` | read the persisted runtime config |
| `POST /admin/config` | set the runtime config; body `{lava_lobbies: number[]}` (stored whole in the Dispatcher DO) |

Bearer auth on `/battles/*`, `/admin/*` and `/bot/*` when `CONTROL_TOKEN` is set
(a signed-in superadmin passes it too; `/admin/login` and `/admin/logout` are
registered before the middleware and need nothing).

### Superadmin (Cloudflare Access, `src/access.ts`)

Admin mode used to be `?admin=true` in the URL, a purely client-side switch with
open routes behind it. It is now an identity **Cloudflare Access** issued, the
same scheme as barreplay's:

- An Access **application** (Zero Trust dashboard, self-hosted) protects ONE
  path, `lavabalance.fogofwar.dev/admin/login`, with a policy naming who may sign
  in. Passing it leaves a `CF_Authorization` cookie for the whole hostname (a
  JWT Access signed); `GET /admin/login?next=<path>` then just redirects back
  (`loginNext`: on-site paths only). `GET /admin/logout` expires the cookie.
  The way in is a "🛡️ Login as admin" entry at the bottom of the left sidebar,
  shown only when the BAR login in localStorage is `huk123` (`SUPERADMIN_NAME`
  in `SHARED_JS`, hardcoded, a display convenience and not access control); in
  admin mode the same slot reads "🛡️ Admin · sign out" → `/admin/logout`.
- `adminIdentity` (`src/access.ts`) is the ONE check: `ADMIN_OPEN=true` (local
  dev only, `.dev.vars`), else the control token when configured and matching,
  else the cookie's JWT **verified** with jose (signature against
  `https://<team>/cdn-cgi/access/certs`, `aud` = `ACCESS_AUD`, issuer, expiry).
  `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` are `vars` in wrangler.jsonc (the AUD of the
  `lavabalance.fogofwar.dev/admin/login` application); either empty
  = nobody gets in through Access (fail-closed). A key set that cannot be read
  counts as "not an admin" (logged), so an Access outage never breaks a page.
  `adminRequest` wraps it for a whole request and refuses any non-GET from a
  foreign `Origin` first (the cookie is ambient; same rule as `sameOrigin`).
- **Pages** learn admin mode from the HTML: `page()` in `src/index.ts` rewrites
  the `/*ADMIN_MODE*/false` marker in `SHARED_JS` to `true` for an admin (that
  copy `private, no-store`; every page `Vary: Cookie`). Nothing is carried in
  links.
- **Admin-only routes**: `GET /api/sqlstats`, `POST /api/games/:id/rebase`,
  `POST /api/games/:id/ignored`, `POST /api/players/:userId/private`,
  `POST /api/rank-history/rebuild` (401 `{error, login: "/admin/login"}`
  otherwise). `?includePrivate=true` (LOS reads, `/api/lobbies/:id`'s avoids) is
  granted only to an admin; a visitor asking gets the public view, `no-store`.
- Still open (scripts use them): `POST /api/games` (upload) and
  `POST /api/reset?confirm=true`.
- Tests: `test/access.test.ts` (the verifier against a test keypair, ported from
  barreplay), `test/adminAccess.workers.test.ts` (the gate end to end);
  the other workers tests call admin routes through `test/adminFetch.ts`
  (`ADMIN_OPEN`).

## `POST /api/scores` (bulk Lavabar elo relay — no longer used by the UI)

The web UI's "📊 Fetch scores" button was removed with the LOS switch; the relay route and
the RatingsDO cache remain (the bot's chat commands still run on Lavabar elos, via
`lavaScores` directly). Historical context for the route:
Read-only: it fetches scores, nothing else (no balancing, no moves).

```bash
curl -XPOST http://lavabar.skyride.org/api/balance -d '["huk123","No_Air","GODOFWAR09"]'
# → {"ratings":[{"name","user_id","elo","games_played","wins","losses"},…],
#    "unknown_players":[…],
#    "team0":"a|b|c", "team1":"d|e|f", …}   ← the suggested split is IGNORED
```

Despite the endpoint's name we use **only** `ratings` + `unknown_players`; the team split
and win probabilities it also returns are deliberately unused.

- **It goes through the Worker** (`POST /api/scores` → `src/rating/lavaScores.ts`): the
  endpoint sends **no `Access-Control-Allow-Origin`**, so a browser cannot read a direct
  cross-origin response (and the published URL is plain http, which a https page won't even
  request). It is also where the **limits** live, since the route is public: names are
  trimmed, **de-duplicated** case-insensitively and **capped at `MAX_SCORE_NAMES` = 16
  distinct players** (a full 8v8 lobby — the UI sends players only, no spectators); over the
  cap is a 400, so no client can use the relay to fan out at Lavabar. The relay posts the
  bare array Lavabar expects and maps `ratings` into the same
  **`PlayerRating`** shape the rest of the app uses, keyed by `normalizeName`, so the UI
  merges these exactly like a cached rating: `{scores: {<lowercased name>: {playerId, rating,
  wins, losses, games, winRate, hidden?}}, unknown: [...], cached: bool}`. Elo is **rounded**.
- **The two sources have DIFFERENT coverage, and the cache must respect that.** Lavabar's
  search page leaves some players unrated — GODOFWAR09's rating column there is simply blank —
  while the bulk endpoint rates them fine. Those are exactly the players worth hiding, so their
  score exists **only** in the bulk answer. Both sources write one table, so `writeChanged`
  refuses to let a "not found" overwrite a rating already stored: without that, a background
  scrape refresh wiped the bulk score, `?show_hidden_score=true` had nothing to reveal, and the
  player silently dropped out of their team average. A stale rating for a player who really
  vanished is the cheaper mistake, and the next bulk fetch corrects it.
- **It shares the persistent RatingsDO cache with the scrape path.** The route calls
  `ratings.cached(names)` first — a read-only lookup that, unlike `get()`, schedules **no**
  background per-name scrape (this route refreshes the whole roster itself in one request). If
  nothing is missing or stale it answers straight from SQLite (`cached: true`, no Lavabar call);
  otherwise one bulk request refreshes everyone and `putScores` writes it through, so the same
  rows also serve `/api/lobbies/:id`. A failed refresh with usable rows still answers from the
  cache (`stale: true`) rather than erroring. Note the two sources genuinely disagree, by design: **the
  search page shows a rolling average over the player's last 10 games, while the balance
  endpoint returns the rating after their most recent game** (what lavabar's matchmaking
  actually uses). The gap can exceed 150 elo and points either way — a falling player's
  average sits above their current rating (Fizzz: page 650 vs bulk 598.8) and a climbing
  one's below it (No_Air: page 3289 vs bulk 3441.9). Whichever wrote our cache last wins;
  both are "correct" per their own definition, and the bot's .status uses the
  bulk (matchmaking) value.
- **Two things from the payload are deliberately dropped** (both were bugs first):
  - **`user_id` is the BAR account id, not a Lavabar player id.** huk123 comes back as
    `357541`, but their Lavabar page is `/players/542/` and `/players/357541/` is a **404**.
    So `playerId` is always `0`, which the UI reads as "no id" and falls back to the
    `?q=<name>` search link that does resolve.
  - **A name in `unknown_players` still gets a `ratings` row**, carrying a placeholder elo
    (1875 at the time of writing). Those names are skipped, so an invented rating never
    reaches the roster; they're still reported in `unknown` for the header count, and the UI
    treats the player as unrated (counted as 1250 — see below).
- **The UI side** (`LOBBY_HTML`'s script: `requestScores`, `applyScores`, `render`) sends
  the lobby's **players only** (spectators are filtered out — they aren't in the roster
  tables and don't count towards the averages), and merges the answer into the roster
  already on screen. Only players the normal lookup **missed** are filled in (an existing
  rating is left alone); a filled-in player is flagged `ratingFetched`, which draws its pill
  with a **dashed ring** (`.pill.fetched`) and its own tooltip. Team averages recompute for
  free (the assumed-value `(?)` hint disappears once nothing is missing). Fetched scores
  live in a page-lifetime `Map` and are **re-applied after every poll**, so a 3s
  auto-refresh doesn't drop them. Outcome/error shows in the header next to "updated …"
  (`#scoreMeta`, red on failure).
- Verified in headless Chromium against a stub roster + relay: the POST body, the filled-in
  pills, the recomputed averages, survival across a poll, and the 502 error path.

### Hidden ratings — the two-column model

Two upstream sources write **disjoint columns** of the RatingsDO's `ratings` table:

- the public **search-page scrape** (`rating/lavaRatings.ts`) owns `rating` + the stats
  columns — the player's PUBLIC rating, the only value the UI may display;
- the **balance endpoint** (`rating/lavaScores.ts` → `putScores`) owns **`rating_hidden`** —
  the elo Lavabar's balancer uses, which covers players the public site doesn't rate.

A player with `rating_hidden` but no `rating` is **hidden by data**: their elo feeds
`teamStats` / win chance / elo swing, but nothing is displayable unless the caller passes
`?show_hidden_score=true` (then the hidden elo is surfaced AS the rating, still flagged
`ratingHidden: true` so the UI marks it). There is **no operator list and no config** —
earlier designs kept a runtime hidden list that every state wipe silently emptied; the
two-column model cannot lose anything, it is simply what each source said. Rules that keep
the columns honest (all in `ratingsDO.ts`, pinned by tests):

- the scrape's diff-only DELETE + re-INSERT always **carries `rating_hidden` through**; a
  scrape "not found" records `found=0` (public rating: none) without touching the elo;
- `putScores` updates **only** `rating_hidden`; a name the scrape never saw gets a bare row
  with `updated_at = 0`, which reads as maximally stale so the next `get()` schedules the
  scrape to fill the public side in (cold caches converge within a poll or two);
- `ensureSchema` adds `rating_hidden` to pre-existing tables (a legacy `hidden` column from
  the operator-list era may remain; it is ignored). Rows bulk-written by the OLD code sit in
  `rating` as if public until their next scrape refresh corrects them.

`src/lobbyView.ts` applies the model once in the routes: `teamStats` from the effective
rating (`rating ?? hiddenRating ?? 1250`), `finalizeLobby` strips the hidden value and sets
the boolean `ratingHidden`, `shapeScores` does the same for `/api/scores`.

## How Lavabar's `/api/balance` picks the teams (reverse-engineered — historical)

NOTE: nothing runs on this anymore — the bot's balancer switched to the LOS
predictWin objective — but the findings cost real probing effort, so they stay.

Probed empirically (the service isn't open source). **Never send it more than 16 names**,
and stop probing if it slows down. Findings, all reproduced against the live endpoint:

- **Objective = minimise `|team0_avg − team1_avg|`** — the *average*, NOT the rating sum,
  and that same quantity is the `deviation` field (rounded to 1 dp). Proven on a 5-player
  set: the returned 3v2 was the min-avg-diff split (137.3), while the min-*sum*-diff 3v2
  split (sum diff 425 but avg diff 1004) was rejected.
- **Team sizes are fixed at `⌈n/2⌉ / ⌊n/2⌋`** and never traded for balance. With
  `KingBlakey, Ritual, ArmyzLoft, Morgekay` it returned a 2v2 at deviation 387.0 even
  though the 1v3 `(Ritual)` vs the rest scores 208.4. 3 players → 2v1, 5 → 3v2.
- **It returns the GLOBAL optimum, not a greedy/snake draft.** For a real 16-player lobby
  its answer tied the exhaustive best of all 6435 balanced splits (avg diff 0.16); zero
  splits were better. A snake draft over the same ratings gives a different, worse split.
  At n=16 the search space is trivial (C(16,8)/2 = 6435), so plain brute force suffices —
  no need to assume anything cleverer.
- **Deterministic / order-independent**: reversing the input list returned the identical
  split, so there is no randomisation or input-order tie-breaking to reproduce.
- Unrated players are counted as **1875** (see the `unknown_players` note above), which is
  what makes its numbers differ from our UI's 1250 assumption.
- `team0`/`team1` come back as `|`-separated name strings; team0 is not ordered by strength
  (the top-rated player can land on either side).

To reimplement locally: assume elo 1875 for unknowns, enumerate the `C(n, ⌈n/2⌉)` balanced
splits (halve by pinning one player), and pick the min `|avg₀ − avg₁|`.

## Balance mode (the lobby's `balanceMode`)

SPADS balances by its own `balanceMode`, which the host broadcasts unsolicited in
BarManager `BattleStateChanged` (tracked by `Battle`, see the protocol notes). The
values a BAR lobby uses: **`clan;skill`** (BAR's default — keep parties/"clans"
together, then balance on skill), **`clan`**, **`skill`** (skill only, parties are
NOT kept together) and **`random`**.

Our balancer is LOS-native and **always** balances on skill (the OpenSkill
`predictWin` objective in `balance/balancer.ts`). The mode changes exactly ONE
thing for it: **whether parties constrain the split**. `src/balance/balanceMode.ts`
is the single home of that rule (`honoursParties` / `balanceModeInfo`, unit-tested
in `test/balanceMode.test.ts`):

- a mode naming `clan` (`clan;skill`, `clan`, `skill;clan`) → party members land on
  the same team, exactly as the balancer has always done;
- anything else (`skill`, `random`) → every player is balanced individually, as if
  the lobby had no parties at all — `runBalance` simply drops the `partyId`s, and
  the background Teiserver party scrape (`refreshParties`) is skipped, since
  nothing would read it;
- **not broadcast yet** (null) → parties are kept: that is the pre-existing
  behaviour and BAR's own default. A mode flipping back to `clan;skill` makes the
  next `.balance` the party-blind "first run in this lobby", same as a fresh join.

**`random` is deliberately handled as `skill`.** The bot exists to make the match
fair and will not roll dice for the teams; a lobby that really wants a random split
turns the bot's balancing off through its own `autoBalance`, which is already what
arms and disarms us.

**Party splitting** (`balanceTeamsWithPartySplit` in `balance/balancer.ts`): even
under `clan;skill` a party of stacked strong players can make every
party-constrained split lopsided. When the best split keeping the parties together
still leaves either side's win chance above **`PARTY_SPLIT_MAX_WIN` = 0.75**, that
assignment is thrown away and the lobby re-balanced as `skill` would (every player
individual; the result is flagged `partiesIgnored`, its players carry `partyId`
null). `runBalance` then appends ` (too imbalanced -> ignoring parties)` to the
announced matchup line. The party-free search space contains every constrained
split, so the re-run never does worse. Tested in `test/balancer.test.ts`.
The rule is toggleable: **`.splitparties on|off`** (admins by whisper,
admins/bosses in battle chat — the `.lavatoggle` gate; bare `.splitparties`
reports the state) flips the bot-level `splitParties` flag in bot.ts (default
on, in-memory, shown on `.info`'s `balance:` line); off = `runBalance` calls
plain `balanceTeams`, parties always kept however imbalanced.

Where it shows: `.info`'s `host settings:` line (with what it means — "parties kept
together" / "parties ignored") and its `balance:` line, `GET /health` →
`/bot/status` → the Bot page (`lobbyBalanceMode` + `botKeepsParties`), and the
lobby page's 🤝 Balance mode line (proxy source only — neither Teiserver's pages
nor the public bar-rts API carry the setting, so those sources report `null`).

## Avoid lists

"Don't put me on the same team as X." Players configure their OWN list by
whispering the bot; the balancer treats it as a **soft** constraint.

- **Commands** (whisper only — a list is between the player and the bot, and the
  battle-chat forms only point back at the whisper): **`.avoid`** bare lists the
  entries plus the syntax, **`.avoid <player>`** adds someone, and
  **`.avoidremove <player>`** drops them. Every command that CHANGES the list —
  an add, a removal, and a refusal of either — ends by showing the list, so the
  asker sees the state they are left with without asking again. Anyone may edit
  their own list (the whispering account is the proof of who that is); there is
  no admin gate.
- **Validation**: the TARGET must be someone the ranking has rated, or the entry
  would silently constrain nothing — an unknown name is refused with near misses
  from the store. The asker is not checked: a debutant has every right to a list.
  Max **10** per player; naming yourself or a duplicate is refused.
- **Storage**: the LosDO's `avoids` table (the SQLite DO that survives), keyed on
  the lowercased names. **`/api/reset` deliberately leaves it alone** — that
  reset rebuilds the rating fold from the uploads, and a list is the one thing in
  the store no upload can put back. `POST /api/avoids/reset?confirm=true` is the
  separate, explicit wipe.
- **Balancing** (`src/balance/balancer.ts`): the pairs enter the SAME exhaustive
  search as the parties, as a soft constraint — lexicographic (size gap, avoid
  violations, |win − ½|) — and the winner is taken only from candidates whose win
  chance stays inside **`AVOID_WIN_MIN`..`AVOID_WIN_MAX` (40-60%)** and only when
  it beats what pure balance would have picked anyway. Otherwise the lobby is
  balanced as if nobody had asked and `avoid.skippedForBalance` says so: a fair
  game comes first. A pair inside one party is counted as a violation of every
  split rather than breaking the party. `BalanceResult.avoid` reports
  `requested` / `honoured` / `violated` / `applied` / `skippedForBalance`.
- **Rookie tie-break** (same search, applied last): among splits within
  **`ROOKIE_SPLIT_TOLERANCE` (2 pp)** of the chosen split's win chance, with the same
  sizes, no more avoid pairs together and (when the avoids decided) still in the
  avoid band, the one spreading the unpartied players under **`ROOKIE_SPLIT_GAMES`
  (10)** rated games most evenly wins. `BalanceResult.rookies` = `{count, gap,
  tieBreak}`; the bot logs a note when it moved the pick. Why:
  `docs/los-rookie-handicap-2026-09-27.md`.
- **Privacy**: who avoids whom is NEVER said in chat — not in the battle-chat
  matchup line, not in a whispered preview. The bot logs the outcome to stdout,
  and the lobby page shows the roster's entries **only in admin mode**
  (admin mode → `includePrivate=true`, the "🚫 Avoids" line under the teams,
  with the pairs both of whose people are present marked).

## The matchup strip (LOS)

Above **both** team tables on `/lobby/:id`, one strip carries each side's **average LOS**
and its **chance to win** (both from the server's `teamStats`), with the LOS gap (`Δ`,
one decimal) between them and a two-colour bar showing the win split (left segment = the
left team, in the in-game team colours: Team 1 `#0b3ef3` blue, Team 2 `#ff1005` red).
(The old `(?)` next to an average that assumed a rating is gone — unrated players now
carry their own assumed-debutant pill hint in the roster.) The two
sides meet in the **middle** — the strip uses the same 16px side padding as `.teams`, so
its divider lands in the gap between the two team columns, and the right side's rows are
`row-reverse` so both averages and both percentages flank the divider.

Rendered only for a **two-team** lobby, since both numbers are head-to-head; the per-team
`Avg` badge then moves out of the team headers into the strip (`teamTable(label, players,
showAvg)`). FFA / unsplit lobbies get **no** strip and keep the badge in each team header
instead. The win probability is server-computed (OpenSkill `predictWin` in
`src/lobbyView.ts` — see the LOS section above); the client only prints it, and the strip
omits the win line/bar if a response carries no `winProb`. The old fitted per-match elo
swing was Lavabar-specific and is gone from the UI (`tools/fit-lava-k.ts` remains for
bot-side Lavabar work).

### How the fit works (`tools/fit-lava-k.ts`)

Offline analysis, Node-only via `tsx`, nothing in the Worker imports it:
`pnpm exec tsx tools/fit-lava-k.ts [--matches N] [--no-cache] [--cache-dir D]`. It pages the match
index (`?page=N&per_page=100`), scrapes each `/matches/<id>/`, and fits on two hard-won facts:

- **Δ is uniform within a team**, so one match = one observation (matches where it isn't are
  dropped).
- **The team "Avg" badge is the PRE-match average.** Verified in-tool: on fully-rated matches
  `mean(after − Δ)` reproduces the badge to <1 elo. This matters — the badge is the input,
  because it already contains whatever rating Lavabar used for players whose row shows `-`,
  and a first attempt that used the rated-only mean fitted badly (residual correlated with the
  unrated count at 0.59). Solving `badge·n = Σ(rated pre) + k·x` shows those `-` players are
  **not** a single default (p10 2094 / median 2928 / p90 3708), i.e. `-` means "no Δ shown",
  not "no rating".

It prints the (s, p, K) grid winner, the worst residuals, the held-out check, and the exact
constants to paste into `ui.ts`.

## Scouting (OneTrickLava play-style cards)

**onetricklava** (`mabn/onetricklava`, OTL) parses every lava demo and folds each
player's career into a behaviour profile; this site has the ratings and the live
lobby but never reads a demo. The two meet here: OTL **pushes** one compact card
per player and the site turns them into things players see before a game.

- **The card** (`ScoutCard`, `src/scout.ts`): `userId` (the BAR account id LOS keys
  on), `name`, `games`, `winRate`, `faction`, `archetypes[]`, `badges[]`
  (`{id, icon, label, caption}` — OTL's 💥 Comm bomber / 🪂 Comm drop / 🚶 Comm
  walker), `lanes[]` (`{name, games, share, winRate}`, the community's lane NAMES —
  mirror spots merged, OTL's internal `P#` ids are refused), `traits`, `commander`,
  `danger` (OTL's watch-list score), `lastSeen`. `parseScoutUpload` is the strict
  gate: every string length-capped, every number clamped, unknown keys dropped, a
  card without id/name skipped (counted), ≤ 1000 cards / 5000 removals per push.
- **The push**: `POST /api/scout/profiles` `{profiles, remove?, generatedAt?}` →
  `{stored, unchanged, removed, total, skipped}`. Auth: a **Cloudflare Access
  service token**, the same scheme as the bot's `/api/bot/*` — a THIRD Access
  application protects the one path `lavabalance.fogofwar.dev/api/scout/profiles`
  with a Service Auth policy naming OTL's service token; OTL sends
  `CF-Access-Client-Id`/`-Secret`, Access swaps them for `Cf-Access-Jwt-Assertion`,
  and `scoutIdentity` (`src/access.ts`, the shared `serviceIdentity` check also behind
  `botIdentity`) verifies that JWT against **`ACCESS_SCOUT_AUD`** — so no secret lives
  in the Worker, the workers.dev hostname (where no Access rule runs) gets nothing,
  and the three applications' tokens are not interchangeable (pinned in
  `test/access.test.ts`). Any admin credential may push too (manual backfills).
  Without `ACCESS_SCOUT_AUD` only an admin can: a visitor gets **503** naming the
  missing setting, a configured route a **401** — **fails closed**, because a forged
  card puts words ("Comm bomber") in a player's mouth on every lobby page. OTL sends
  only cards that CHANGED since its last push plus
  explicit removals, keeping its own record of what it published (the barreplay
  lesson: this API is not a record of what was offered); the DO additionally writes
  diff-only, so OTL's `--full` resend costs reads, not writes.
- **Storage**: LosDO `scout_profiles` (`user_id` PK, `name_key`, `games`, `data`
  JSON) + `scout_meta` (the precomputed boards, the card count, the last push's
  times — its own table because `/api/reset` drops `meta`). `/api/reset` leaves both
  alone, like avoids; `POST /api/scout/reset?confirm=true` (admin) is the explicit
  wipe. The boards are rebuilt inside the push transaction from the regulars only
  (`games >= BOARD_MIN_GAMES` = 50, via `idx_scout_games`), and the count is
  maintained there, so no read scans the table.
- **Privacy**: a player whose LOS profile is private gets **no card** for a
  visitor — `/api/scout/:id` answers `{private: true}`, bulk reads and the boards
  drop them, the lobby roster shows no badges for them; `?includePrivate=true` from
  an admin shows everything (`no-store`). Same read-filter semantics as the rating.
- **Reads**: `GET /api/scout?names=a,b&ids=1,2` (bulk, ≤ 64, what the bot asks),
  `GET /api/scout/:userId` (one card; 404 = none), `GET /api/scout/boards` (watch
  list + lane kings + `profiles`/`generatedAt`/`receivedAt`). Edge-cached 120s.
- **The lobby view** (`/api/lobbies/:id`): after `finalizeLobby`, one
  `scoutCards(losUserIds, names)` RPC (id first, lowercased name for the unrated);
  `scoutLobby` attaches each player's `scout` summary (badges, top archetypes, main
  lane) and the lobby's `scouting` block: per ally team `{scouted, players,
  threats[], styles[], aggression, ecoFocus}`, and — **on Supreme Isthmus only**
  (`lanesApply`) — the **lane forecast**: each team's players assigned to lanes by
  an EXACT maximum-weight assignment (DP over players × used-lane bitmask; weight =
  lane share, discounted below 5 / 2 games), so a contested lane goes to the
  stronger habit and the other player to their next lane; lanes nobody is forecast
  on are dropped, scouted players left without a lane are `flex`. A lookup failure
  degrades to `scouting: null`. The page draws it under the rosters as the
  **🔭 Scouting report**: a mirrored lane table (Team 1 ← lane → Team 2, share and
  lane win rate per pick, ⚔ where both expected players main it (≥ 30% share), ▲
  on the better record), then each team's "Watch for" / Style / Lean. Roster rows
  carry the badge icons after the name (captions in the tooltip; a quiet 🔭 for a
  scouted player without badges).
- **Pages**: `/scouting` (sidebar 🔭 Scouting) — ⚠️ Watch list (danger score,
  badges, style, main lane) and 👑 Lane kings (best win rate per lane, 20+ games
  there); the player page grows a **🔭 Play style** card (archetypes, warnings,
  lane bars with win rates, trait bars scaled so OTL's own "high" threshold sits
  at 60%, commander habits) — also shown for a player LOS has not rated yet.
- **Bot**: `.scout <player>` (whisper or battle chat; `scoutLine` + a player-page
  link) via `src/bot/scoutClient.ts` over the public bulk route.
- Tests: `test/scout.test.ts` (validator, assignment, summaries, boards, the line),
  `test/scout.workers.test.ts` (push auth/diff/removal, boards, private filtering,
  the lobby view over the captured Supreme Isthmus session),
  `test/scoutClient.test.ts`. The producer side is `app/lavabalance_sync.py` in
  onetricklava (`python -m scripts.publish_scout`).

## Config & secrets

`wrangler.jsonc `vars``: `BOT_USERNAME`, `BOT_LOBBY_NAME` (both default `lavabalance`),
`RATING_CACHE_REFRESH_MS` (RatingsDO background-refresh threshold; default 15min), and
`SRC_MODES` (comma-separated list of enabled `/api/lobbies` `src` modes — see below).
Also `BOT_ADMINS` / `BOT_AUTOJOIN_ROOM` (the container-hosted bot's admin list /
auto-join battle; empty by default) and the optional `BOT_LAVAOS_URL`.
Secrets (`wrangler secret put`): `BOT_PASSWORD` (the bot account's PLAINTEXT
password, handed to the container — the bot md5-hashes it itself), `BOT_PASSWORD_HASH`
= `base64(md5(password))` (`printf '%s' PW | openssl dgst -md5 -binary | base64`, kept
for `connect-test`), `CONTROL_TOKEN` (optional), and
for the `src=teiserver` web login `TEISERVER_PASSWORD` (the account's **plaintext**
password — the web form uses it, distinct from the lobby account's md5 hash),
`ACCESS_SCOUT_AUD` (a `vars` entry next to `ACCESS_BOT_AUD`: the AUD of the Access
application fronting onetricklava's scouting push, not secret; empty = admin-only
pushes; see "Scouting"); the
matching **email** is the `TEISERVER_EMAIL` secret — the same account the Node bot's
web login uses (`BotContainer` passes it as `BOT_TEISERVER_EMAIL`). Server host/port are hard-coded, not vars.

## Logging

Every protocol line is `console.log`'d (`→` send / `←` recv) and kept in an
in-memory ring buffer (last 1000) per DO — **not persisted**. The `LOGIN` password
is redacted. Lifecycle events use `logEvent`. Workers observability is enabled in
`wrangler.jsonc`: `observability.logs` and `observability.traces`
(end-to-end request tracing).

Setting the `DEBUG=true` var makes `TeiserverDO.webFetch` log every web
request/response to Teiserver (`→`/`← teiserver …`, response status + body) for the
`src=teiserver` scraper — **including the `/login` flow**. Two safeguards make the login
safe to log: the account password (`TEISERVER_PASSWORD`, raw and form-url-encoded) is
replaced with `REDACTED_TEISERVER_PASSWORD` wherever it appears (`redactPassword`), and
request/response bodies are capped at the first 200 chars with newlines escaped so each
logs on a single line (`formatBodyForLog`). Off (unset) in production.

**`/api/lobbies` upstream failures are always observable (no DEBUG needed).** Every
upstream fetch (`TeiserverDO.webFetch`, `rtsapi.fetchBattles`, `lavaRatings.fetchOnce`)
turns a failure into an error that **names the failing request** — `<svc> <METHOD> <path>`
plus the reason, and **distinguishes a timeout from a network/HTTP error** (`timed out
after Nms` vs `failed after Nms: …` / `returned <status>`). The raw `AbortError` is just
"The operation was aborted" with no method/path, so without this you couldn't tell whether
login, the lobby index, or a specific `/battle/lobbies/show/<id>` died. These are
`console.error`'d at the source (method/path only — never a body, safe for `/login`) and
the message becomes the 502 body. A swallowed `showLobby` failure (a lobby dropping out of
the list) is `console.warn`'d too.

**Outgoing-request tracing (always on, no DEBUG):** the two public upstreams log every
request/response in the same `→`/`←` shape as the teiserver scraper — `rtsapi.fetchBattles`
(`→/← bar-rts GET <url> <status> (<ms>)`, the `src=rtsapi` path) and `lavaRatings.fetchOnce`
(`→/← lavabar GET <url> <status> (<ms>)`, every Lavabar rating lookup). Both URLs carry only
public data (no secrets), so they're logged in full unconditionally — unlike the teiserver
scraper, whose `→`/`←` lines are DEBUG-gated because its bodies include the login.

`TeiserverDO.lobbies()` **returns a discriminated `LobbiesResult` (`{ok:true,lobbies}` /
`{ok:false,error}`) instead of throwing.** A rejection thrown across the DO RPC boundary
surfaces as a misleading bare `Uncaught (in promise)` in the logs even though the Worker
catches it for the 502; returning the error as a value keeps the logs clean. The Worker
(`index.ts`) maps `{ok:false}` to a 502 carrying `error`.

## File map (`src/`)

| File | Purpose |
|---|---|
| `index.ts` | Hono Worker: control plane → the DOs over RPC (`{fetch, scheduled}` export; the cron keeps the bot container up); serves the UI (`/`), `/api/lobbies`, `/sql` + `/api/sqlstats` (both DOs' `sqlStatsReport()`), and mounts the LOS API (`losApp`). Exports `Dispatcher`, `LosDO`, `RatingsDO`, `TeiserverDO`. |
| `botContainer.ts` | `BotContainer` — `extends Container<Env>` from `@cloudflare/containers` (a DO): the supervisor of the ONE bot container instance (`getContainer(env.BOT_CONTAINER, "bot")`, `botContainerStub`). Sets `envVars` from the Worker's vars/secrets (`BOT_LOGIN`=`BOT_USERNAME`, `BOT_PASSWORD`, `BOT_ADMINS`, `BOT_AUTOJOIN_ROOM`, `BOT_TEISERVER_EMAIL`=`TEISERVER_EMAIL`, `BOT_LAVAOS_URL`), `enableInternet=true`, `defaultPort` = the bot's health port 8080. RPCs: `startBot()`/`stopBot()` (persist `desired.running`, then `startAndWaitForPorts()`/`stop()`), `restartBot()` (persist running, `stop()` + wait ≤20s for the instance to really exit — `stop()` only signals — then `ensureRunning()`; backs `POST /bot/restart`, the post-deploy kick), `ensureRunning()` (start iff desired and not up — the cron's call; NEVER throws, a start failure lands in `lastError`). **Auto-rejoin**: the DO persists `lastBattle` (the battle the bot was last seen in — recorded by every `botStatus()` that sees `bot.battle`, and by an accepted `joinLobby`); before each container start, `ensureRunning` resolves the rejoin target via `resolveAutoJoinBattle` (src/autoLobby.ts: the last battle while Teiserver's index lists it — an index failure keeps it —, else the main `lava_lobbies[0]`, auto-picked when empty) and overrides `this.envVars.BOT_AUTOJOIN_ROOM` with it (the package reads envVars at start time), so the bot rejoins after every login. `lastBattle` is exposed in `botStatus()`, `botStatus()` (platform state + persisted `lastStop`/`lastError` + the bot's own `GET /health` JSON via `containerFetch`, null when down). **Fatal exits**: the bot exits with `FATAL_EXIT_CODE` = **42** (same constant in both files, not imported — bot.ts is outside the Worker tsconfig) only for unfixable-by-restart conditions (login DENIED, missing/invalid config); `onStop` with `reason:"exit"` + exactly that code switches `desired.running` OFF and records `lastError`, so the cron doesn't hammer Teiserver with a bad login every 5 min — fix the secret, `POST /bot/start` again. Every OTHER stop (clean exit, `runtime_signal`, any other non-zero exit — crash/OOM/rollout SIGKILL) leaves the intent on and the cron's next `ensureRunning()` (≤5 min) restarts the bot — this is also what brings it back after a deploy. (An `onStop`-scheduled self-restart via the package's `schedule()`/alarm was tried and removed: it did not bring the bot back after deploys. A deploy-side kick races the rollout: POST /bot/start no-ops against the pre-rollout instance, and an immediate /bot/restart can start the OLD image, killed again by the rollout. Matching any non-zero exit here used to misread deploy rollouts as fatal and leave the bot down.) `POST /bot/start` answers 503 (same body) when the container didn't come up. Overrides `onActivityExpired()` to `renewActivityTimeout()` so the idle timer never stops it; `onStart`/`onStop`/`onError` log (last stop kept in memory for status). Never override `alarm()` here — the package drives its lifecycle with it (use `schedule()`). |
| `../Dockerfile` | The bot image: `node:26-slim` (wrangler builds for linux/amd64 — no `--platform`, the Docker linter rejects it), apt `procps less vim curl` + `container/vimrc` (→ `/root/.vimrc`, colours on) + `container/bashrc` (→ `/root/.bashrc`; prompt, colours, `botlog`/`cmdlog`/`bothealth` aliases) for `wrangler containers ssh` sessions — the platform's SSH server execs `/bin/sh` (`echo $0` → `/bin/sh`), so `/bin/sh` is REPLACED by `container/sh`: an interactive no-arg session execs `bash --rcfile /root/.bashrc -i`, anything else (`sh -c …`) goes to bash unchanged, `pnpm install --prod --frozen-lockfile` + global `tsx`, `COPY src`, `ENV BOT_HEALTH_PORT=8080` + `EXPOSE 8080` (Cloudflare refuses an image with no exposed port), `CMD tsx src/bot/bot.ts`. **In the instance**: the bot is PID 1 (`tsx src/bot/bot.ts`, cwd `/app`); the raw protocol log is `/app/commands_<date>.log`, the console output (status/chat/errors, also on stdout → dashboard Logs) is `/app/bot_<date>.log`; `curl -s localhost:8080/health`. Built and pushed by `wrangler deploy` (needs Docker). `.dockerignore` keeps node_modules/tests/docs/logs out. |
| `sqlStats.ts` | **SQL row-cost accounting** for the SQLite DOs, ported from barreplay: `SqlAccounting` wraps `ctx.storage.sql.exec` (consumes each cursor eagerly — the counters are only final then — and hands back an iterable/`toArray()` stand-in) so every statement bills its `rowsRead`/`rowsWritten` to the method currently stamped; `trackSqlOnPrototype(cls, skip)` wraps every method of the DO class **on the prototype** (an instance-property shadow made the deployed RPC runtime refuse the methods — barreplay learnt that the hard way) so calling one stamps its name. Outermost wins (a helper bills its caller); the stamp covers the synchronous part of a call, which is exact here — the DOs' SQL runs before any await (RatingsDO's post-await background scrape lands on `writeChanged`). A single call over 5000 rows read / 2000 written logs a `sql cost:` warning. In memory only; `report()` is what `/api/sqlstats` serves via each DO's `sqlStatsReport()`. Both DOs create it FIRST in their constructor so `ensureSchema` is counted. |
| `ui.ts` | The eight vanilla-JS pages (no framework/build step), sharing one `STYLES`/`SHARED_JS` block and the **left sidebar menu** (`sidebar(active)`: 🛋️ Lobby (→ `/`, which redirects to the first open lobby; other lobbies open by id at `/lobby/:id`) / 🏆 Ranking / 🎮 Games; active-item highlight, Lobby link rewritten client-side to carry `?src=`/`?all=`; collapses to a top bar under 700px): `LOBBIES_HTML` — the lobby list, served ONLY by `/` when there's nothing to redirect to (rows link to `/lobby/:id`); `LOBBY_HTML` — the detail page at `/lobby/:id` (the dense per-team roster for the lobby in the URL; player names link to `/player/:userId` via `losUserId`; `footLists` under the tables carries bosses, spectators, the lobby's SPADS **balanceMode** with the party rule it implies — proxy source only — and Teiserver's own balance algorithm); `RANKING_HTML` — the paged LOS leaderboard at `/ranking`. ONE table (`tableColumns` describes it as a list of COLUMNS rather than header markup; `headerCell` renders one): `# · Δ (7d) · Player · LOS · Δ (7d) · Games · W–L · Win% · Last game`. Each MOVEMENT sits directly against the column it is a movement of, which is what lets both wear the same label — one is a whole number of places, the other a rating to one decimal, and each is read next to the thing it moved; they differ in `title`, which is what tells them apart where the rendering cannot. A movement is a COLUMN rather than a mark inside the `#` cell for two reasons: that cell is right-aligned, so anything trailing the number decided where the NUMBER landed and the ranks stopped lining up; and only a column carries a header to sort by. `changeMark` draws all three outcomes and keeps them distinct: a rise (green ▲) or a fall (red ▼) with its size; **unchanged**; and **nothing to compare with** — the last two both a dash, with the tooltip saying which, and a change too small to print at the column's precision folded into "unchanged" rather than rendered as a rise nobody made. `#`, both `Δ (7d)`s and `LOS` are SORTABLE headers: a first click sorts by that column in its own default direction (the one putting what it is interesting for on top — best position, best rating, biggest gain), a second reverses it; the order is the SERVER's, so a click is a refetch and returns to page 1 ("page 3" of a differently ordered list is a different set of players). Each is focusable with Enter/Space and carries `aria-sort`, and the arrow marks what the RESPONSE says it ordered by, not what was asked. `?sort=`/`?dir=` live in the URL, omitted for the leaderboard's own order, which is what a bare `/ranking` already means. The table is `table-layout: FIXED` (`.ranking .games-table table`) with a width per column: under the automatic layout every column was as wide as the widest thing in it, so the whole table re-laid itself on every sort and every page — rank 1 against rank 9575, "–" against "▲ 117" — and reading a list is following a column down. Every column but the PLAYER is a known quantity (a rank, a delta, a count, a date) and gets the room its widest real value needs; the name is the only genuinely variable one and takes the remainder, so a name too long for it is ellipsed (the whole of it stays on the link's `title`) rather than widening the table. Only the HEADER row's cells decide a width under fixed layout, which is what `headerCell`'s `col-<key>` class is for. It also made the table NARROWER than the automatic one (616px against 876px on the same worst-case data). RESPONSIVE by CONTAINER query on the card (`container: ranking / inline-size`) rather than by viewport, because the card's width depends on which shell layout is up — the sidebar is 180px until it becomes a top bar at 700px — so one viewport figure means two different cards; a browser without container queries simply keeps every column, which is the behaviour this replaced. As the card narrows the type and padding tighten (736px), then the RECORD columns leave one at a time, least useful first: Last game (656), Win% (564), W–L (514), Games (438), with a floor tier (380) that tightens what is left. The player's NAME never goes — it is what every other cell is about — but it is also the column taking the remainder, so it is the first thing a shortage takes from: swept from an 880px card down to 320px, in both the admin and the visitor shapes, the name column never falls below 70px and no cell spills. Two widths are NOT free to shrink and are set from what they measure rather than by eye: the LOS pill and the row-actions button carry min-widths of their own, so a narrower column does not narrow them, it lets them overflow the cell. `td.name` is a FLEX row so the ellipsis lands on the name rather than on whatever is last (it was cutting the "inactive" badge in half), and the link needs `min-width: 0` or, being a flex item, it refuses to shrink below its own min-content and pushes the table past the card. `.card.ranking`'s max-width is 860px because the table has to FIT: the card is `overflow:hidden` for its corners and the admin row menu must not be clipped, so the table cannot be given a scroller of its own. The toolbar's **Rebuild history** button (`POST /api/rank-history/rebuild`, then a full re-read since every row's change was rewritten) carries class `admin-only` — CSS-hidden outside admin mode, like the sidebar's admin entries — since it edits rows every visitor reads. `PLAYER_HTML` — one player's profile/chart/recent games at `/player/:userId` (canvas chart, no library; the games table's right-hand Links column is `replayCell`, the barreplay slot alone); `GAMES_HTML` — the paged games table at `/games` (numbered pager above the table, clickable rows, team-coloured `.tc0`/`.tc1` names + LOS, OTL/BAR/barreplay links via `linksCell`/`replaySlot`); `GAME_HTML` — one game at `/game/:id` (matchup strip + facts, whose Links carry the barreplay slot too, + both rosters with LOS-before and Δ); `SQL_HTML` — the admin-only SQL stats page at `/sql` (admin mode; one table per DO from `/api/sqlstats`, budget projections, Reload); `BOT_HTML` — the admin-only bot page at `/bot` (admin mode; a prominent lobby banner — which battle the bot is in, linked, title lazily fetched from the public `/api/lobbies/:id`, or "not in any lobby" —, status card from `GET /bot/status` polled every 5s, Start/Stop buttons POSTing `/bot/start|stop`, Join-main-lobby (labeled from `GET /admin/config`'s `lava_lobbies[0]`) + join-by-id controls POSTing `/bot/join`, and a control-token field kept in localStorage and sent as the bearer `Authorization` header on every control-plane call — the control plane checks the Access cookie or that token itself; admin mode only reveals the page). The sidebar's 🤖 Bot and 🗄️ SQL entries have class `admin` and are CSS-hidden unless `SHARED_JS` put `admin-mode` on `<body>` (`ADMIN_MODE`, which the Worker sets for a verified superadmin — see "Superadmin"). The game helpers (`playerHref`/`gameHref`/`otlHref`/`barHref`/`replayHref`, `fmtWhen`/`fmtDur`, `teamLosBefore` = mean of the roster's `losBefore`, `byLosDesc`) live in `SHARED_JS`. `SHARED_JS` guards the help/auto-refresh wiring so pages without those buttons (ranking/player) can share it. It also owns the two pieces of admin chrome BOTH tables use: the **row menu** (`rowMenuCell` renders the `⋯` cell with the data- attributes the page's actions read back; `rowMenuActions` is the per-page action list; one menu open at a time, click-away and Escape close it) and the **modal dialog** (`showDialog`/`confirmDialog`/`noticeDialog` over a `<dialog>` built on demand — what replaced `alert`/`confirm`, which block the page on chrome that cannot carry a sentence; a confirmation can carry ONE checkbox, which is how the LOS re-run asks about off-map games without a second prompt). `test/ui.test.ts` pins that neither survives as a call or as a comment. `LOBBIES_HTML` polls `/api/lobbies` (the list, no ratings); `LOBBY_HTML` polls `/api/lobbies/:id` (one lobby, with **LOS** ratings + `teamStats`). Both propagate `?src=`/`?all=`. `LOBBY_HTML` renders the LOS pill column (`ratingClass` LOS bands, `fmtLos` one decimal, `UNRATED_LOS = 3.7` for the assumed-average hint) and the centred **matchup strip** above both rosters (`teamAvg`/`matchupSide`/`matchupBar` printing the server's `winProb`) — see the LOS section above. It also shows: **party pills** left of each LOS pill (`partyIndex`/`partyPill` — parties numbered "party 1", "party 2", … in roster order, tinted with the party's own Teiserver colour, which IS the opaque `party` key; the key is validated as `#rrggbb` before touching the style attribute); a green **"⚔️ in progress · MM:SS" badge** in the lobby's title bar whose clock ticks locally every second (`progressBadge`/`fmtElapsed`/`tickProgress` — re-based on the server's `inProgressSec` at every fetch, so it moves without a refresh); and, below the team tables, `footLists`: comma-separated **Bosses** and **Spectators** name lists (names LOS knows link to `/player/:userId`) plus the **balance algorithm**. No skyride links, no fetch-scores button, no hidden pills. |
| `tracker.ts` | **`SessionTracker` — THE shared session state machine**, run verbatim by BOTH the Dispatcher DO and the Node bot so they can never desync. Owns the full observation pipeline per line: LOGIN-learned session account → user directory (SETSCRIPTTAGS skills, CLIENTSTATUS) → self-membership incl. implicit-leave (lava-set changes via pluggable hooks — the Dispatcher persists them, the bot self-manages in memory) → `Battles.observe` routing. Also the shared roster/user merge `players()`/`roster()` (`TrackedPlayer`: skill/rank/inGame/away + battle status, skill-desc order). Pure (no `cloudflare:*`/`node:*`). Any change to session/roster semantics goes HERE, never into one consumer. |
| `battle.ts` | `Battle` (per-battle state: players + lobby status + its own message log) and `Battles` (registry/router). `Battles.observe(env)` routes a message to the battle it concerns (every battle, not just configured `lava_lobbies` — joining a lobby is what marks it lava, so messages must be processed beforehand), records it on that battle (last 10 lines), and returns the battle id or `null` (unrouted). A `Player` holds only battle-specific state (battle-status: ally/team/ready/spectator); room-independent details live on `User`. Transport-agnostic (no socket). |
| `user.ts` | `User` (global, room-independent per-account details: `rank`, `skill`/OS, `inGame`, `away`) and `UserRepository` (directory of all users keyed by lowercased name). Updated by the Dispatcher from CLIENTSTATUS (`noteClientStatus`) and SETSCRIPTTAGS skill tags (`noteSkill`); read by `lobbies()` to augment each battle's roster by name. Transport-agnostic. |
| `dispatcher.ts` | `Dispatcher` Durable Object (singleton): persisted runtime config + a tracker view fed by the `ingest(messages)` RPC (no transport of its own anymore). **Delegates the whole per-line pipeline to the shared `SessionTracker` (`tracker.ts`)** — the same instance class the bot runs — adding only Worker concerns: lava-set persistence via the tracker hooks (`addLavaLobby`/`removeLavaLobby` → stored config) and the unrouted buffer. The tracker learns the observed session's account from its `c LOGIN <name>` line, which takes precedence over the static `BOT_USERNAME` var (which may name a different account than the one streaming). Routes each message via `Battles` (all battles tracked, not config-filtered) so it's logged on its battle; unrouted messages are recorded in the Dispatcher's own buffer and logged. Maintains the global `UserRepository` (skill/OS from SETSCRIPTTAGS; rank/in-game/away from CLIENTSTATUS). Persists the runtime config in DO storage and pushes `lava_lobbies` into the tracker. `log(battle)` returns the battle's log (numeric id) or the unrouted buffer; `lobbies()` backs the UI's list (only the configured lava lobbies via `Battles.lava()`, even though all battles are tracked) and `lobby(id)` backs the detail view (one lobby; LOS ratings are layered on by the route, not the DO). |
| `rtsapi.ts` | Worker-side alternate source for `GET /api/lobbies[/:id]?src=rtsapi`: `fetchBattles` (public `api.bar-rts.com/battles`), `mapBattlesToLobbies` (pure transform into the `lobbies()` shape, filtered to lava lobbies), `lobbiesFromRtsApi` (the list — fetch the battle list + map), `lobbyFromRtsApi` (the detail — fetch the list, find + map one battle; LOS ratings are layered on by the route). Documents the public-API gaps (no allyteam/sync/bosses). |
| `rating/lavaRatings.ts` | Pure Lavabar transport + parsing (no state): `fetchPlayerRating(name)` (one HTTP GET to `lavabar.skyride.org/players/?q=`, 5s timeout + single retry), `parsePlayerSearch` (HTML→`PlayerRating`, unit-tested), `normalizeName` (trim+lowercase cache key). No `cloudflare:workers` import, so it loads in the Node unit pool. |
| `lobbyView.ts` | The LOS view at the wire: `teamStats` (per-ally mean LOS, unrated = `UNRATED_LOS`, plus two-team `winProb` via OpenSkill `predictWin` with the rookie handicap), `finalizeLobby` (attaches per-player `los`/`losGames`/`losUserId`/`losHandicap` + the stats), applied once in the `/api/lobbies/:id` route; `shapeScores` (the Lavabar two-column shaping for `/api/scores`, unchanged). Pure. |
| `losRatings.ts` | LOS resolution for the detail route: `fetchLosRatings(env, names)` — one bulk `playersByNames` RPC to the singleton LosDO, keyed by lowercased name; empty map on failure (degrade, never 502). |
| `gameStart.ts` | The **game-start roster wire shape** shared by the bot's uplink, the LosDO's `lobby_states` storage and the `/api/lobbies/:id` substitution: `GameStartSnapshot`/`GameEndEvent` + strict validators (`parseGameStartSnapshot`/`parseGameEndEvent`), `snapshotFresh` (3h TTL, 2-min post-launch grace vs the live `inProgress`), `substituteRoster` (TrackedPlayer → lobby-player mapping; `party` merged from the live roster by lowercased name, everything else launch-time truth). Pure — unit-tested in `test/gameStart.test.ts`; the end-to-end path is `test/gamestart.workers.test.ts`. |
| `balance/balancer.ts` | **`balanceTeams`** — the local, party-aware **LOS balancer** (pure, no I/O). Objective: sizes first (⌈n/2⌉/⌊n/2⌋, Lavabar's hard rule kept), then the split whose **OpenSkill `predictWin` is closest to 50/50** over every player's μ/σ with the rookie handicap — the predictor the LOS fold is calibrated with. **Unrated players count as a debutant** (`UNRATED_STATE` μ25/σ8.33, shown as `UNRATED_LOS` ≈ 3.7 — same as the web UI). **Parties**: players sharing a `partyId` are one indivisible group; the search runs over subsets of groups (2^g halved by pinning group 0, a candidate's win prob is O(1) from summed μ/σ²). Lexicographic objective + `sizeCompromised` when parties break the even split; a lobby that is entirely one party returns everyone on teamA. Last, a **rookie tie-break** spreads players under 10 games evenly among splits within 2 pp of the best (`ROOKIE_SPLIT_*`, `BalanceResult.rookies`). Also exports `teamsWinProb` (current-teams matchup, used by the bot's `.status`) and `shownLos`. The old elo-avg-gap objective (Lavabar parity) is history — see "How Lavabar's /api/balance picks the teams". |
| `balance/balanceMode.ts` | The lobby's SPADS **`balanceMode`** → the one rule it changes for our balancer: `honoursParties(mode)` (true for every mode naming `clan`, and for an unseen mode — BAR's default is `clan;skill`; false for `skill`/`random`) plus `balanceModeInfo` (the label `.info`, `/health` and the lobby page show). Pure; the objective is ALWAYS LOS — see "Balance mode". |
| `los/losGames.ts` | **Pure LOS-service logic** (no `cloudflare:workers` — Node-pool testable): `classifyReplay` (rejected/skipped/GameInput extraction, ally-team-level team convention), `applyRatedGame` (the fold — MUST stay byte-identical to `tools/lavaos/los.ts`, verified over the full Aug 2026 data), `predictTeams`, `losOf`/`leaderboardOf`, `ALGO_VERSION`. |
| `los/losDO.ts` | `LosDO` Durable Object (singleton): the whole LOS store + single writer (games/game_players/players/meta/**counts** in SQLite; upload in one `transactionSync`; reset; ranking/games/gameDetail/player/playerHistory/searchPlayers/playersByNames read RPCs; `setPrivateProfile` — see "Private profiles" above). **`rank_history`** (day, user_id → rank, los; `WITHOUT ROWID`, PK ordered day-first because every read is one day's rows) is the past the two 7-day change columns are measured against: `refreshRanks` records ONE snapshot per UTC day (`recordDailySnapshot` — the first run after midnight stamps the state it just derived with the day that ENDED, since it ran just after a game; a day nobody uploaded on gets no row, hence the baseline takes the newest day AT OR BEFORE its target), prunes past `RANK_HISTORY_RETENTION_DAYS` (60) in the same once-a-day call, and then measures `players.rank_change_7d`/`los_change_7d` against `rankBaseline` — the newest snapshot at or before `today − RANK_HISTORY_DAYS` (7) and no older than `RANK_HISTORY_MAX_AGE_DAYS` (14), NULL past that (a "7-day change" measured over three days is a different number wearing the same label). Against the TRUE `rank`, the one defined for every row: `public_rank` is NULL for a private or lapsed player, so a delta over it would vanish exactly when someone lapsed. The list is SORTABLE by any of those columns either way (`parseRankingSort`/`rankingOrderBy`/`rankingComparator`, the last for the search path, which orders its materialized matches in JS) and every one of the eight orderings is an index scan — pinned by `losCost.workers.test.ts`, which asserts the plan names the index and contains no TEMP B-TREE. The two kinds of column reach that differently, and the difference is why this is a table rather than string concatenation: a NOT NULL column (`los`) needs ONE index, since `los DESC, user_id` read backwards is `los ASC, user_id DESC` — the ascending clause flips the TIEBREAK too, because an exact reversal is an index scan and anything else is a sort of the table; a NULLABLE change column cannot, because "no baseline" belongs at the END whichever way the column is read, which takes a leading `<col> IS NULL` key that reversing would itself reverse. So each change column carries an index per DIRECTION (`idx_players_{los,rank}_change_{asc,desc}`), both scanned forwards, and both lead with `ranked` like every other ranking index here, because that is the list every visitor loads — the public ranking's head. The ORDER BY must repeat the `IS NULL` expression exactly as the index declares it. The ADMIN view is the one documented exception: it is a flat list over everyone, so a change sort there has no leading `ranked` to seek on and SQLite sorts the table — a couple of thousand rows on a maintainer's click, not a scan on anything polled, and asserted in `losCost.workers.test.ts` so it stays deliberate. `rebuildRankHistory` (the admin button) redraws the last `RANK_HISTORY_REBUILD_DAYS` (8) days by REWINDING — `players` holds the present exactly and `game_players` holds every rated game's μ/σ *before* it, so a past board is the present with the games since undone, walked newest-first so each player lands on the state before their earliest game after the cut, and undoing somebody's *first* rated game removes them from the board. It never re-runs the fold, so it cannot disagree with it. **Derived data is written by the upload, never by a read**: `counts` (keys `players`, `players_ranked`, `games`, `games_rated`) is bumped inside the upload transaction (`bumpCount`) and read back with `count(key)` — the pages' totals; `players.rank` / `players.public_rank` / `players.inactive` / `players.ranked` (the true leaderboard position over everyone, the position among RANKED players — NULL on a private or lapsed one —, and the two flags that decide which is which) are all recomputed together by the single `refreshRanks()` walk after every upload that rated a game (one ordered walk of `idx_players_ranking`, then an UPDATE only for ranks that moved — reads scale with the table once per upload, writes with the shift). The constructor's order is **load-bearing**: `ensureSchema()` creates the tables, then `migrateColumns()` adds every column the tables have grown since (`rank`, `public_rank`, `private_profile`, `inactive`, `ranked` on players; `unranked_reason`, `lobby` on games; **`bar_rank` on game_players** — BAR's CHEVRON level at game time, 0..7, off the upload's `Player.rank`, and the only reading of a player's BAR-WIDE experience here, since under BAR's "Role" method it buckets in-game hours. A per-game SNAPSHOT: teiserver recomputes a chevron at login, so what it was that day is gone afterwards, which is why it is on the game row and not on `players`. The one migrated column `ensureDerived` does NOT rebuild — only the upload carries it, so rows stored before it keep NULL; and 0 is a real level, an account under five hours, never "unknown"), then `ensurePlayerIndexes()`, then `ensureDerived(added)` seeds `counts` and computes every rank. **The players indexes are NOT created with the table**: several name columns an older build's store does not have, and `CREATE INDEX` on a missing column is an error, not a no-op — creating them first threw `no such column: ranked` in the constructor, so the DO could not even serve the page that would have migrated it. `migrateColumns` returns the columns it ADDED, which is what tells `ensureDerived` their contents are still the DEFAULT and must be computed; a migration that only adds `ranked` leaves nobody ranked and the leaderboard empty. Every other test starts from `reset()`, which recreates the tables WITH the columns, so this path has its own test that rebuilds the old table shape on purpose. `reset()` drops `counts` too, or stale totals would survive. Measured on the Aug 2026 data: ranking 12,942 → 55 rows read per call, player page 2,327 → 284, games 983 → 382. `test/losCost.workers.test.ts` keeps it that way: over a deliberately lopsided store (720 players, most of them lapsed, so the tail is the big half) it pins both the query plans and the rows each read actually costs — ranking page 54, deep in the tail 85, player 3, player games 44, games list 477 (25 games + their 400 roster rows), game detail 18, and a search its own match count. A read whose cost tracks the TABLE rather than the page shows up there and nowhere else, since it returns identical JSON either way. See `docs/lavaos-cloudflare-data-model.md`. |
| `los/index.ts` | The **LOS public API routes** (`losApp`, a Hono router mounted into the main app; currently no auth): POST `/api/games` (upload day files verbatim) + `/api/reset?confirm=true`, GET `/api/ranking`, `/api/games[/:id]` (both take `?includePrivate=true` too — the rosters blank a private player's rating)`, `/api/players[?q=]`, `/api/players/lookup?names=a,b,c` (bulk exact-name resolve for a lobby roster, ≤32 names, keyed by lowercased name), `/api/players/:userId[/history]`, POST `/api/players/:userId/private` (hide/unhide a profile), POST `/api/games/:id/ignored` (mark a game ignored for the next fold — see "Ignoring a game"). GETs are edge-cacheable (`max-age=60`) — except an admin view (`?includePrivate=true`), which is `no-store`. Also exports `losStub` (the singleton LosDO accessor, used by `losRatings.ts`). Formerly the separate lavaos Worker's entry. |
| `rating/lavaScores.ts` | Balance-endpoint transport for `POST /api/scores`: `parseScoresRequest` (body → trimmed, de-duplicated name list, max 16) and `fetchScores`/`mapBalanceScores` over the shared `requestBalance` POST (bare name array, 8s timeout, `→`/`←` traced) — `{elos, unknown}` for `rating_hidden` ONLY; the suggested split/user_id are ignored. (`fetchBalance`/`mapBalanceSuggestion` were removed when the bot switched to LOS.) Pure, unit-tested. |
| `barreplay.ts` | Replay availability on **barreplay** (`replay.fogofwar.dev`), the sibling deployment that re-simulates BAR replays and plays them back: `fetchReplayStatuses(ids)` resolves a whole games page in ONE `GET /api/games?id=a,b,c` (the same BAR gameId keys both systems), keyed by id — ids it does not know are absent, which is the common case and reads as "no replay". Ids are filtered to the shape barreplay accepts first (one bad id 400s the whole batch) and capped at its 100-id limit. NEVER THROWS: a non-2xx, a network failure or the 3s timeout comes back as an empty map plus the reason, so a barreplay outage costs the games list its replay links and nothing else. `replayTiming` renders the lookup as the `Server-Timing` metric the `/api/games?replays=true` route returns. Pure (injected `fetchImpl`), unit-tested in `test/barreplay.test.ts`. |
| `los/tiers.ts` | Rank tiers (cutoffs, placing games, hysteresis `nextTierIndex`) and `stripLos`, the non-admin view of any LOS body — see "Rank tiers" in `src/los/CLAUDE.md`. |
| `losLookup.ts` | Runtime-agnostic LOS bulk name lookup for the bot (`fetchLosPlayers(base, names, access)` → `GET /api/bot/players/lookup` with the bot's Access service token, keyed lowercased, chunked ≤32, throws on failure) — used by the Node bot (`BOT_LAVAOS_URL`, default lavabalance.fogofwar.dev). The Worker uses the direct DO RPC (`losRatings.ts`) instead. |
| `rating/ratingsDO.ts` | `RatingsDO` Durable Object (singleton): the persistent two-column rating cache (SQLite). The scrape owns `rating`+stats (stale-while-revalidate in the background, diff-only writes, `updated_at` = scrape view last changed, `rating_hidden` carried through every rewrite); `putScores` owns `rating_hidden` only (bare `updated_at=0` row for never-scraped names, so the scrape picks them up). `get(names)` returns the merged `StoredRating` view and schedules the background scrape. |
| `rating/ratingsClient.ts` | `RATINGS_SINGLETON` + `ratingsStub(env)` — the client accessor for the RatingsDO. Kept apart from `ratingsDO.ts` (which imports `cloudflare:workers`) so unit-pool callers like `rtsapi.ts` resolve the stub without pulling in the DO class. Mirrors the teiserver.ts / teiserverDO.ts split. |
| `teiserver.ts` | Pure HTML→JSON mapping for `GET /api/lobbies?src=teiserver`: `extractCsrfToken`, `parseLobbyIndex` (the `/battle/lobbies` list), `parseLobbyShow` (one lobby's roster + max-players/locked/bosses, read by header label so extra moderator/tester columns don't shift it), and `buildLobby` (combine index row + show page into the `lobbies()` shape). **`ShowMember.party` + `partyKey`**: the show page is the ONLY source of party membership — its "Party" column carries no text, Teiserver renders `<td style="background-color: #62ea6b;">` per party (2+ members only, colours from `StylingHelper.bright_hex_colour_list()`; verified against `lib/teiserver_web/live/battles/lobbies/show.html.heex`). So `parseTable` also returns `rawRows` and the normalised colour is used as an opaque party key — same colour = same party, unstyled = unpartied. Not exposed in the `/api/lobbies` shape; consumed by the bot's `.balance`. No I/O — unit-tested. |
| `teiserverDO.ts` | `TeiserverDO` Durable Object (singleton): the Worker-side host for `src=teiserver`. The session/transport core (cookie jar, CSRF+POST login, authed fetch with expired-session retry, DEBUG tracing) moved to the shared **`src/bot/teiserverWeb.ts`**; this DO wraps one `TeiserverWeb` instance and adds: cookie-jar **persistence in DO storage** (`COOKIE_STORE_KEY`, via the `onCookiesChanged` hook, so a session **survives DO eviction** — `hydrate()` seeds the jar back), the **5s-TTL scrape caches** (`listLobbies()` = parsed `/battle/lobbies`, `showLobby(id)` = one roster, `null` if gone), and the `lobbies(lavaIds)`/`lobby(id, lavaIds)` RPCs (LOS ratings are layered on by the route). Only the cookie jar is persisted; scrape caches are in-memory and rebuilt after eviction. |
| `config.ts` | `LOBBY_SERVER` constant, `Env`, `buildConfig`; `KNOWN_SRC_MODES` + `enabledSrcModes` (parses the `SRC_MODES` var into the enabled `/api/lobbies` source list + default); `LavabalanceConfig` + `parseConfig`/`DEFAULT_CONFIG` (the persisted runtime config). |
| `protocol/framing.ts` | line framing + `parseMessage` (space words / tab sentences). |
| `protocol/commands.ts` | outbound builders (LOGIN, JOINBATTLE, MYBATTLESTATUS, PING/PONG, FORCE*, FRIENDREQUESTLIST/ACCEPTFRIENDREQUEST). |
| `protocol/events.ts` | typed inbound parsers (BATTLEOPENED, CLIENTBATTLESTATUS, …). |
| `protocol/battleStatus.ts` | battle-status bitfield encode/decode (per-battle CLIENTBATTLESTATUS). |
| `protocol/clientStatus.ts` | global client-status bitfield decode (`CLIENTSTATUS`: rank, in-game, away, moderator, bot). |
| `public/ranks/` | static rank icons `1.png`..`8.png` (BYAR-Chobby, CC BY-NC-ND; `License.txt`), served at `/ranks/<n>.png` via the `[assets]` binding. |
| `tools/connect-test.ts` | Node CLI to probe the server (Node-only; outside tsconfig; run via tsx). |
| `src/scout.ts` | **Scouting**, the pure half (no `cloudflare:*`/`node:*`): the `ScoutCard` wire shape + `parseScoutUpload`, `laneForecast` (exact max-weight lane assignment per team), `teamScouting`, `scoutLobby` (what `/api/lobbies/:id` attaches), `scoutBoards`/`filterBoards`, `scoutLine` (the bot's one-liner). |
| `src/scoutRoutes.ts` | `scoutApp`: `/api/scout/*` (push behind OTL's Access service token (`scoutIdentity`) or an admin, failing closed; reads; admin reset). |
| `src/bot/scoutClient.ts` | The bot's `.scout` lookup over the public `GET /api/scout?names=` (injected-fetch testable, throws on failure). |
| `src/avoids.ts` | **Avoid lists**, the wire shape shared by the routes, the LosDO table and the bot (pure TS, no `cloudflare:*`/`node:*`): `MAX_AVOIDS_PER_PLAYER = 10`, the name key/display split (matched case-insensitively, stored both ways), `parseAvoidRequest` for the add/remove body, and `avoidPairsOf(entries, names)` — the reduction the balancer consumes: an entry only constrains a lobby when BOTH people are in it, and A→B and B→A collapse into one pair. An entry is DIRECTIONAL as a request and SYMMETRIC as a constraint (the balancer only knows same-team / not-same-team), and it is about TEAMS, never about who may be in the lobby. |
| `src/bot/blurb.ts` | **What `.bot` says** — three lists of ten (a prefix saying it is a bot, a middle saying it balances the games, a suffix pointing at `RANKING_URL` = <https://lavabalance.fogofwar.dev/ranking>) and `botBlurb(rand = Math.random)`, which picks one of each and space-joins them with the link. 1000 combinations, so a lobby that asks twice is answered twice differently — a bot repeating one canned string is furniture. The parts are INDEPENDENT by design (every prefix must read in front of every middle), which is what makes the lists cheap to extend: one new line adds a hundred answers. Its grammar contract is the whole of what a new line must obey — prefix and middle each end their own sentence, a suffix ends in a colon or a preposition since the URL is appended after one space — and `test/blurb.test.ts` checks it on the LISTS plus every combination for one-line-ness (no newlines, no double spaces, ends at the link). Extracted from bot.ts for the usual reason (it opens a socket at import) and one of its own: this is the only thing the bot says that is writing rather than data, and what is worth testing about writing is the whole space it can produce, not one string. |
| `src/bot/compWatcher.ts` | **The composition watcher's state machine**, extracted from bot.ts so it is testable (bot.ts connects and starts timers at import). Pure of protocol and I/O — everything it needs arrives through `CompWatcherHooks` (read the lobby, price it, force teams, log). Exports the two pure helpers too: `rebalanceVerdict` (the whole act/don't-act decision as a function of the numbers — the DEGRADED and UNFAIR rules) and `teamsLanded` (did a `!fb` arrive? each group sharing one ally, the two differing — tolerant of a join/leave mid-apply, agnostic about which ally numbers the lobby uses). See the composition-watcher paragraph under `bot.ts` for the rules and why each gate exists; `test/compWatcher.test.ts` replays the 2026-09-07 failures against it. |
| `src/bot/losCache.ts` | **The bot's LOS rating cache** (entries + ages only; bot.ts keeps the lookup transport and the roster prefetch). Extracted so the rule that matters is testable: `namesToRefresh(names, maxAgeMs, now)` — never resolved, or resolved longer than `maxAgeMs` ago. `test/losCache.test.ts` replays the 2026-09-07 23:59 staleness. |
| `src/bot/forceRejection.ts` | **Classifying SPADS's refusals of our `!fb`** (`classifyForceRejection`): any host PM opening `Cannot force id/team`, split by how long the block lasts — `autoBalance` (indefinite, latchable), `autoBlockBalance` (transient, cleared by the next roster change) and anything unrecognized (treated as transient — never latch on a guess). Pure; `handleHostForceRejection` in bot.ts acts on it. |
| `src/bot/payoff.ts` | **Did the balancing help?** `captureGameStart` (snapshot the launched teams + whether they are the bot's + what it predicted) and `describePayoff` (the one `[payoff]` log line: `botTeams=yes|no|never-forced`, the sizes, the winner, and `predictionForWinner` — the probability the model gave the side that actually won, which is what a calibration check needs). Pure; bot.ts owns the triggers. |
| `src/bot/uplink.ts` | The bot's **game-start uplink**: `createUplink(base)` → fire-and-forget `gameStart`/`gameEnd` POSTs to the Worker's `/api/gamestart|gameend` (base = `BOT_UPLINK_URL` or the LOS base). One retry after 5s, then a `[uplink] … dropped` log line; NEVER throws — the callers sit on the tracker-queue path and a dead Worker must cost the bot nothing. No auth header (endpoints open for now). Hooked in bot.ts: `watchGameLifecycle` uploads the full `tracker.roster()` (spectators included) on the founder's 0→1 edge and a `reason:"ingame-clear"` game-end on the 1→0 edge; `handleGameResult` sends `reason:"result"` BEFORE its pendingGame guard, so a post-restart verdict still unfreezes the page. Unit-tested with an injected fetch (`test/uplink.test.ts`). |
| `src/auth.ts` | **Website login**, the pure half (Web Crypto only): `newToken` (32 random bytes, base64url), `hashToken` (SHA-256 hex — the only form stored), `parseIssueRequest`, the `__Host-lb_session` cookie both ways, `sameOrigin`. The flow and why it runs bot → player is in its header and the control-plane row above. Unit-tested in `test/auth.test.ts`. |
| `src/authRoutes.ts` | `authApp`, the `/api/auth/*` routes (mounted by `index.ts`; `GET /login` is registered there) and `currentUser(c)` — the logged-in account of a request, for whatever gets gated on it later. |
| `src/bot/authClient.ts` | The bot's **website-login client**: `createAuthClient(base, {token})` → `issue(name, userId)` / `revoke(userId)` behind `.login` / `.logout`. Throws on any non-2xx; the handler logs and answers "unavailable". The bot keeps a name → account-id map from `ADDUSER` (`accountIds`) to fill in `userId`. Unit-tested in `test/authClient.test.ts`. |
| `src/bot/avoidClient.ts` | The bot's **avoid-list client**: `createAvoidClient(base, {token})` → `list`/`add`/`remove`/`pairs` over `/api/avoids/*`, with the control token as a bearer header when one is configured. The lists live in the Worker because the container's disk is ephemeral — a restart would lose everybody's. 404/409 are the add route's own refusals and come back as VALUES; every other non-2xx throws, and the command handler turns that into "unavailable right now" (the real error goes to the log, never to a player). Unit-tested with an injected fetch (`test/avoidClient.test.ts`). |
| `src/bot/teiserverWeb.ts` | `TeiserverWeb` — the plain in-memory Teiserver web-UI session (cookie jar, lazy CSRF+POST login, authed fetch with expired-session retry, password-redacted debug tracing), extracted from the old TeiserverDO. Runtime-agnostic (global fetch only — no `cloudflare:workers`, no `node:*`): used directly by the Node bot, and wrapped by `teiserverDO.ts`, which persists the jar via the `onCookiesChanged` hook. Config (email/password/debug) is read lazily through a provider closure. |
| `src/bot/bot.ts` | Standalone chat bot (`pnpm run bot`): plain Node (no Worker/DO), logs into Teiserver with `BOT_LOGIN`/`BOT_PASSWORD` from `lavabalance/.env` (built-in `process.loadEnvFile`, password md5→base64 hashed locally) and prints every SAID* chat message to stdout. Admin commands via whisper from `BOT_ADMINS` accounts (comma-separated, case-insensitive): `.join <battleID>` → JOINBATTLE + spectator MYBATTLESTATUS (LEAVEBATTLE first if already in one), outcome whispered back via SAYPRIVATE; `.info` (whisper-only, open to everyone, no cooldown/lookup → `printInfo`: whispers back everything the bot tracks — its own connection/balance state and the joined battle's full tracked snapshot incl. the host's `autoBalance`/`balanceMode` (with the party rule it implies)/bosses, and the per-team roster with decoded statuses — only values the bot acts on, so NO mod options (tracked, unused); long groups split at `INFO_LINE_MAX`); `.status` (open to EVERYONE, not just admins; global 5s cooldown — calls inside the window silently ignored, also caps ratings-lookup traffic; `.status` is additionally ignored below `MIN_PLAYERS_FOR_REPORT` = 6 non-spectator players, checked after the tracker queue drains so the count is current — no lookup request is made) → prints the joined lobby's players (no spectators; roster from the bot's own `SessionTracker` — no web API involved; **LOS via the bot's own cache** (`cachedLos` over `losLookup.fetchLosPlayers`; the entries themselves live in `src/bot/losCache.ts`, extracted so the age rule is testable): ratings are PREFETCHED in a debounced background fetch the moment JOINEDBATTLE/CLIENTBATTLESTATUS lines show someone in the roster (`scheduleLosPrefetch`, 1s debounce, single-flight with a go-again flag; "not rated" is cached too, as null, so unknown players are cache hits), entries are global, kept warm off the hot path once older than `LOS_CACHE_TTL_MS` (10 min) and capped at `LOS_CACHE_MAX` = 1000 oldest-first, size shown in `.info`'s `losCache=`; shown 1-dp. **But no matchup is ever computed from an entry older than `LOS_MAX_AGE_MS` = 15s**: `cachedLos` refreshes those INLINE, and all three of its callers — `runBalance`, the composition watcher's `winChance`, `runStatus` — decide or report on a matchup. Ratings move under the bot's feet: a lava lobby finishes a game and re-forms with the same people, all of whom now rate differently, and the store learns the game from a scraped replay MINUTES after it ends (2026-09-07: game 23:41:52-23:55:24, ingested 23:59:07), so there is no event to invalidate on — a refresh at the final whistle just re-caches the pre-game numbers. Serving whatever age the cache held is what made the `.balance` at 23:59:41 balance on ratings from before that game, rebuild the winning and losing sides, and announce "26.8 (50.0% win) vs 26.7 (50.0% win)" for teams the website scored 26.3 (38.3%) vs 27.2 (61.7%). A refresh that FAILS is survivable and does not fail the command (the cache still holds the last ratings resolved); a name never resolved at all still throws, since the caller would otherwise balance on a phantom debutant) grouped by the lobby's current ally teams (0-based bitfield allies shown 1-based) as padded `NAME LOS` stdout columns, plus (two-team lobbies) a CURRENT-teams matchup line (`Lava OS: team 1: X (p% win) vs team 2: Y (q% win)`; win % from OpenSkill `predictWin` via `teamsWinProb`, NOT an Elo formula) which is BOTH printed and sent through the command's `reply` — a whispered `.status` gets it via SAYPRIVATE, a battle-chat `.status` gets it **in the battle chat** (`battleReply`: ALWAYS SAYBATTLEEX — the italic announce form, same as `.balance`'s answer, boss or not; the ONLY thing the bot says out loud — `!force`/`$lock` stay dry-run). Roster tables stay stdout-only. `handleBattleCommand` ignores chat from our own account so the echoed reply can't loop, and `isBoss` reads the battle's BarManager boss list directly (not the roster) so it works for the bot itself, which may have no CLIENTBATTLESTATUS of its own — unrated = a debutant (`UNRATED_STATE`/`UNRATED_LOS` from `balance/balancer.ts`, matching the web UI); battle chat accepts commands too — `.status` from anyone (shared cooldown; ALSO auto-triggered into the battle chat when anyone writes `!start`/`!cv start`, so the teams being voted on go on record), `.lavatoggle` from bosses + admins — and the bot auto-answers ONE host announce: the founder's standard balance summary (`* Balancing according to current balance mode: …`, `handleHostBalanceAnnounce`) — what anybody's `!balance` produces — and WHAT it answers depends on who balances the lobby: while the BOT is the balancer (`autoBalance` arming flag on and `botCanBalance` clear — i.e. the lobby's own autoBalance is off and nothing blocks our `!fb`) it re-runs its OWN live balance `HOST_BALANCE_REBALANCE_DELAY_MS` = 500 ms later (re-checking `botCanBalance` when the timer fires, since the lobby can change in between), tagging the matchup line with `HOST_BALANCE_SUFFIX` = " (rebalanced after !balance)" — otherwise any player could overwrite the bot's teams by typing `!balance` and the game would launch on SPADS's split; when the LOBBY is its own balancer the bot stays a bystander and merely REPORTS, triggering a battle-chat `.status` 100 ms later (`HOST_BALANCE_STATUS_DELAY_MS`, same `tryRunStatus` cooldown + min-players gate). Both paths are founder-gated and only run when the bot is a boss — and host-RELAYED chat (`SAIDBATTLE <founder> "<player> msg"`, how in-game players' chat arrives) is unwrapped, gated on the speaker being the battle's founder so plain chat can't impersonate; `.balance` (LIVE form **boss-only on both sides** — `balanceAllowed(from, reply)`: the asker must be a lobby boss, BOT_ADMINS is deliberately NOT enough, and the bot must be a boss too or SPADS would reject its `!force`; a refusal is announced in the battle chat with the reason, plus the stdout log; the WHISPERED preview skips balanceAllowed entirely — it moves nobody, so it is open to everyone behind its own 5s cooldown (`lastBalancePreviewRun`), which replies when throttled instead of ignoring silently) → roster from the bot's own **SessionTracker** (instant — no web wait on the command path; the old synchronous Teiserver scrape cost ~3s per `.balance`), parties from the **party cache**: party membership exists only on Teiserver's show page (`parseLobbyShow`, party = Party-column colour), so `.balance` AND `.status` each kick off a BACKGROUND scrape (`refreshParties`, single-flight, never awaited; silently skipped without `BOT_TEISERVER_EMAIL` — `.balance` then runs party-blind instead of erroring) whose result (`partyCache`: lowercased name → party key, per battle, cleared in `resetBalanceState`, shown in `.info`'s `partyCache=`) is used by the NEXT `.balance`; the first run in a lobby honours no parties (deliberate). **The lobby's `balanceMode` decides whether parties count at all**: `clan;skill` (and an unseen mode) keeps them together, `skill`/`random` balances everyone individually — `runBalance` drops the `partyId`s and `refreshParties` does not even scrape (`honoursParties`, src/balance/balanceMode.ts; `random` is handled as `skill` — the bot does not roll dice). Shown in `.info` (`parties=kept|ignored (balanceMode)` on the `balance:` line, the setting itself with its party rule on `host settings:`). Prints the parties (with cache age), runs the local `balanceTeams` with LOS ratings (unrated = debutant), then prints the suggested teams (party-tagged) and the `!fb` command. **The whole arrangement is applied as ONE SPADS command** — `!fb (a,b,c)(d,e,f)` (`!fb` = SPADS's alias for `force *`, the manual-balance form: first group → team 1, second → team 2, ids assigned sequentially), players inside each group LOS-DESCENDING (unrated = debutant value), the group→team orientation picked to change fewer players' sides, and nothing sent at all when the lobby already matches — one command means no mid-balance window for players to shuffle (the old per-player `!force <name> team <N>` burst, 300ms apart, had one). **The asking channel decides live vs preview** (`runBalance(reply, live)` → `applyTeams`): from BATTLE CHAT it is LIVE — the command is really sent via `spadsWire` (PM to the founder), but ONLY when the lobby's own autoBalance is `off`: SPADS's `hForce` rejects manual teams otherwise, so **every live path is gated on `autoBalanceBlocksForce()`** (`balanceAllowed` for a boss's `.balance`, `botCanBalance` for the automatic ones) and a blocked `.balance` is REFUSED in the battle chat naming the reason — sending an `!fb` the host throws away made the bot announce (and baseline on) teams the lobby never got, which is what produced the 2026-09-07 rebalance storms. The tracked setting is only as fresh as the last broadcast, so the refusal PM itself (founder-gated, `handleHostForceRejection`, classified by `src/bot/forceRejection.ts`) is read too. SPADS's `hForce` has MORE THAN ONE refusal and they do not last the same time, so they are handled apart: **"Cannot force id/team, autoBalance is enabled"** LATCHES `forceRejectedByAutoBalance` (announced once, and `autoBalanceBlocksForce` then blocks everything until a broadcast flips the setting back to `off`, which also clears `balanced` for a fresh attempt), nulls `winBaseline` (the announced arrangement never happened) and ends any blackout; the latch is per-lobby (cleared in `resetBalanceState`). **"Cannot force id/team, teams have been balanced and autoBlockBalance is enabled"** — what a player's own `!balance` produces, and the 2026-09-07 bug: matching only the autoBalance string left it unrecognized, so the bot announced its 50/50 line for teams the host had thrown away, twice, while the lobby played SPADS's split. It is TRANSIENT (the next roster change invalidates SPADS's balance and unblocks us), so it is never latched: `compWatcher.forceRejected` drops the blackout, re-baselines on the lobby's REAL win chance and starts the 30s hold-off. Any unrecognized `Cannot force id/team` refusal takes that same transient path — never the latch. Both kinds SAY so in battle chat, and are shown in `.info`. **The bot also OWNS `autoBlockBalance` in a lobby it balances**: that setting lets any player lock the bot out simply by typing `!balance` (SPADS then refuses every `!fb` until its own balance is invalidated), so while `forceTeamsBlocked()` is null — the bot is a boss and the lobby's autoBalance is off — the bot holds the lock open with `!set autoBlockBalance 0`, and hands it back with `!set autoBlockBalance 1` the moment it stops being the balancer or leaves the lobby (`syncAutoBlockBalance`, run from the 5s balance poll; `restoreAutoBlockBalance` before a `requestJoin` leaves). The trade is deliberate — with the lock off, players can switch sides after a balance, which is what the start-vote guard and the composition watcher are for. A refusal that gets through anyway means the lock came back behind our back: `clearBalanceLockAfterRefusal` clears it ONCE (a boss who re-enables it is not fought in a loop — `autoBlockBalanceUnblockTried`, reset when a force next lands), says so in battle chat, skips the watcher's retry cooldown (`forceRejected(reason, holdOff=false)` — the block is gone, waiting 30s would only delay the retry) and re-runs the balance after `BALANCE_LOCK_RETRY_MS`. `handleHostSettingAnnounce` follows the setting from the host's `* Global setting changed by X (autoBlockBalance=N)` line, so `.info` shows both the lobby's value and whether the bot is the one holding it open; WHISPERED it is a preview — the command is whispered to the asker and nothing reaches the host. **The matchup line WAITS for the teams to land.** It used to go out in the same millisecond as the `!fb`, which made it a claim about an arrangement the bot had only ASKED for — and on 2026-09-07 the lobby played something else while that claim stood (the `!fb` at 23:18:34 was refused, the game launched 12s later on SPADS's split). So a live force now announces nothing until the composition watcher's new `onTeamsLanded` hook fires — the same `teamsLanded` test its blackout uses, ~200-420ms later — and the baseline waits with it, since the watcher must never judge against teams only asked for (`pendingAnnounce`/`announceLandedTeams`/`dropPendingAnnounce`). Every way it can fail says so instead, so nothing is ever left hanging: the host's refusal (`handleHostForceRejection`), the blackout expiring off-target (`onForceLost` → "the teams I set did not take"), and a newer force superseding this one. A whispered preview and a lobby that already matches the suggestion announce IMMEDIATELY — nothing is in flight to wait for. Live always answers in battle chat (SAYBATTLEEX; the bot is guaranteed boss by `balanceAllowed`), a whisper via SAYPRIVATE. The auto-balance path (`doBalance`) stays dry-run via `spadsCommand`; `.lavatoggle` (originally ported from the LavaBar widget, whose `.lavastatus` preview companion is GONE — a whispered `.balance` is the same preview with parties, open to everyone, so gating a weaker copy behind admin/boss bought nothing) → auto-balance at exactly 16 players via the same local LOS `balanceTeams`: **DRY-RUN — `announce()`/`spadsCommand()` only print the would-be `!force * (t0)(t1)` + `$lock team`/`$lock allyid` to stdout**; going live is confined to those two functions (announce → SAYBATTLEEX-when-boss, SPADS commands → SAYBATTLE only). One balance per battle (`balanced` flag, reset on battle change/reconnect), 5s roster poll, single in-flight lookup. In battle chat `.lavatoggle` answers via `battleReply` like `.status`, not into the log (its whole output used to land in a log file, which reads as a broken bot). `.bot` (open to everyone, whisper or battle chat, no lookup and no cooldown) whispers/announces `botBlurb()` (src/bot/blurb.ts), ONE line saying what the bot is and linking the ranking — assembled from three lists of ten, so each ask is worded differently. The introduction, said OUT LOUD when asked in the battle chat because that is who it is for, where `.help`'s dozen lines stay a whisper. NO whisper is dropped in silence any more, command or not: `.help` (`printHelp`, open to everyone — intro + `SITE_URL` + the commands, the `ADMIN_COMMANDS` section only for admins; one SAYPRIVATE per line) lists what the asker may use, an unknown command is answered pointing at it, an `ADMIN_COMMANDS` entry from a non-admin is told it is admin-only (still logged), and a whisper that is not a command at all gets `answerUnknownWhisper` — one line naming `.help`, because silence is exactly what a broken bot looks like and somebody typing "can you balance this?" has no way to learn there is a command for it. That one is rate-limited (`UNKNOWN_WHISPER_COOLDOWN_MS` = 5 min per sender, the map cleared wholesale past 500 senders) and skips the bot itself and any tracked battle's FOUNDER (`isTrackedHost`): autohosts PM the bot and read no answers, and two bots trading "I didn't understand" is a loop nobody is reading. **Help indentation is U+2001 EM QUAD, not spaces** (`IND`/`CMD_INDENT`/`WRAP_INDENT`, and `BLANK` with it): BAR's lobby chat collapses leading ASCII spaces, so every indented line rendered flush left until this (verified in the lobby, 2026-09-22). In battle chat `.help` answers with ONE line pointing at the whisper; other unknown lobby `.command`s stay silent. **Start-vote guard** (`checkVoteGuard`, re-run behind the tracker queue after every vote/roster-relevant line — `VOTE_GUARD_CMDS`): SPADS launches a passed `!start` vote on whatever the teams are AT THAT MOMENT (nothing server-side invalidates the vote when players shuffle mid-vote), so while a start vote is in progress (`Battle.voteInProgress`, command `start`/`forceStart`) the guard baselines the team composition (`teamSignature`: known non-spectator players + allies) at vote start and, on ANY change — join, leave, side switch, player↔spec — sends **`!ev`** (SPADS's `!endvote` alias) via `spadsWire` and announces why (SAYBATTLEEX). **Only with a fresh arrangement to protect**: the change must land within `BALANCE_PROTECT_MS` = 15s of the last LIVE `.balance`/auto-balance (`lastLiveBalanceAt`, stamped in `runBalance`, 0 = never); a later change is logged and merely becomes the guard's new baseline. Fires ONCE per vote; boss-gated via `botCanBalance` (a non-boss `!ev` would be ignored — then it only logs); a tracked vote older than `VOTE_GUARD_MAX_MS` = 120s is treated as stale (a missed `onVoteStop` must not arm the guard forever); state reset with the rest in `resetBalanceState`, and shown in `.info`'s `vote in progress:` line. **Composition watcher** (`src/bot/compWatcher.ts` — EXTRACTED from bot.ts so it can be tested: bot.ts opens a socket and starts timers at import, so nothing can import it, and the 2026-09-07 storms were a state-machine bug; `test/compWatcher.test.ts` replays them. bot.ts keeps only the wiring — thresholds, the hooks that read the lobby, and the callers that re-baseline it or open its blackout): the pre-vote mirror of the start-vote guard. It remembers the team-1 win chance last REPORTED (the BASELINE: every `.status` summary and every LIVE `.balance` set it via `compWatcher.setBaseline`; whispered previews do not) and on any team-composition change (trailing `COMP_CHANGE_DEBOUNCE_MS` = 100ms debounce, so a leave-and-refill burst is judged once on the settled roster) re-estimates the current win chance via `matchupLine`. `rebalanceVerdict` (pure, unit-tested) then gives TWO reasons to act: **DEGRADED** — `|win−50|` grew by more than `WIN_DEGRADE_PP` = 10pp since the baseline; and **UNFAIR** — `|win−50|` is over `ABS_UNFAIR_PP` = 0pp right now, i.e. EVERY composition change at a full lobby is rebalanced and only the dead band decides whether the result is worth sending (20pp until 2026-09-27, which tolerated a full lobby at up to 70/30), baseline or no baseline. The absolute rule exists because the baseline follows what the bot REPORTED and `.status` reports the lobby as it is: on 2026-09-07, 18 of 28 `.status` runs baselined the watcher past 10pp (13 past 25pp — 2.7%, 94.9%, 97.9%), after which the degrade rule can never fire again — and `.status` is auto-triggered by `!start`, so calling a vote on a stacked lobby DISARMED the watcher exactly when it mattered (12 of the 24 full-lobby `.status` reports that day were past 20pp). Acting means the live `.balance` path (`runBalance(battleReply, true, {summarySuffix, skipUnlessBetterThan})`). **Five gates stop it firing on its own tail** (2026-09-07 saw 72 rebalances, one lobby taking 21 in 3 minutes; replaying that day against the storm gates leaves 3): (1) FULL LOBBY — exactly `BALANCE_SIZE` = 16 players, because `teamsWinProb` sums ratings so an 8v7 reads as a landslide on team size alone (one player leaving a balanced 8v8 moved the estimate 50.0% → 84.4%) and every join/leave in a filling lobby would look catastrophic; when someone leaves there is nothing to balance until it refills. (2) NOT DURING A GAME (`gameInProgress()`: the founder's global in-game bit). (3) BLACKOUT (`startBlackout`/`endBlackout`, `BLACKOUT_MS` = 3s) — a live `!fb` takes 200-420ms to come back as CLIENTBATTLESTATUS and SPADS applies it in SEVERAL bursts, so judging the lobby mid-application measures a half-applied arrangement (~100% win) and starts a rival rebalance (two conflicting `!fb` went out 80ms apart at 19:54:11 and moved 16 players twice; 20 of the 72 triggers fired within a second of the bot's own previous force). `sendTeams` records the two GROUPS it asked for and the watcher judges nothing until `teamsLanded` says the lobby has arrived (each group sharing one ally, the two differing — deliberately NOT whole-composition equality, so it tolerates a join/leave mid-apply and does not assume allies 0/1) or 3s pass. Changes during the blackout are queued and judged ONCE when it lifts; `run()` is single-flight and LOOPS rather than recursing, so the LOS-lookup await cannot let two checks overlap. (4) DEAD BAND (`MIN_REBALANCE_GAIN_PP` = 1) — `runBalance`'s `skipUnlessBetterThan` is the lobby's CURRENT win chance; under 1pp of improvement nothing is sent and that value becomes the baseline. (5) HOLD-OFF (`FORCE_RETRY_COOLDOWN_MS` = 30s, `holdOff()`) — no automatic force, nor the log line explaining it, after a force that failed to land or one that was blocked (a dead-band skip no longer holds off since 2026-09-27: with every change a trigger, it would swallow the next real one): an UNFAIR lobby the balancer cannot fix, or one whose autoBalance is left on, is over the threshold permanently and would otherwise re-decide on every roster event. **A force that does not land is a FAILURE, not a success**: when the blackout expires off-target the baseline is corrected to the lobby's REAL win chance (`rebaselineOnReality`) — the bot must never keep judging against teams it only asked for — and the hold-off starts. `.info` shows all of it on a `comp watcher:` line. **Payoff record** (`src/bot/payoff.ts` + `watchGameLifecycle`/`handleGameResult`, tested in `test/payoff.test.ts`): the bot now records whether its balancing reached the game. At game start — the FOUNDER's in-game bit going up, followed up from CLIENTSTATUS but deliberately NOT via `VOTE_GUARD_CMDS` (CLIENTSTATUS is server-wide: 100,785 lines on 2026-09-07, 38% of all traffic, and it says nothing about team composition), so only our own host's line queues work — `captureGameStart` snapshots the launched roster (gone seconds later, players leave a running game), whether it is the arrangement of the last live `!fb` (`lastForcedTeams`, via the same `teamsLanded`) and the announced prediction; the host's `* Ally team N won!` / `Game result undecided` then emits ONE greppable `[payoff]` status line via `describePayoff`. `botTeams=yes|no|never-forced` keeps DELIVERY (are the bot's teams the ones that play? only 2 of 10 decided games on 2026-09-07) apart from CALIBRATION (`predictionForWinner` = the probability the model gave the side that actually won). `BOT_AUTOJOIN_ROOM` (integer battle id, optional; in production OVERRIDDEN per container start by the supervisor's resolved rejoin target — see botContainer.ts) auto-joins on LOGININFOEND — after every login, so reconnects rejoin; an in-process reconnect PREFERS `lastJoinedBattleId` (the battle actually joined last, surviving the disconnect) over the env var, and an automatic rejoin that JOINBATTLEFAILEDs (lobby closed while disconnected) falls back to the env-var room once. Battle membership tracked from JOINBATTLE/JOINBATTLEFAILED/LEFTBATTLE replies, reset on reconnect. **Two daily log files** in the project dir (gitignored via `*.log`, `DailyLog` class): **raw protocol lines are never written to stdout** — ALL of them, both directions, go ONLY to `commands_<YYYY-MM-DD>.log` (`→`/`←` prefixed, LOGIN hash redacted); and `bot_<YYYY-MM-DD>.log` mirrors EVERYTHING `console.log/warn/error` prints (the globals are wrapped at startup, so the shared modules' output — tracker `[session]`, teiserverWeb tracing — lands there too) while the same lines still go to stdout/stderr. stdout carries status lines, chat, and errors — plus SERVERMSG text as a `* server: …` status line (server feedback, e.g. "No incomming match" for a malformed command). **Internal errors are logged, never sent to players**: every command's catch block goes through `logError(context, e)`, which logs ONE structured JSON line (`logEvent`: `{ts, level, msg, error, err: {name, message, stack, props}, causes: [...]}` — the container log viewer splits on newlines, so a multi-line stack used to land as a dozen separate entries; `status()` lines are `{ts, level: "info", msg}` too) with the message, the stack, and the full `cause` chain (Node's fetch throws a bare "fetch failed" whose real reason — ECONNREFUSED/ENOTFOUND/TLS — is only in `cause`; `losLookup` additionally wraps it so the URL is named), and the asker only gets a generic ".status: unavailable right now, try again later"-style notice. JOINBATTLE must be sent with all three args (`<id> empty <scriptPassword>`, random numeric script password per process) — Teiserver's regex `^(\S+) (\S+) (\S+)$` silently drops a bare `JOINBATTLE <id>` with only a SERVERMSG. PONG replies + 30s keepalive PING, reconnect with backoff, exits on DENIED. **Friend requests are auto-accepted**: LOGININFOEND also sends `FRIENDREQUESTLIST`; every inbound `FRIENDREQUESTLIST userName=<name>` line is answered with `ACCEPTFRIENDREQUEST userName=<name>` (status-logged), and Teiserver's live `s.user.new_incoming_friend_request` push (it carries only the requester's account id) just re-queries the list, so online requests are accepted the same way. **Fatal exit is loud**: a `DENIED` login logs one `FATAL: login denied, exiting with code 42` error event carrying the reason, the account and the likely cause (wrong/hashed/newline-terminated `BOT_PASSWORD`) before `process.exit(FATAL_EXIT_CODE)` (= 42, the ONE code the supervisor treats as fatal — missing credentials and a bad `BOT_AUTOJOIN_ROOM` use it too; any other exit code is restartable); the supervisor then stops retrying (see `botContainer.ts`). Trailing CR/LF is stripped from `BOT_LOGIN`/`BOT_PASSWORD` (a piped `wrangler secret put` stores the newline). **Health endpoint**: with `BOT_HEALTH_PORT` set (the container image sets 8080) a `node:http` server answers `GET /health` with JSON (`connected`, `battle`, `pendingBattle`, `webLogin`, **`lobbyAutoBalance`** = the LOBBY's own SPADS setting verbatim (`off`/`advanced`/…, null = not broadcast yet), **`botCanAutobalance`** = OUR balancer's arming flag, which is normally its INVERSE (the bot balances only while the lobby's own autoBalance is off) — it was published as `autoBalance` until it was read as the lobby setting and found to mean the opposite —, **`forceTeamsBlocked`** = null when the bot may set teams, else why not, **`lobbyBalanceMode`** = the lobby's `balanceMode` verbatim (null = not broadcast) and **`botKeepsParties`** = what it means for our split, `boss`, `balancedThisBattle`, `lastPlayerCount`). The `lobbyAutoBalance`/`botCanAutobalance` split is deliberate: one field is the lobby's SPADS setting and the other is our arming flag, and in normal operation they are opposites — publishing only the latter, under the name `autoBalance`, made the bot page read as if the bot had the lobby setting backwards; the BotContainer waits for that port on start and relays it in `/bot/status`. The same server accepts `POST /join {battle}` (the HTTP twin of `.join`, reached only from the supervisor via `POST /bot/join`) → `requestJoin`, answering 202/200/400/409. Handles SIGTERM (the container stop signal) like SIGINT. CLI flags: `--host`/`--port` (lobby server; else `BOT_HOST`/`BOT_PORT` env, else config), `--help`. (The Dispatcher uplink / `commands.*.log` writer is gone.) After the lobby login (ACCEPTED) it also logs into Teiserver's web API via `TeiserverWeb` with `BOT_TEISERVER_EMAIL` (the Worker's `TEISERVER_EMAIL` secret, passed by BotContainer; unset/empty = skipped with a note), using the same plaintext `BOT_PASSWORD`. (Node-only; run via tsx; the ONE src file excluded from tsconfig — it uses `node:*` and this project has no @types/node.) |
| `tools/fit-lava-k.ts` | Offline fit of Lavabar's rating-update rule from its match history, for the odds strip's elo swing: pages `/matches/`, scrapes each match's per-player `After`/`Δ` + team `Avg`, validates that the badge is the pre-match average, then grid-fits `Δ = K·(1−E)^p` and prints the constants + residuals + a held-out check. Nothing in the Worker imports it. (Node-only; outside tsconfig; run via tsx.) |

## Gotchas

- **DO must `extend DurableObject<Env>`** (from `cloudflare:workers`) for wrangler-4
  runtime types (the brand). Use `this.ctx.storage`. Don't name a private method
  `connect` (clashes with the base class — ours is `openConnection`); likewise `fetch`
  is the base class's request handler, so `TeiserverDO`'s helper is `webFetch`.
- **`src=teiserver` parsing lives apart from the DO:** the pure parse/map functions are in
  `teiserver.ts` (no `cloudflare:workers` import, so they unit-test in the Node pool); the
  DO that imports `cloudflare:workers` is `teiserverDO.ts`. Keep that split — a single file
  would break the unit-pool import.
- **Runtime types** come from `worker-configuration.d.ts` — regenerate with
  `pnpm exec wrangler types --strict-vars=false` after editing `wrangler.jsonc` (non-literal
  var types: the literal defaults broke tests that construct an `Env` with other
  values, and clashed with the optional re-declarations in `src/config.ts`);
  `@cloudflare/workers-types` was removed.
- **Extensionless imports** only (esbuild/wrangler won't resolve `./x.js` → `x.ts`).
- **`tools/` is excluded from tsconfig** (Node-only, uses `node:*`); it runs under
  `tsx`, not tsc. Don't add `@types/node` (it would pollute the Worker typecheck).
- **WebCrypto has no MD5.** Password is stored pre-hashed; the lobby_hash fingerprint
  uses a small non-crypto hash (`hexFingerprint` in `bot.ts`).
- **DO longevity:** a Durable Object can be evicted; don't keep anything only in
  memory that must survive. (Open outbound sockets do keep a DO alive since
  2026-06-19, but the bot no longer runs in one — see BotContainer.)
- **`cloudflare:sockets` types:** `Socket`/`SocketOptions` are GLOBAL interfaces in
  `worker-configuration.d.ts`, not exports of the module — import only `connect`.
- **`wrangler deploy` needs Docker** (it builds the container image even for
  `--dry-run`). Without Docker: `wrangler deploy --containers-rollout=none` ships
  the Worker and leaves the container image untouched.
- **Containers need the Workers Paid plan**; the `/sql` page's Free-plan budget
  projections predate that.
- **Container stdout is NOT in `wrangler tail`** — `tail` shows only the Worker/DO
  side (the `bot container: …` supervisor lines). The bot's own output (status
  lines, chat, errors, the FATAL exit reason) is in the dashboard: Workers & Pages →
  lavabalance → Logs (container logs are interleaved there). `GET /bot/status`
  carries `lastError` for the headline. A shell in the running instance:
  `pnpm exec wrangler containers instances <container id>` (from `containers list`) for
  the instance id, then `pnpm exec wrangler containers ssh <instance id>`. The SSH
  server runs in the VM around the container (no sshd in the image; all VM
  processes are visible in the shell). Access is authenticated ONLY against
  `containers[].authorized_keys` in wrangler.jsonc — `{name, public_key}` entries,
  **ssh-ed25519 only** — and the keys reach an instance when it STARTS: add the
  key, deploy, then restart the bot (`POST /bot/stop`, `POST /bot/start`). With no
  matching key, or on an instance started before the key was deployed, the command
  fails with "Web socket error: Unexpected server response: 400"; a provisioned
  key that ssh doesn't OFFER gives "Permission denied (publickey)". The recipe
  that works (key `~/.ssh/cloudflare_containers`, `ssh-keygen -t ed25519`):
  ```bash
  ssh -i ~/.ssh/cloudflare_containers \
    -o ProxyCommand="pnpm exec wrangler containers ssh --stdio %h" \
    cloudchamber@<instance id>
  ```
  from `lavabalance/` (so `pnpm exec` finds the local wrangler; a bare `wrangler` in the
  ProxyCommand fails with "exec: wrangler: not found" unless installed globally).
  `--stdio` is what makes wrangler usable as a ProxyCommand; the plain
  `pnpm exec wrangler containers ssh <id>` wrapper spawns its own `ssh` that only tries
  default identity files, so a key with a non-default name is never offered unless
  `ssh-add`ed. SSH is not "activity" and won't wake a stopped instance. Docs:
  containers/guides/ssh/.
- **Plain TCP to :8200 from a container WORKS** (verified 2026-09-05: the bot
  reached Teiserver and got a protocol reply from inside the container).
- Some sandboxes block outbound TCP to `:8200`, so the bot/CLI can't be live-tested
  there — verify from a machine with normal egress.

## Status / roadmap

**2026-09-05: the bot runs on Cloudflare** — `src/bot/bot.ts` unchanged, in a
Container supervised by `BotContainer` (migration v8; the one-day `LavaBot` DO PoC,
migration v7, was replaced by it). The proxy/Dispatcher upload tap is removed.

## Git

Don't put the model identifier in commits/code.
