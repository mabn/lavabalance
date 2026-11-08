# The lavabalance bot — operating manual

The bot is `src/bot/bot.ts`, a plain Node process that logs into BAR's Teiserver
with its own account, sits in a lobby as a spectator, answers chat commands and
runs the LOS balancer. In production it runs in a **Cloudflare Container**
(`Dockerfile`), supervised by the `BotContainer` Durable Object
(`src/botContainer.ts`) inside the lavabalance Worker. Locally it runs with
`pnpm run bot`.

## API endpoints (control plane)

All under the Worker (`https://lavabalance.fogofwar.dev`, or the workers.dev
URL). Bearer auth when the `CONTROL_TOKEN` secret is set:
`-H 'authorization: Bearer <CONTROL_TOKEN>'`.

| Method & path | What it does |
|---|---|
| `GET /bot` | The **bot admin page** (HTML, no token needed for the page itself): a prominent banner saying which lobby the bot is in (linked, with the lobby title; "not in any lobby" when idle), everything `GET /bot/status` returns, **Start / Stop** buttons, a **Join main lobby** button (the configured lava lobby, id shown on the button) and a **join-by-id** field. Admin-only in the UI (admin mode = signed in with Cloudflare Access, the same switch as the SQL page — the 🤖 Bot sidebar entry is hidden otherwise). The page's own status/start/stop/join calls need that Access sign-in or the bearer token: a token field on the page (kept in that browser's localStorage) supplies the latter. |
| `POST /bot/start` | Persist "the bot should run" and start the container if it isn't up. Waits for the bot's health port; answers **200** with the status below when it came up, **503** with the same body when it didn't (`lastError` says why). Also re-arms the bot after a fatal exit (see below). |
| `POST /bot/restart` | Persist "the bot should run", **stop the current instance** (waiting for it to actually exit), then start fresh. Same 200/503 answers as `/bot/start`. The manual bounce (`pnpm run bot:kick` POSTs it) — unlike `/bot/start`, it works while an instance is up. After a deploy the cron brings the bot back within 5 minutes on its own; this is how to do it sooner (see "Keep-alive"). |
| `POST /bot/stop` | Persist "stopped" and SIGTERM the container. The cron then leaves it alone. |
| `GET /bot/status` | `{running, status, exitCode?, lastStartedAt?, lastStop, lastError, bot, lastBattle}` — `running` = persisted intent; `status` = the platform's instance state (`running`/`healthy`/`stopping`/`stopped`/`stopped_with_code`); `lastStop` = `{at, exitCode, reason}` of the last stop; `lastError` = why it isn't running when it should be; `bot` = the process's own `GET /health` answer (`connected`, `battle`, `pendingBattle`, `webLogin`, **`lobbyAutoBalance`** = the LOBBY's own SPADS setting verbatim (`off`/`advanced`/…, null = not broadcast yet), **`botCanAutobalance`** = OUR balancer's arming flag, which is normally its INVERSE (the bot balances only while the lobby's own autoBalance is off) — it was published as `autoBalance` until it was read as the lobby setting and found to mean the opposite —, **`forceTeamsBlocked`** = null when the bot may set teams, else why not, **`lobbyBalanceMode`** = the lobby's SPADS `balanceMode` verbatim (`clan;skill`/`skill`/`random`, null = not broadcast yet) and **`botKeepsParties`** = whether that mode makes the bot keep party members on one team, `boss`, `balancedThisBattle`, `lastPlayerCount`), or `null` when down; `lastBattle` = the battle the bot was last seen in (persisted — the restart rejoin target, see below). |
| `POST /bot/join` | Make the bot join a battle — the HTTP twin of the `.join` whisper. Body `{"battle": <id>}`, or an **empty body** to join the current **main** lobby (the configured lava lobby; auto-picked via the same throttled Teiserver lookup as the web UI when nothing is configured). The join is async on the lobby protocol: **200** = the bot accepted (JOINBATTLE sent, or already in that battle — the outcome lands in `/bot/status`'s `bot.battle`/`bot.pendingBattle`); **400** = bad body; **409** = no main lobby resolvable; **502** = container down or the bot refused (e.g. not connected), with `error` saying why. The response always carries `battle` (the resolved id) and `status` (the fresh status view). |

```bash
curl -s -XPOST https://lavabalance.fogofwar.dev/bot/start -H "authorization: Bearer $CONTROL_TOKEN"
curl -s https://lavabalance.fogofwar.dev/bot/status -H "authorization: Bearer $CONTROL_TOKEN" | jq
curl -s -XPOST https://lavabalance.fogofwar.dev/bot/stop  -H "authorization: Bearer $CONTROL_TOKEN"
```

**Keep-alive.** Nothing sends the container requests, so three things keep it
up: the persisted intent; the supervisor renewing the idle timer instead of
stopping; and the Worker's cron (`*/5 * * * *`) calling `ensureRunning()`,
which restarts the bot after any stop while the intent says "run" — a
deploy's image rollout, a crash, a platform restart. So after a deploy the bot
is back within 5 minutes (each deploy = one re-login); `pnpm run bot:kick`
(`POST /bot/restart`) bounces it sooner by hand.

**Auto-rejoin.** The bot goes back to its lobby on its own. The supervisor
persists the battle the bot was last in (`lastBattle`, learned from status
reads and `/bot/join`), and every container start resolves the rejoin target:
the **last battle** while Teiserver's index still lists it (an index failure
keeps it too — most recent knowledge), otherwise the **main lava lobby** (the
configured one, auto-picked when nothing is configured). The target is handed
to the process as `BOT_AUTOJOIN_ROOM`, which the bot joins after **every**
login — so restarts, redeploys and reconnects all land it back in a lobby.
Within one process life a reconnect prefers the battle it was actually in
(a `.join` mid-life beats the boot-time target), falling back to the boot-time
room once if that battle is gone.

