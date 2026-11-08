# lavabalance

A team-balancing bot and rating site for the **LAVA lobby** in
[Beyond All Reason](https://www.beyondallreason.info/) (BAR).

The bot sits in a BAR lobby as a spectator, rates every player with **LOS**, its
own OpenSkill rating built only from LAVA lobby games, and splits the lobby
into two even teams. The website at <https://lavabalance.fogofwar.dev> shows
the ranking, player pages, game history, live lobbies and polls.

## What it does

**In the lobby** (the bot, `src/bot/`):

- **Balances teams** when someone with boss rights types `.balance`. It keeps
  parties together unless that leaves one side over 75% to win, and honours
  players' avoid lists while the split stays within 40–60%. Teams are applied
  with a single SPADS `!fb` command.
- **Keeps the teams fair.** It rebalances when the lobby's composition shifts,
  cancels a `!start` vote if someone switches teams mid-vote, and answers
  `!balance` with its own split.
- **Reports the matchup** (`.status`): each team's average LOS and win chance,
  announced automatically when a start vote begins.
- **Chat commands** for everyone: `.help`, `.status`, `.scout <player>`
  (play-style card), `.avoid`, `.login` (website login with your BAR account),
  plus admin commands such as `.join`.
- **Finds a lobby on its own** when it isn't in one, and rejoins after
  restarts.

**On the website** (`src/ui.ts`, served by the Worker):

- **Ranking** with rank tiers (Bronze to Diamond). Exact LOS values are shown
  only to admins.
- **Player pages**: rating history, games played and a play-style scouting
  card.
- **Game pages** with the rosters at game start and the rating changes.
- **Live lobby view** with each team's predicted win chance.
- **Polls** that you vote in with your BAR account.

## How LOS works

LOS is [OpenSkill](https://openskill.me/) (Plackett-Luce), using a port of
BAR's own rating algorithm, run over every LAVA lobby game in order. A game
counts as a LAVA game when its tweakdefs match the LAVA lobby's tweak pack.
New players get a shrinking **rookie handicap** over their first 35 games, so
the balancer doesn't overrate them. Win chances come from a calibrated
predictor.

The details, including how the handicap and the predictor were fitted, are in
[`src/lavaos/CLAUDE.md`](./src/lavaos/CLAUDE.md) and the analyses under
[`docs/`](./docs).

## Architecture

```
                  ┌───────────────── Cloudflare Worker (src/index.ts, Hono) ──────────────────┐
browser ────────▶ │ website + JSON API                                                         │
                  │   LosDO          LOS store: games, players, ratings (SQLite)               │
                  │   RatingsDO      legacy cache of Lavabar ratings                           │
                  │   TeiserverDO    logged-in scraper of Teiserver's web lobby pages          │
                  │   Dispatcher     runtime config                                            │
                  │   BotContainer ──▶ Cloudflare Container running the bot (src/bot/bot.ts)  │
                  └───────────────────────────────────────────────────────────────┬───────────┘
                                                                                   │ Spring lobby
                                                                                   ▼ protocol (TCP)
                                                                      BAR's Teiserver lobby server
```

- **The bot** is a plain Node process (`src/bot/bot.ts`). It talks the Spring
  lobby protocol to Teiserver and calls the Worker's API for ratings, avoid
  lists and logins. In production it runs in a Cloudflare Container. The
  Worker's 5-minute cron keeps it running.
- **The Worker** serves the site and the API and holds all state in
  SQLite-backed Durable Objects.
- **Games** arrive through `POST /api/games`, which the replay viewer's sync
  calls. You can also backfill them with the `tools/lavaos` scripts.

## Repository layout

| Path | What's there |
|---|---|
| `src/index.ts` | Worker entry: routes, cron, Durable Object exports |
| `src/bot/` | The lobby bot (Node): chat commands, balancing, lobby finder |
| `src/balance/` | The team balancer (LOS, parties, avoid lists) |
| `src/lavaos/`, `src/los/` | LOS rating engine and its Durable Object and API |
| `src/protocol/` | Spring lobby protocol parsing and command builders |
| `src/ui.ts` | Server-rendered HTML pages |
| `public/` | Static assets (rank icons, poll images, reports) |
| `tools/` | CLIs: protocol connection test, replay scraping and upload, backfills, rating fits |
| `test/` | Vitest suites: Node unit tests and `*.workers.test.ts` run inside workerd |
| `docs/` | Protocol notes, data model, rating analyses |
| `BOT.md` | Operating manual: env vars, secrets, deploy, SSH, logs, every chat command |

## Getting started

You need Node 26 and pnpm 10. Running [mise](https://mise.jdx.dev/) installs
both from `mise.toml`.

```bash
pnpm install
pnpm run typecheck        # generates the Worker types (cf workers types), then tsc
pnpm test                 # unit tests + Durable Object tests in workerd
pnpm run dev              # cf dev: Worker + site on http://localhost:8787
```

`pnpm run dev` builds and runs the bot container too, which needs Docker;
`DEV_CONTAINERS=false pnpm run dev` runs everything but the bot.

For local development, put Worker settings in `.dev.vars` (gitignored):

```ini
ADMIN_OPEN=true           # admin UI without Cloudflare Access
DEV_LOGIN=true            # "log in as any player" on /login
```

To run the bot locally against the real BAR server, you need a BAR account
for it:

```bash
cp .env.example .env      # set BOT_LOGIN, BOT_PASSWORD, BOT_ADMINS, …
pnpm run bot
```

To check the lobby protocol without the bot, use
`pnpm run connect-test -- --help`.

## Configuration

The project is configured for Cloudflare's [`cf` CLI](https://developers.cloudflare.com/cf/)
in `cloudflare.config.ts` (bindings, Durable Objects, the bot container, cron,
custom domain), with the bundler's build and dev settings in
`wrangler.config.ts`. Non-secret settings are text bindings under
`worker.env` there: the bot account name, admin names, Cloudflare Access
domain and audiences, and enabled lobby sources. Secrets are set with
`pnpm exec wrangler secret put <NAME> --name lavabalance` (`cf` cannot set a
single secret yet):

| Secret | Used for |
|---|---|
| `BOT_PASSWORD` | The bot account's password (lobby login and Teiserver web login) |
| `TEISERVER_EMAIL` | Email of the bot account, for the Teiserver web login (Worker scraper and bot) |
| `TEISERVER_PASSWORD` | The Worker's own Teiserver web login for lobby scraping |
| `CONTROL_TOKEN` | Bearer token for `/bot/*`, `/admin/*` and the avoid-list API |
| `ACCESS_BOT_CLIENT_ID`, `ACCESS_BOT_CLIENT_SECRET` | Cloudflare Access service token the bot uses for `/api/bot/*` |
| `BOT_PASSWORD_HASH` | `base64(md5(password))`, only for `tools/connect-test.ts` |

Admin pages are protected by Cloudflare Access. [`BOT.md`](./BOT.md) has the
full list of variables.

## Deploying

The Worker and the bot's container image are deployed together. This needs
Docker and the Workers Paid plan for Containers.

```bash
pnpm run deploy           # Worker + bot container image
pnpm run bot:kick         # optional: restart the bot now instead of waiting for the cron
```

`pnpm exec cf deploy --containers-rollout none` deploys only the
Worker. The bot keeps running its old image. `cf` still builds the image for
that, so without Docker also set `BOT_IMAGE` to the image already deployed. See [`BOT.md`](./BOT.md#deploying)
for details.

## License

MIT, see [`LICENSE`](./LICENSE). The rank icons in `public/ranks/` are BAR
artwork by IceXuick, licensed CC BY-NC-ND (see
[`public/ranks/License.txt`](./public/ranks/License.txt)).
