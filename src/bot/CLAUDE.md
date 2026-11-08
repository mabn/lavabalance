# src/bot — the lobby bot

## OVERVIEW
Plain Node lobby client (`bot.ts`, run via tsx) in a Cloudflare Container supervised by `src/botContainer.ts`; everything else here is pure or fetch-only helpers it wires up.

## WHERE TO LOOK
| Task | File | Note |
|---|---|---|
| Protocol loop, chat commands, live `!fb`, health port | `bot.ts` | ~3.2k lines; the only file excluded from tsconfig (`node:*`, no @types/node) |
| Composition watcher state machine | `compWatcher.ts` | `rebalanceVerdict`, `teamsLanded`; hooks in, no I/O. `test/compWatcher.test.ts` replays the 2026-09-07 storms |
| LOS cache age rule | `losCache.ts` | `namesToRefresh`; bot.ts keeps transport + prefetch |
| Host refusal of `!fb` | `forceRejection.ts` | `classifyForceRejection`: `autoBalance` latches, `autoBlockBalance`/unknown are transient |
| `[payoff]` log line | `payoff.ts` | `captureGameStart` / `describePayoff`; bot.ts owns the triggers |
| Idle bot picks a lobby | `idleLobby.ts` | name has "lava"+"unranked", map `IDLE_LOBBY_MAP`, 8+ players, not locked/passworded |
| `.join me` | `playerBattle.ts` | resolves the whisperer's battle from api.bar-rts.com/battles |
| `.bot` wording | `blurb.ts` | 3 independent lists of 10; every prefix must read before every middle |
| `.scout` | `scoutClient.ts` | public `GET /api/scout?names=` |
| `.avoid*` | `avoidClient.ts` | lists live in the Worker (container disk is ephemeral); 404/409 are values, rest throws |
| `.login` / `.logout` | `authClient.ts` | Access service-token headers; throws on non-2xx |
| Game start/end POSTs | `uplink.ts` | fire-and-forget, one retry after 5s, never throws |
| Teiserver web session | `teiserverWeb.ts` | shared with the Worker (`teiserverDO.ts` wraps it) |
| Supervisor, keep-alive, rejoin | `src/botContainer.ts`, `BOT.md` | env vars, `/bot/*`, logs, SSH |

Tests: `test/<module>.test.ts` for each extracted module (no test imports `bot.ts`).

## CONVENTIONS
- Only `bot.ts` may use `node:*`. Helpers stay runtime-agnostic (global `fetch`, injectable `fetchImpl`) — `teiserverWeb.ts` is also imported by the Worker.
- `bot.ts` opens a socket and starts timers at import, so nothing can import it. Put any logic worth testing in a pure module here and leave bot.ts only the wiring (the compWatcher/losCache/payoff/forceRejection pattern).
- Logging: `logEvent`/`status` emit ONE JSON line `{ts, level, msg, ...}`; `logError(context, e)` adds stack + the whole `cause` chain (Node's "fetch failed" hides the real reason there). The container log viewer splits on newlines.
- Raw protocol lines go only to `commands_<date>.log` (LOGIN hash redacted), never stdout; `console.*` is mirrored to `bot_<date>.log`.
- Internal errors are logged, never sent to players: the reply is a generic "`.cmd`: unavailable right now, try again later".
- Client modules throw; the command handler catches, `logError`s and answers generically (exception: `uplink.ts`, which must never throw).
- Exit code 42 (`FATAL_EXIT_CODE`) only for what a restart cannot fix (DENIED login, missing/invalid config); the supervisor turns the intent off on exactly that code. Any other exit gets restarted by the cron.

## ANTI-PATTERNS
- Never announce a live matchup before the teams land: `pendingAnnounce` waits for `onTeamsLanded`; refusal, blackout expiry (`onForceLost`) and a superseding force must each say so. Never baseline the watcher on asked-for teams (`bot.ts`, `compWatcher.ts`).
- Never send a live `!fb` without the gates: `balanceAllowed` (boss's `.balance`) / `botCanBalance` (automatic paths) → bot in a battle, bot is boss, `autoBalanceBlocksForce()` null (lobby autoBalance `off`, no latch). SPADS discards forces otherwise (`bot.ts`).
- Never latch on an unrecognized `Cannot force id/team` refusal; only the autoBalance one is indefinite (`forceRejection.ts`).
- Never compute a matchup from LOS older than `LOS_MAX_AGE_MS` = 15s; `cachedLos` refreshes inline. A failed refresh may fall back to the cached value; a never-resolved name must throw (`bot.ts`, `losCache.ts`).
- Don't let the watcher act outside exactly 16 players, during a game, in the 3s blackout, under the 1pp dead band or in the 30s hold-off (`compWatcher.ts`, `BOT.md`).
- Help/chat indentation uses U+2001 EM QUAD (`IND`), not spaces: BAR lobby chat collapses leading ASCII spaces (`bot.ts`).
- JOINBATTLE needs all 3 args (`<id> empty <scriptPassword>`); a bare `JOINBATTLE <id>` is silently dropped by Teiserver's regex.
- Never reply to the bot itself or to a tracked battle's founder (`isTrackedHost`): autohosts PM the bot, and two bots answering each other loop forever. Unknown-whisper replies are also limited to 1 per sender per 5 min.
- SPADS commands go via `spadsWire` (PM to the founder, SAYBATTLE fallback), never SAYBATTLEEX, which SPADS does not parse.
- Host-relayed chat (`SAIDBATTLE <founder> "<player> msg"`) is unwrapped only when the speaker really is the founder; host announces/refusals are founder-gated too.
- Strip trailing CR/LF from `BOT_LOGIN`/`BOT_PASSWORD`: a piped `wrangler secret put` stores the newline.
- Don't follow CLIENTSTATUS through `VOTE_GUARD_CMDS`: it is server-wide (~38% of traffic) and says nothing about teams.
- Who avoids whom is never said in battle chat or the matchup line; `.login` links are whisper-only.