**Idle lobby finder.** When the bot is logged in but in **no** battle (the
rejoin target was gone, the join failed, the lobby closed under it) the bot
process itself looks for one: once a minute it scrapes Teiserver's web lobby
index and joins the open lobby whose name contains **"lava"** and
**"unranked"** (case-insensitive), whose map is **Supreme Isthmus v2.1**, and
which has **8+ non-spectator players** — the one with the most players when
several qualify; locked/passworded lobbies are skipped. It does nothing while
the bot is in a battle or a join is pending, so `.join` / `/bot/join` are
never overridden. Needs the Teiserver web session (`BOT_TEISERVER_EMAIL`).
The rules live in `src/bot/idleLobby.ts`; the log line starts with `idle:`.

**Fatal exits.** The bot exits with code **42** (`FATAL_EXIT_CODE`) only for
things a restart can't fix: `DENIED` on login (wrong password / banned account)
or missing/invalid configuration. Only for that exact code does the supervisor
switch the intent OFF and record the reason in `lastError`, so a bad login
isn't retried every 5 minutes — fix the cause and `POST /bot/start` again. Any
OTHER exit (clean, crash, the platform's rollout SIGKILL) leaves the intent on
and the cron restarts the bot within 5 minutes.

## Environment variables

The Worker hands these to the container (`BotContainer.envVars`); the same
names go in `lavabalance/.env` for a local `pnpm run bot` (see `.env.example`).

| In the container | Set where (production) | Meaning |
|---|---|---|
| `BOT_LOGIN` | `vars.BOT_USERNAME` in `wrangler.jsonc` | The bot's **lobby account name** (the `LOGIN` user). Also the account that must be a lobby **boss** for `.balance` to work. |
| `BOT_PASSWORD` | **secret** `BOT_PASSWORD` (`wrangler secret put BOT_PASSWORD`) | That account's **plaintext** password. The bot md5-hashes it itself for the lobby `LOGIN` and uses it as-is for the Teiserver web login. Enter it interactively or with `printf '%s' 'pw' \| pnpm exec wrangler secret put BOT_PASSWORD` — a piped `echo` appends a newline (the bot strips a trailing one, but don't rely on it). NOT the md5 hash. |
| `BOT_ADMINS` | `vars.BOT_ADMINS` | Comma-separated account names allowed to whisper admin commands (`.join`, `.lavatoggle`, `.splitparties`), case-insensitive. Empty = admin commands disabled. |
| `BOT_AUTOJOIN_ROOM` | `vars.BOT_AUTOJOIN_ROOM` | Battle id to join after every login (so reconnects rejoin). In production the supervisor **overrides** this at every container start with the resolved rejoin target (last battle, else the main lava lobby — see "Auto-rejoin"); the static var is only the fallback when neither resolves. |
| `BOT_TEISERVER_EMAIL` | **secret** `TEISERVER_EMAIL` | Email of the same account, for the Teiserver **web** login (the background party scrape feeding `.balance`). Empty = skip the web login; `.balance` then runs without party data — as it also does in a lobby whose `balanceMode` is `skill`/`random`, where parties are ignored by design and the scrape is skipped. |
| `BOT_LAVAOS_URL` | `vars.BOT_LAVAOS_URL` (optional) | LOS lookup base URL; default `https://lavabalance.fogofwar.dev`. |
| `BOT_CONTROL_TOKEN` | `CONTROL_TOKEN` (secret, passed through by `BotContainer`) | Bearer token for the Worker's `/api/avoids/*` routes, which the `.avoid` whispers write through. Empty = the avoid routes are open (fine locally); in production it must match the Worker's `CONTROL_TOKEN` or every avoid command answers "unavailable right now". |
| `BOT_ACCESS_CLIENT_ID` · `BOT_ACCESS_CLIENT_SECRET` | `ACCESS_BOT_CLIENT_ID` · `ACCESS_BOT_CLIENT_SECRET` (secrets, passed through by `BotContainer`) | The Cloudflare Access **service token** the bot sends (`CF-Access-Client-Id`/`-Secret`) on `/api/bot/auth/issue|revoke` behind `.login`/`.logout`. Those routes are **never** open: without a valid token for the bot Access application (`ACCESS_BOT_AUD`) they answer 401 (503 when the Worker has no bot AUD), and `.login` says it is unavailable. |
| `BOT_SCOUT_URL` | — (local/stub only) | Base URL for `.scout`'s card lookup (the public `GET /api/scout?names=`). Defaults to the LOS base above. |
| `BOT_AUTH_URL` | — (local/stub only) | Base URL for the website-login calls (`.login`/`.logout`). Defaults to the LOS base above; the login link the bot whispers points at this host. |
| `BOT_UPLINK_URL` | — (local/stub only) | Base URL for the game-start uplink (`POST /api/gamestart|gameend` — the launch roster the lobby page freezes on while a game runs). Defaults to the LOS base above, so production needs nothing set. |
| `BOT_HEALTH_PORT` | `Dockerfile` (`8080`) | Port of the bot's `GET /health` JSON endpoint; the supervisor waits for it on start and reads it for `/bot/status`. Unset locally = no endpoint. |
| `BOT_HOST` / `BOT_PORT` | — (local/stub only) | Override the lobby server (default `server4.beyondallreason.info:8200`, plaintext). |
| `DEBUG` | `vars.DEBUG` (optional) | `"true"` traces every Teiserver web request (password redacted). |

Other secrets the **Worker** uses (not the bot): `CONTROL_TOKEN` (bearer for
`/bot/*`, `/admin/*`, `/battles/*`), `TEISERVER_PASSWORD` (the Worker's own
`src=teiserver` scraper login), `BOT_PASSWORD_HASH` (`base64(md5(pw))`, only
for `tools/connect-test.ts`).

After changing `vars`, `pnpm run deploy`; after changing a secret, the running
container keeps its old environment until restarted (`/bot/stop` + `/bot/start`).

## SSH into the container

Access is authenticated against `containers[0].authorized_keys` in
`wrangler.jsonc` (**ssh-ed25519 keys only**, provisioned when an instance
starts — add the key, deploy, restart the bot).

```bash
pnpm exec wrangler containers list                    # → the container (application) id
pnpm exec wrangler containers instances <container id>  # → the running instance id
ssh -i ~/.ssh/cloudflare_containers \
  -o ProxyCommand="pnpm exec wrangler containers ssh --stdio %h" \
  cloudchamber@<instance id>
```

Run it from `lavabalance/` so `pnpm exec` finds the local wrangler. The plain
`pnpm exec wrangler containers ssh <instance id>` wrapper also works, but it spawns
its own `ssh` which only offers default identity files — a key with another
name must be `ssh-add`ed first. Failure modes: **400** = no matching key on
that instance (not deployed, or the instance predates the deploy);
**Permission denied (publickey)** = the key isn't being offered. SSH does not
wake a stopped instance.

The session lands in `/app` in bash (coloured prompt; `/bin/sh` is a wrapper
that starts bash). Tools: `ps`, `less`, `vim`, `curl`. Aliases: `botlog`,
`cmdlog`, `bothealth`.

## Where the logs are

| What | Where | How to read |
|---|---|---|
| The bot process | PID 1, `tsx src/bot/bot.ts`, cwd `/app` | `ps aux` |
| Console output — status lines, chat, errors, the FATAL exit reason | `/app/bot_<YYYY-MM-DD>.log` (daily) **and** stdout, which the platform captures | in the instance: `botlog` (= `less +F /app/bot_*.log`); from outside: Cloudflare dashboard → Workers & Pages → lavabalance → **Logs** (container lines are interleaved with the Worker's). **Not** in `wrangler tail`, which shows only the Worker/DO side (`bot container: …` supervisor lines, cron runs). |
| Raw protocol, both directions (`→` sent / `←` received, LOGIN hash redacted) | `/app/commands_<YYYY-MM-DD>.log` (daily) — never on stdout | `cmdlog` (= `less +F /app/commands_*.log`) |
| The bot's own state | `GET /health` on port 8080 inside the instance | `bothealth`, or `GET /bot/status` from outside (`bot` field) |
| Supervisor diagnostics | DO storage, via `GET /bot/status` | `lastStop`, `lastError` |

The container's disk is ephemeral: both log files are gone after a restart.
The dashboard Logs view is the durable copy of stdout.

Locally (`pnpm run bot`) the same two files are written in `lavabalance/`
(gitignored via `*.log`).

## Chat commands

Whispered to the bot (or, where noted, said in the battle chat):

| Command | Who | What |
|---|---|---|
| `.help` | anyone (whisper) | a `--help`-style listing: what the bot is, a link to <https://lavabalance.fogofwar.dev/>, and every command the asker may use — the admin section only for admins. Said in the BATTLE chat it answers with a single line pointing at the whisper. |
| `.bot` | anyone (whisper or battle chat) | one line saying what the bot is — that it is a robot, that it splits the teams, and where the ranking lives (<https://lavabalance.fogofwar.dev/ranking>). Answered where it was asked, so in the BATTLE chat the whole lobby sees it — which is the point: this is the introduction, where `.help` is the command list and stays a whisper. **Worded differently every time**: `src/bot/blurb.ts` picks a prefix, a middle and a suffix from three lists of ten (1000 combinations) and appends the link. No lookup, no cooldown. |
| `.join <battleId>` | admins (whisper) | join that battle as a spectator, leaving the current one first |
| `.join me` | admins (whisper) | join the battle you are in (looked up on the public bar-rts battle list), same as `.join <that id>`; answers "you're not in any battle" otherwise |
| `.status` | anyone (whisper or battle chat; ≥ 6 players) | the lobby's players per team with their LOS, and the two-team matchup line (average LOS + win chance) — answered where it was asked, every time it is asked (the LOS lookup is cached, so a repeat is cheap). Also triggered automatically when anyone writes `!start` (or `!cv start`) in the battle chat, so the teams being voted on are announced — the automatic triggers share a 5 s cooldown so repeated votes/re-balances can't spam the lobby. When the matchup is more than 10 points off 50/50 and the only thing stopping the bot from fixing it is that it is **not a boss** (the lobby's autoBalance is off), the line ends with ` - I can't fix these teams, I'm not a boss here`. |
| `.balance` | battle chat: lobby **bosses** only, and the bot must be a boss too — refusals are announced in the chat with the reason; whispered: **everyone** (read-only preview, own 5s cooldown) | party-aware LOS balance, instant: the roster comes from the bot's own protocol tracking (no web wait). Party data comes from a **background** Teiserver scrape kicked off by every `.balance` and `.status` — so the first `.balance` in a lobby honours no parties, and later runs use the last scrape's result. **The lobby's own `balanceMode` decides whether parties count**: `clan;skill` (BAR's default, and what an un-broadcast mode is assumed to be) keeps party members on one team; `skill` — and `random`, which the bot balances on skill rather than rolling dice — balances every player individually and skips the party scrape entirely. **Party splitting**: even under `clan;skill`, when the best split that keeps the parties together still leaves one side's win chance above **75%** (stacked strong players in one party), the parties are given up and the lobby re-balanced individually as `skill` would — the announced matchup line then carries the suffix ` (too imbalanced -> ignoring parties)`. That rule can be turned off with `.splitparties off` (see below). The rating and the objective never change: it is always LOS. From **battle chat** it is LIVE: the whole arrangement is applied with ONE SPADS command — `!fb (a,b,c)(d,e,f)` (first group → team 1, second → team 2; players listed highest LOS first inside each group) sent privately to the host — and the matchup for that assignment (average LOS + win chance, straight from the balancer, oriented the way the `!fb` groups map onto team 1/2) is announced immediately, no wait or status fetch. **The lobby's own `autoBalance` must be `off`**: SPADS's `hForce` refuses manual teams otherwise ("Cannot force id/team, autoBalance is enabled"), so a live `.balance` is REFUSED with that reason instead of sending an `!fb` the host will throw away — a boss can `!set autoBalance off`. The tracked setting is only as fresh as the host's last broadcast, so a rejection can still slip through: the host's refusal PM is now read, **latched** (no further balancing in that lobby, announced once), and it drops the win-chance baseline the bot had just set on teams the lobby never got. The latch clears when a broadcast reports `autoBalance` back to `off`. **Whispered** it is a preview: the command is whispered back, nothing is sent — no boss requirement (it moves nobody), open to everyone behind its own 5s cooldown, which replies "try again in a few seconds" instead of ignoring silently; it runs whatever `autoBalance` says, prefixed with a `preview only — <reason>` line when forcing those teams would currently be refused. |
| `.avoid` · `.avoid <player>` · `.avoidremove <player>` | anyone (whisper only) | the asker's own **avoid list**: the people the balancer keeps them off a team with. Bare it lists the current entries and the syntax; with a name it adds them; `.avoidremove <player>` drops them. Every change (and every refusal) ends by showing the list again. The target must be someone the **ranking** has rated (an unknown name is refused with near misses), you cannot avoid yourself or add a duplicate, and a list holds **10** people. An avoid is honoured only while the split stays inside **40-60%** win chance — a lobby where keeping two people apart would skew the match is balanced as if nobody had asked. Said in the BATTLE chat, both commands answer with one line pointing at the whisper and show nobody's list: who avoids whom is never said out loud, and never appears in the announced matchup line either — it goes to the bot's log only. Admins can see the pairs for a lobby's roster on the lobby page in admin mode (signed in with Cloudflare Access). |
| `.scout <player>` | anyone (whisper or battle chat) | one line on **how that player plays**, from onetricklava's replay analysis: games parsed and win rate, archetypes (Economist, Frontliner, …), their two most-played Supreme Isthmus lanes with the share of games and their record on the main one, and the warning badges (💥 Comm bomber, 🪂 Comm drop possible, 🚶 Comm walker), plus a link to their player page (where the full Play-style card is). Answered where it was asked — in the battle chat everyone sees it (the battle form shares `.status`'s 5s cooldown). A player OTL has no card for, or whose profile is private, gets "no scouting card". The lookup is the public `GET /api/scout?names=`; a failure answers "unavailable right now". |
| `.login` · `.logout` (also bare `login` · `logout`, any case) | anyone (whisper only) | **Website login with the BAR account.** `.login` whispers back a one-time link to `https://lavabalance.fogofwar.dev/login?t=…` (single use, 5 minutes, only the latest link of an account works, one per 30 s); opening it and pressing **Continue** logs that browser in as the whispering account (keyed on its Teiserver account id, learned from the server's `ADDUSER` lines, so a rename does not move the login). `.logout` ends every website session of the account. Said in the battle chat, both answer with one line pointing at the whisper, since a link said out loud logs in whoever clicks it. The `/login` page explains these steps. Locally, `DEV_LOGIN=true` in `.dev.vars` adds a "log in as any player" box to `/login` (never deployed). |
| `.info` | anyone (whisper only) | everything the bot tracks: its own state, the battle, host settings — `autoBalance`, `balanceMode` with the party rule it implies ("parties kept together" / "parties ignored"), bosses, any vote in progress — the roster with decoded statuses |
| `.splitparties on\|off` | admins or bosses | whether `.balance` may **break up parties** when even the best split keeping them together leaves one side's win chance above 75% (the party-split rule in the `.balance` row above). **On by default**; `off` keeps parties together however imbalanced the lobby gets. Bare `.splitparties` reports the current state. A bot-level setting (not per-lobby), in memory only — a bot restart resets it to on. Answered where it was asked. |
| `.lavatoggle` | admins or bosses | flip the auto-balance flag by hand — answered where it was asked (whisper → whisper, battle chat → battle chat). Normally unneeded: the bot arms itself when the host's own `autoBalance` is `off` and balances once when the lobby reaches 16 players. |

Anything else whispered that starts with a `.` is answered — `unknown command: .foo — whisper .help for the list of commands`, or, for an admin command from a non-admin, `.join is an admin-only command — whisper .help for what you can use`. **A whisper that is not a command at all is answered too** — `sorry, I only understand commands — whisper .help for the list of them` — since saying nothing is what a broken bot does; at most once per sender per 5 minutes, and never to an autohost (a tracked battle's founder) or to the bot itself, so two bots cannot answer each other forever. In the BATTLE chat unknown commands stay silent (the lobby is shared; the bot does not argue with typos there).

The bot also reacts to one HOST announce on its own: the standard balance
summary (`* Balancing according to current balance mode: …`) — what anybody
typing `!balance` produces. What it does depends on who is balancing the lobby,
and either way it waits first, so SPADS's moves have landed:

- **the bot is the balancer** (its auto-balance flag is on — i.e. the lobby's own
  `autoBalance` is `off` — and nothing blocks its `!fb`): after 500 ms it runs its
  OWN `.balance`, live, so the game is played on the bot's split. Without this any
  player could overwrite the bot's teams just by typing `!balance`. The matchup
  line it announces carries the suffix ` (rebalanced after !balance)`.
- **the lobby balances itself** (`autoBalance` on, or the bot may not force teams):
  the bot is a bystander, so it only reports — a `.status` in the battle chat
  100 ms later, so the post-balance teams and win chance are visible at once. The
  automatic-trigger 5 s cooldown and the ≥ 6 players gate apply.

Both paths require the bot to be a boss, and the announce must really come from
the battle's founder.

### Friend requests (automatic)

The bot accepts every friend request sent to its account. On login it queries
the pending list (`FRIENDREQUESTLIST`) and accepts each entry — requests sent
while it was offline are picked up there — and while online it reacts to
Teiserver's `s.user.new_incoming_friend_request` push by re-querying the list
and accepting whatever it returns. Each accept is a status line in the bot's
log (`* accepting friend request from <name>`).

### LOS prefetch (automatic)

Ratings are fetched in the background as soon as a player appears in the
lobby's roster and remembered (including "not rated", with a 10-minute
background refresh) — so `.status`/`.balance` answer from the cache instead of
waiting on the LOS lookup. A command only waits when someone appears and types
within the same second.

### Start-vote guard (automatic)

SPADS launches a passed `!start` vote with whatever the teams look like at that
moment — players can jump teams mid-vote and nothing server-side stops them. So
while a **start vote** is in progress (tracked from the host's BarManager
announces), the bot watches the team composition; if anyone joins, leaves,
switches sides or goes player↔spectator, it cancels the vote with **`!ev`** and
announces why in the battle chat — but only when the change lands **within 15 s
of the last live `.balance`** (there has to be a fresh arrangement worth
protecting; a later change is accepted as the new baseline instead). Once per
vote; needs the bot to be a lobby boss (otherwise it only logs what it would
have done).

### Composition watcher (automatic rebalance)

The mirror-image hole: teams get shuffled **before** a vote (a strong player
leaves, a weaker one takes the slot) and the last announced 50/50 is fiction.
The bot remembers the team-1 win chance it last reported (any `.status`, or a
live `.balance`) and, whenever the team composition changes (debounced 100 ms
so a leave-and-refill burst is judged once, on the settled roster),
re-estimates the current win chance. Two things make it **rebalance the lobby**
(the same live path as a boss's `.balance`: one `!fb` command, the new matchup
announced tagged `(rebalanced after comp change)`, the balanced win chance the
new baseline):

- **degraded** — |win−50| grew by more than **10 points** since the baseline;
- **unfair** — |win−50| is over **20 points** right now, whatever the baseline
  says. The baseline follows what the bot last *reported*, and `.status` reports
  the lobby as it is: on 2026-09-07, 18 of 28 `.status` runs baselined the
  watcher on a lobby more than 10 points from even (13 of them more than 25 —
  2.7%, 94.9%, 97.9%). Once the baseline is 95% the degrade rule can never fire
  again, and **`.status` is auto-triggered by `!start`** — so calling a vote on a
  stacked lobby disarmed the watcher exactly when it mattered.

Smaller changes (or moves toward 50%) are silent and keep the old baseline, so
gradual drift still accumulates into one rebalance. Needs the bot to be a lobby
boss (otherwise it only logs, but still re-baselines).

Five gates keep it from firing on its own tail:

- **Full lobby only.** It acts at **exactly 16 players** and nowhere else. The
  win chance is an OpenSkill `predictWin` over *summed* ratings, so an 8v7 reads
  as a near-certain win on team size alone — every join and leave in a filling
  lobby would otherwise look like a catastrophic degrade. When someone leaves
  there is nothing to balance until the lobby refills.
- **`autoBalance` must be off.** SPADS throws away an `!fb` while its own
  autoBalance is enabled, so the bot does not send one (see `.balance` above).
- **Blackout.** A live `!fb` takes a few hundred ms to come back as
  `CLIENTBATTLESTATUS` lines, and SPADS applies it in several bursts; judging the
  lobby in that window measures a half-applied arrangement (~100%) and starts a
  second rebalance that fights the first. So a live `!fb` **silences the watcher
  until the lobby reaches the teams it asked for, or 3 s pass, whichever is
  first**. A composition change arriving during the blackout is **queued** and
  judged once, after it lifts.
- **Dead band.** Even a real degrade is only acted on if the balancer can do
  meaningfully better: an arrangement that would move team 1's win chance by
  **less than 1 percentage point** is not sent, and the lobby's own win chance
  becomes the new baseline instead.
- **Hold-off (30 s).** After a force that never landed, one that was blocked, or
  a dead-band skip, no automatic force — nor the log line explaining it — goes
  out for half a minute. A lobby too stacked for the balancer to fix stays over
  the absolute threshold, and a lobby whose `autoBalance` is left on is blocked
  for good; without this both would re-decide on every roster event.
- **No game running.** Mid-match roster churn is noise and an `!fb` would fight
  the live game.

A force that does **not** land — the blackout runs out and the lobby is not on
the teams it asked for — is treated as a failure: the win-chance baseline is
corrected to what the lobby **really is** (never the arrangement the bot only
asked for) and the hold-off starts.

### Payoff record

At every game start the bot snapshots the teams that actually launched, whether
they are the arrangement it last forced, and what it predicted; when the host
announces the result it writes one greppable line to `bot_<date>.log`:

```
* [payoff] battle 76: botTeams=yes players=16 (8v8) winner=team 2 predictedTeam1=49.8% predictionForWinner=50.2% (favourite won)
```

`botTeams` separates three cases — `yes`, `no`, and `never-forced` — so the
delivery question (are the bot's teams the ones that play?) stays apart from the
calibration one (how close are the games when they are?). `predictionForWinner`
is the probability the model gave the side that actually won; over many games its
mean should track how often the favourite wins.

## Deploying

```bash
pnpm exec wrangler secret put BOT_PASSWORD        # once (plaintext password of BOT_USERNAME)
pnpm exec wrangler secret put CONTROL_TOKEN       # optional
export CONTROL_TOKEN=...                    # bot:kick sends it as the bearer token
pnpm run deploy                              # Worker + builds/pushes the image (Docker running).
                                            # The rollout stops the instance; the cron's next
                                            # ensureRunning() (≤5 min) starts it on the new
                                            # image. Check /bot/status (or the /bot page).
```

The deploy script does not kick the bot: a kick right after `wrangler deploy`
races the rollout (`POST /bot/start` no-ops against the still-running
pre-rollout instance, and an immediate `POST /bot/restart` can start the OLD
image, which the rollout then kills again). Wait for the cron, or once the
rollout has settled run `pnpm run bot:kick` — it POSTs `/bot/restart` (bearer
`$CONTROL_TOKEN`, base URL overridable via `BOT_CONTROL_URL`, retrying up to
6 times 10 s apart) and also serves as the manual bounce without a deploy.

Without Docker: `pnpm exec wrangler deploy --containers-rollout=none` ships the Worker
only. Containers require the Workers Paid plan; a `lite` instance 24/7 costs
roughly $1.70/month on top of it.

## Running locally

```bash
cp .env.example .env    # BOT_LOGIN, BOT_PASSWORD, BOT_ADMINS, …
pnpm run bot             # same process as the container runs
```
