// Standalone Node chat-logging bot for BAR's Teiserver (legacy Spring protocol).
// Runs in Node (NOT the Worker) — no Cloudflare, no Durable Objects. Run with:
// `pnpm run bot`. Credentials come from a `.env` file in the lavabalance/ directory:
//
//   BOT_LOGIN=mybot
//   BOT_PASSWORD=plaintext-password
//   BOT_ADMINS=name1,name2      # optional: accounts allowed to command the bot
//   BOT_AUTOJOIN_ROOM=42        # optional: battle id to join after every login
//   BOT_TEISERVER_EMAIL=...     # optional: web-API login email (password = BOT_PASSWORD);
//                               # unset/empty = skip the web login
//   BOT_HEALTH_PORT=8080        # optional: serve GET /health (JSON state) on this port —
//                               # set in the container image so the supervisor can probe it
//
// On startup it connects (plaintext TCP), logs in, and then listens: every chat
// message it receives (SAID / SAIDEX / SAIDPRIVATE / SAIDPRIVATEEX / SAIDBATTLE /
// SAIDBATTLEEX) is logged to stdout. It joins no channel on its own; the battle it
// joins is BOT_AUTOJOIN_ROOM after every login, and — whenever it finds itself in
// NO battle while logged in — an open lobby whose name contains "lava" and
// "unranked" on Supreme Isthmus v2.1 with 8+ players (idleLobbyTick, once a
// minute, via Teiserver's web lobby index; see src/bot/idleLobby.ts).
//
// Admin commands: accounts listed in BOT_ADMINS (comma-separated, case-insensitive)
// can whisper commands to the bot:
//
//   .join <battleID>   join that battle as a spectator (leaving the current one first)
//   .join me           join the battle the whisperer is in (same as .join <their battle>)
//
// Anyone can whisper `.status` (always answered), `.info` (a dump of everything
// the bot tracks about itself and the joined battle; whisper-only), `.avoid
// [player]` / `.avoidremove <player>` (their own avoid list — who the balancer
// should keep them off a team with; whisper-only, stored in the Worker),
// `.bot` (a one-line "what is this thing" with the ranking link, worded
// differently on every ask — said out loud when asked in the battle chat) and
// `.help` (a `--help`-style listing of the commands the asker may use; in battle
// chat it answers with a single line pointing at the whisper). Anything else
// starting with a `.` is answered too — an unknown
// command, or an admin command from a non-admin, is told so and pointed at
// `.help` rather than silently dropped.
//
// The bot replies to the admin over SAYPRIVATE with the outcome. Everything else
// stays passive: outbound traffic is LOGIN, PONG replies, a keepalive PING, and the
// join/leave/status/reply lines the command triggers. Reconnects with backoff if
// the connection drops; runs until killed (Ctrl-C).
//
// Two daily-rotated log files in the project dir (gitignored via *.log):
//   commands_<YYYY-MM-DD>.log  every raw protocol line, both directions (→/←),
//                              LOGIN hash redacted — ONLY here, never on stdout
//   bot_<YYYY-MM-DD>.log       everything console.log/error/warn prints (status,
//                              chat, errors — from this file AND the shared modules
//                              it imports); the same lines still go to stdout/stderr

import { connect as netConnect, type Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, parseArgs } from "node:util";

import { LOBBY_SERVER } from "../config";
import { botBlurb } from "./blurb";
import { CompositionWatcher, type WantedTeams } from "./compWatcher";
import { IDLE_LOBBY_MAP, IDLE_LOBBY_MIN_PLAYERS, pickIdleLobby } from "./idleLobby";
import { classifyForceRejection } from "./forceRejection";
import { LosCache, losKey } from "./losCache";
import { captureGameStart, describePayoff, type GameStart } from "./payoff";
import { LAUNCH_CONFIRM_MS, confirmLaunchRoster, type GameStartSnapshot } from "../gameStart";
import { createAuthClient } from "./authClient";
import { createAvoidClient } from "./avoidClient";
import { createUplink } from "./uplink";
import { createScoutClient } from "./scoutClient";
import { findPlayerBattle } from "./playerBattle";
import { scoutLine } from "../scout";
import {
  acceptFriendRequest,
  friendRequestList,
  joinBattle,
  leaveBattle,
  login,
  myBattleStatus,
  ping,
  pong,
  sayBattle,
  sayBattleEx,
  sayPrivate,
} from "../protocol/commands";
import { LineBuffer, parseMessage, type ParsedMessage } from "../protocol/framing";
import { DEFAULT_LOS_BASE, fetchLosPlayers, type LosPlayerInfo } from "../losLookup";
import {
  AVOID_WIN_MAX,
  AVOID_WIN_MIN,
  balanceTeams,
  balanceTeamsWithPartySplit,
  PARTY_SPLIT_MAX_WIN,
  ROOKIE_SPLIT_GAMES,
  ROOKIE_SPLIT_TOLERANCE,
  shownLos,
  teamsWinProb,
  UNRATED_LOS,
  type LosState,
} from "../balance/balancer";
import { balanceModeInfo, honoursParties } from "../balance/balanceMode";
import { MAX_AVOIDS_PER_PLAYER, type AvoidPair } from "../avoids";
import { parseLobbyIndex, parseLobbyShow } from "../teiserver";
import { SessionTracker, type TrackedPlayer } from "../tracker";
import { TeiserverWeb } from "./teiserverWeb";

// --- CLI flags ---

const { values: cli } = parseArgs({
  args: process.argv.slice(2),
  options: {
    host: { type: "string" }, // lobby server (default from config / BOT_HOST)
    port: { type: "string" }, // lobby port (default from config / BOT_PORT)
    help: { type: "boolean", default: false },
  },
});

if (cli.help) {
  console.log(`Usage: pnpm run bot -- [flags]

  --host <h>          lobby server (default ${LOBBY_SERVER.host}; env BOT_HOST)
  --port <n>          lobby port, plaintext (default ${LOBBY_SERVER.port}; env BOT_PORT)

Credentials and behavior come from .env — see .env.example.
`);
  process.exit(0);
}

// --- Credentials from .env (Node's built-in loader; no dotenv dependency) ---

const projectDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- Log files (set up FIRST, so even the credential errors below are captured) ---

/**
 * An append-only log file in the project dir, rotated daily by name
 * (`<prefix>_<YYYY-MM-DD>.log`). Writes are SYNCHRONOUS on purpose: the fatal
 * paths call `process.exit()` right after logging, and a buffered async stream
 * loses exactly those last lines (the DENIED reason, the FATAL notice). A few
 * lines per second is nothing for writeSync.
 */
class DailyLog {
  private day = "";
  private fd: number | null = null;
  constructor(private readonly prefix: string) {}
  write(text: string): void {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.day) {
      this.end();
      this.fd = openSync(join(projectDir, `${this.prefix}_${day}.log`), "a");
      this.day = day;
    }
    writeSync(this.fd!, text);
  }
  end(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

/** Raw protocol lines, both directions (→/←). Never on stdout. */
const commandsLog = new DailyLog("commands");
/** Everything console.* prints: status, chat, errors — mirrored from stdout/stderr. */
const botLog = new DailyLog("bot");

// Tee console.log/warn/error into bot_<day>.log. Patching the global console is
// what makes the shared modules' output (tracker.ts "[session] …", teiserverWeb's
// "→ teiserver …" tracing) land in the file too, not just this file's calls. The
// original methods still run, so stdout/stderr — what the container platform
// captures — is unchanged.
for (const level of ["log", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    botLog.write(format(...args) + "\n");
  };
}

try {
  process.loadEnvFile(join(projectDir, ".env"));
} catch {
  // No .env file — the vars may still be in the environment; checked below.
}

// Server: CLI flag > env override (stub testing) > the hard-coded default.
const host = cli.host || process.env.BOT_HOST || LOBBY_SERVER.host;
const port = Number(cli.port || process.env.BOT_PORT || LOBBY_SERVER.port);

/**
 * Exit code for conditions a restart CANNOT fix: login DENIED (wrong password /
 * banned account) or missing/invalid configuration. The container supervisor
 * (botContainer.ts, FATAL_EXIT_CODE there — keep them in sync) switches the
 * persisted "should run" intent off ONLY for this code, so a crash with any
 * other exit code (a bug, an OOM kill, a rollout SIGKILL) is restarted by the
 * cron as usual instead of leaving the bot dead until a manual /bot/start.
 */
const FATAL_EXIT_CODE = 42;

// Trailing CR/LF stripped: `echo pw | wrangler secret put` stores "pw\n", and a
// newline is never part of a real password — but it does earn a DENIED.
const username = (process.env.BOT_LOGIN ?? "").replace(/[\r\n]+$/, "");
const password = (process.env.BOT_PASSWORD ?? "").replace(/[\r\n]+$/, "");
if (!username || !password) {
  console.error("bot: BOT_LOGIN and BOT_PASSWORD are required (put them in lavabalance/.env)");
  process.exit(FATAL_EXIT_CODE);
}

// Admins allowed to command the bot over private messages: comma-separated account
// names in BOT_ADMINS, matched case-insensitively. Empty/unset = commands disabled.
const admins = new Set(
  (process.env.BOT_ADMINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

// Optional battle to join automatically after every login (initial and reconnects).
const autojoinRaw = process.env.BOT_AUTOJOIN_ROOM ?? "";
const autojoinRoom = autojoinRaw ? Number(autojoinRaw) : null;
if (autojoinRoom !== null && (!Number.isInteger(autojoinRoom) || autojoinRoom < 0)) {
  console.error(`bot: BOT_AUTOJOIN_ROOM must be an integer battle id, got "${autojoinRaw}"`);
  process.exit(FATAL_EXIT_CODE);
}

// LOS service base URL (the lookup the ratings come from). Override for stub
// tests / local dev with BOT_LAVAOS_URL.
const losBase = process.env.BOT_LAVAOS_URL || DEFAULT_LOS_BASE;

/** Resolve LOS for a set of lobby names, keyed lowercased. Throws on failure. */
const fetchLos = (names: string[]) =>
  fetchLosPlayers(losBase, names, {
    clientId: process.env.BOT_ACCESS_CLIENT_ID ?? "",
    clientSecret: process.env.BOT_ACCESS_CLIENT_SECRET ?? "",
  });

// Game-start uplink to the Worker (src/bot/uplink.ts): the launch roster and
// the game-over notice, so the lobby page can freeze the teams while the game
// runs. Same base as the LOS lookups (override both with BOT_UPLINK_URL /
// BOT_LAVAOS_URL for local dev). Fire-and-forget, never throws.
const uplink = createUplink(process.env.BOT_UPLINK_URL || losBase);

// Avoid lists (src/avoids.ts): stored in the Worker, read before every balance
// and written by the .avoid whispers. Same base as the LOS lookups; the control
// token (when the deployment sets one) is what lets this bot write somebody's
// list — see src/bot/avoidClient.ts.
const avoidClient = createAvoidClient(process.env.BOT_AVOIDS_URL || losBase, {
  token: process.env.BOT_CONTROL_TOKEN ?? "",
});

// Website login (src/auth.ts): `.login` asks the Worker for a one-time link for
// the whispering account and whispers it back; `.logout` ends every website
// session of that account. Same base as the avoid client; the routes sit behind
// Cloudflare Access (/api/bot/*), so the bot sends its Access service token —
// the Worker refuses these without it, since the bot is what vouches for who
// is asking.
// OneTrickLava's play-style cards (src/scout.ts), read from the Worker's PUBLIC
// /api/scout route — behind `.scout <player>`. BOT_SCOUT_URL overrides for dev.
const scoutClient = createScoutClient(process.env.BOT_SCOUT_URL || losBase);
const authClient = createAuthClient(process.env.BOT_AUTH_URL || losBase, {
  accessClientId: process.env.BOT_ACCESS_CLIENT_ID ?? "",
  accessClientSecret: process.env.BOT_ACCESS_CLIENT_SECRET ?? "",
});

/**
 * Teiserver account ids by lowercased name, from the server's ADDUSER lines
 * (`ADDUSER <name> <country> <accountid> <lobby_client>` — one per online user
 * after login, then one per user who logs in). A website login is keyed on the
 * id, not the name, because names can be changed; it is the same id LOS keys
 * players by.
 */
const accountIds = new Map<string, number>();

function noteAddUser(m: ParsedMessage): void {
  const name = m.words[0];
  const id = Number(m.words[2]);
  if (name && Number.isSafeInteger(id) && id > 0) accountIds.set(name.toLowerCase(), id);
}

// --- LOS cache (prefetched so commands don't wait on the lookup) ---
//
// Every command used to pay one LOS HTTP round-trip. Now ratings are prefetched
// the moment a player shows up in the joined battle's roster (JOINEDBATTLE /
// CLIENTBATTLESTATUS lines schedule a debounced background fetch of any
// uncached names) and remembered — including the "not rated" answer, so an
// unknown player is a cache HIT (null), not a re-fetch. Entries are global (a
// rating isn't per-battle) and kept warm in the background once older than
// LOS_CACHE_TTL_MS.
//
// BUT A MATCHUP IS NEVER COMPUTED FROM A CACHE ENTRY OLDER THAN LOS_MAX_AGE_MS.
// The cache used to serve any age it had, which is wrong the moment the lobby
// finishes a game: every player who just played has a NEW rating, and the lobby
// re-forms with the same people. 2026-09-07 23:59 is the case — the 23:41 game
// was ingested at 23:59:07, and the `.balance` 34s later ran on the ratings from
// before it. It rebuilt essentially the losing and winning sides, announced
// "26.8 (50.0% win) vs 26.7 (50.0% win)", and the website — reading the same
// store, but current — showed those very teams as 26.3 (38.3%) vs 27.2 (61.7%).
// The game launched that way.
//
// Invalidating when a game ENDS does not fix it: the store learns a game from a
// scraped replay minutes later (23:55:24 end → 23:59:07 upload), so a refetch at
// the whistle re-caches the same pre-game numbers. A short maximum age does fix
// it, whenever the upload lands. The cost is one ≤16-name lookup per 15s on the
// paths that decide or report a matchup, which is what those paths are for.

/** Keep a cached rating warm (in the background) once it's this old. */
const LOS_CACHE_TTL_MS = 10 * 60_000;
/** Refresh INLINE before deciding or reporting a matchup on a rating this old. */
const LOS_MAX_AGE_MS = 15_000;
/** Coalesce the roster-line bursts (joining a lobby = 16+ status lines). */
const LOS_PREFETCH_DEBOUNCE_MS = 1_000;
/** Prune the cache down when it grows past this many entries. */
const LOS_CACHE_MAX = 1_000;

/** name (lowercased) → looked-up rating (null = LOS doesn't rate them) + when. */
const losCache = new LosCache<LosPlayerInfo>(LOS_CACHE_MAX);

let losPrefetchTimer: NodeJS.Timeout | null = null;
let losPrefetchInFlight = false;
let losPrefetchAgain = false;

/** Store one bulk-lookup result for `names`. */
function rememberLos(names: string[], ratings: Record<string, LosPlayerInfo>): void {
  losCache.remember(names, (n) => losOfName(ratings, n));
}

/** Background prefetch of missing/stale ratings for the whole tracked roster. */
function prefetchLosNow(): void {
  if (losPrefetchInFlight) {
    losPrefetchAgain = true; // more roster lines arrived mid-fetch: go again
    return;
  }
  const roster = joinedBattleId !== null ? tracker.roster(joinedBattleId) : null;
  const missing = losCache.namesToRefresh(roster?.map((p) => p.name) ?? [], LOS_CACHE_TTL_MS);
  if (!missing.length) return;
  losPrefetchInFlight = true;
  (async () => {
    rememberLos(missing, await fetchLos(missing));
    status(`LOS prefetched for ${missing.length} player${missing.length === 1 ? "" : "s"}`);
  })()
    .catch((e) => logError("LOS prefetch failed", e))
    .finally(() => {
      losPrefetchInFlight = false;
      if (losPrefetchAgain) {
        losPrefetchAgain = false;
        prefetchLosNow();
      }
    });
}

/** Debounced trigger, called on every roster-relevant protocol line. */
function scheduleLosPrefetch(): void {
  if (losPrefetchTimer) return;
  losPrefetchTimer = setTimeout(() => {
    losPrefetchTimer = null;
    prefetchLosNow();
  }, LOS_PREFETCH_DEBOUNCE_MS);
}

/**
 * Cache-first LOS lookup, same result shape as `fetchLos`. Names with no cache
 * entry at all, and entries older than `maxAgeMs`, are fetched INLINE; the rest
 * are served from the cache, so a warm roster costs nothing between refreshes.
 *
 * A failed refresh is survivable and does NOT fail the command: the cache still
 * holds the last ratings we resolved, and an old number beats no answer. A name
 * we have never resolved at all is different — the caller would silently balance
 * on a phantom debutant — so that still throws, as it always did.
 */
async function cachedLos(
  names: string[],
  maxAgeMs = LOS_MAX_AGE_MS,
): Promise<Record<string, LosPlayerInfo>> {
  const refresh = losCache.namesToRefresh(names, maxAgeMs);
  if (refresh.length) {
    const unknown = refresh.filter((n) => !losCache.has(n));
    status(
      `LOS lookup for ${refresh.length} player${refresh.length === 1 ? "" : "s"}` +
        (unknown.length ? ` (${unknown.length} never seen)` : " (refresh)"),
    );
    try {
      rememberLos(refresh, await fetchLos(refresh));
    } catch (e) {
      if (unknown.length) throw e;
      logError("LOS refresh failed — answering from the cache", e);
    }
  } else {
    scheduleLosPrefetch(); // keep the rest of the roster warm, off the hot path
  }
  const out: Record<string, LosPlayerInfo> = {};
  for (const n of names) {
    const info = losCache.get(n);
    if (info) out[losKey(n)] = info;
  }
  return out;
}

/** Case-insensitive accessor into a LOS lookup result. */
const losOfName = (
  ratings: Record<string, LosPlayerInfo>,
  name: string,
): LosPlayerInfo | undefined => ratings[name.trim().toLowerCase()];

// Teiserver's md5 login path expects base64(md5(password)).
const passwordHash = createHash("md5").update(password, "utf8").digest("base64");

// The lobby_hash field is a device fingerprint "<hash> <hash>" (Teiserver rejects a
// bare "0"; it's only used for smurf grouping). Same derivation as connect-test.ts.
const md5hex = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const lobbyHash = `${md5hex(username)} ${md5hex(username + "|sys").slice(0, 16)}`;

// Script password sent with JOINBATTLE: identifies us to the host when the game
// launches. Random per process; a decimal number, mirroring observed client traffic
// (e.g. "JOINBATTLE 837 empty 1824552624").
const scriptPassword = String(randomBytes(4).readUInt32BE(0));

// The Teiserver web (HTTP) session, logged into after the lobby login. Held purely in
// memory — a restart just logs in again. Uses the same BOT_PASSWORD as the lobby
// login (the web form wants it plaintext) with the account email from
// BOT_TEISERVER_EMAIL (in production the Worker's TEISERVER_EMAIL secret); unset or
// empty skips the web login.
const teiserverEmail = process.env.BOT_TEISERVER_EMAIL ?? "";
const teiserverWeb = teiserverEmail
  ? new TeiserverWeb(() => ({
      email: teiserverEmail,
      password,
      debug: process.env.DEBUG === "true",
      base: process.env.BOT_TEISERVER_BASE || undefined, // stub-test override
    }))
  : null;

function webLogin(): void {
  if (!teiserverWeb) {
    status("teiserver web login skipped (BOT_TEISERVER_EMAIL is empty)");
    return;
  }
  if (teiserverWeb.hasSession()) return;
  teiserverWeb
    .ensureLogin()
    .then(() => status("teiserver web login OK"))
    .catch((e) => logError("teiserver web login failed", e));
}

// --- Logging ---

const stamp = () => new Date().toISOString();

/**
 * One log event as ONE JSON line: `{ts, level, msg, ...fields}`. The container
 * platform's log viewer (Cloudflare) splits stdout on newlines and parses a
 * JSON line into fields, so an event is one searchable entry, not a stack trace
 * smeared over a dozen "info" rows.
 */
function logEvent(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: stamp(), level, msg, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

const status = (msg: string) => logEvent("info", msg);

/** An Error (and its own enumerable props, e.g. a fetch error's `code`) as plain fields. */
function errorFields(e: unknown): Record<string, unknown> {
  if (!(e instanceof Error)) return { message: typeof e === "object" ? JSON.stringify(e) : String(e) };
  const props = Object.fromEntries(
    Object.entries(e).filter(([k]) => k !== "cause" && k !== "stack" && k !== "message"),
  );
  return { name: e.name, message: e.message, stack: e.stack, ...(Object.keys(props).length ? { props } : {}) };
}

/**
 * Log an internal failure with everything needed to diagnose it, as ONE
 * structured event: the message, the stack trace, and the whole `cause` chain
 * (Node's fetch reports a bare "fetch failed" TypeError whose real reason —
 * ECONNREFUSED, ENOTFOUND, a TLS error — only lives in `error.cause`).
 * Internal errors are ONLY ever logged here; they must never be relayed to
 * players (see the command handlers).
 */
function logError(context: string, e: unknown): void {
  const causes: Record<string, unknown>[] = [];
  let cur: unknown = e instanceof Error ? e.cause : undefined;
  while (cur !== undefined && cur !== null && causes.length < 10) {
    causes.push(errorFields(cur));
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  logEvent("error", context, {
    error: e instanceof Error ? e.message : String(e),
    err: errorFields(e),
    ...(causes.length ? { causes } : {}),
  });
}

/** Every raw protocol line, both directions — commands_<day>.log ONLY (see DailyLog). */
function fileLog(dir: "→" | "←", line: string): void {
  commandsLog.write(`${stamp()} ${dir} ${line}\n`);
}
const chat = (kind: string, from: string, message: string, where?: string) =>
  console.log(`${stamp()} [${kind}${where ? ` ${where}` : ""}] <${from}> ${message}`);

// --- Chat parsing ---

// Rebuild a message's trailing free text: the words after the fixed args rejoined
// by space, plus any tab-separated sentences (the framing split on the first TAB).
function trailingText(m: ParsedMessage, fixedArgs: number): string {
  let text = m.words.slice(fixedArgs).join(" ");
  if (m.sentences.length) text += (text ? "\t" : "") + m.sentences.join("\t");
  return text;
}

// SAID / SAIDEX:            <channel> <user> {message}
// SAIDPRIVATE(EX)/BATTLE(EX): <user> {message}
function handleChat(m: ParsedMessage): boolean {
  switch (m.cmd) {
    case "SAID":
    case "SAIDEX":
      chat(m.cmd, m.words[1] ?? "?", trailingText(m, 2), `#${m.words[0] ?? "?"}`);
      return true;
    case "SAIDPRIVATE": {
      const from = m.words[0] ?? "?";
      const text = trailingText(m, 1);
      chat(m.cmd, from, text);
      handleHostForceRejection(from, text);
      handleCommand(from, text);
      return true;
    }
    case "SAIDBATTLE": {
      const from = m.words[0] ?? "?";
      const text = trailingText(m, 1);
      chat(m.cmd, from, text);
      handleBattleCommand(from, text);
      return true;
    }
    case "SAIDPRIVATEEX":
    case "SAIDBATTLEEX": {
      const from = m.words[0] ?? "?";
      const text = trailingText(m, 1);
      chat(m.cmd, from, text);
      if (m.cmd === "SAIDBATTLEEX") {
        handleHostBalanceAnnounce(from, text);
        handleHostSettingAnnounce(from, text);
        handleGameResult(from, text);
      }
      return true;
    }
    default:
      return false;
  }
}

// --- Admin commands (whispered to the bot) ---

// Battle membership, driven by the server's replies: the id we're waiting on after
// sending JOINBATTLE, and the id we're actually in (JOINBATTLE reply .. LEFTBATTLE).
let pendingBattleId: number | null = null;
let pendingRequester: string | null = null;
let joinedBattleId: number | null = null;
/**
 * The last battle we successfully joined in THIS process — unlike joinedBattleId
 * it survives a disconnect, so a reconnect rejoins where we actually were (a .join
 * mid-life beats the boot-time BOT_AUTOJOIN_ROOM). Across container restarts the
 * supervisor persists the equivalent and resolves BOT_AUTOJOIN_ROOM from it.
 */
let lastJoinedBattleId: number | null = null;

// Join a battle (leaving the current one first); requester gets the outcome
// whispered back, null for automatic joins.
function requestJoin(id: number, requester: string | null): void {
  if (joinedBattleId === id) return;
  if (joinedBattleId !== null) {
    // One battle at a time: leave the current one first.
    restoreAutoBlockBalance("leaving this lobby");
    status(`leaving battle ${joinedBattleId} to join ${id}`);
    send(leaveBattle());
    joinedBattleId = null;
  }
  pendingBattleId = id;
  pendingRequester = requester;
  send(joinBattle(id, "empty", scriptPassword));
}

/**
 * The battle we're in (or joining) no longer exists. The bot only cleared its
 * battle on its own LEFTBATTLE, and a closed lobby is announced with BATTLECLOSED,
 * which the bot ignored — so it kept the dead id as its battle forever (2026-10-23: /health said battle
 * 2167 for two days after that lobby closed). Forget it (including the rejoin
 * target, so a reconnect doesn't retry it) and fall back to the boot-time room
 * (BOT_AUTOJOIN_ROOM, the main lobby when the supervisor resolved one); with no
 * other room, the idle lobby finder takes over on its next tick.
 */
function battleGone(id: number, why: string): void {
  if (joinedBattleId !== id && pendingBattleId !== id) return;
  status(`battle ${id} is gone (${why})`);
  if (joinedBattleId === id) {
    // Harmless if the server already dropped us; clears our side if it didn't.
    send(leaveBattle());
    joinedBattleId = null;
    resetBalanceState();
  }
  if (pendingBattleId === id) {
    if (pendingRequester) send(sayPrivate(pendingRequester, `battle ${id} is gone`));
    pendingBattleId = null;
    pendingRequester = null;
  }
  if (lastJoinedBattleId === id) lastJoinedBattleId = null;
  missingFromIndex = 0;
  if (autojoinRoom !== null && autojoinRoom !== id && loggedIn) {
    status(`falling back to battle ${autojoinRoom} (BOT_AUTOJOIN_ROOM)`);
    requestJoin(autojoinRoom, null);
  }
}

/** Min interval between AUTOMATIC .status runs (host balance, !start votes);
 * auto triggers inside the window are silently ignored. A .status somebody
 * actually typed always answers — the LOS lookup is cached, so a repeat is
 * cheap, and a silent bot reads as a broken one. */
const STATUS_COOLDOWN_MS = 5_000;
let lastStatusRun = 0;
/** Last whispered .balance preview (its own window, apart from .status). */
let lastBalancePreviewRun = 0;

/**
 * `.status` is ignored below this many players — a near-empty lobby has nothing
 * worth reporting (and nothing worth a ratings lookup).
 */
const MIN_PLAYERS_FOR_REPORT = 6;

/** Whether the lobby has enough players to report on; logs the reason if not. */
function enoughPlayersToReport(cmd: string, from: string): boolean {
  const count = lobbyPlayers().length;
  if (count >= MIN_PLAYERS_FOR_REPORT) return true;
  status(`ignoring ${cmd} from ${from} (${count} players, need ${MIN_PLAYERS_FOR_REPORT})`);
  return false;
}

/**
 * Run .status if the lobby is big enough. Only AUTOMATIC triggers honour the
 * global cooldown; a .status a person typed always answers (every run still
 * stamps `lastStatusRun`, so an auto report right after a manual ask rests).
 */
async function tryRunStatus(
  from: string,
  reply: (msg: string) => void,
  opts: { auto?: boolean } = {},
): Promise<void> {
  // Let queued protocol lines apply first so the player count is current.
  await trackerQueue;
  if (!enoughPlayersToReport(".status", from)) return;
  const now = Date.now();
  if (opts.auto && now - lastStatusRun < STATUS_COOLDOWN_MS) {
    status(`ignoring auto .status (${from}) (cooldown)`);
    return;
  }
  lastStatusRun = now;
  await runStatus(reply);
}

/**
 * The host's STANDARD balance summary announce (SPADS balancing the lobby itself,
 * not our balancer), e.g.:
 *   "* Balancing according to current balance mode: clan;skill (balance deviation: 3%)"
 */
const HOST_BALANCE_ANNOUNCE_PREFIX = "* Balancing according to current balance mode";
/** Beat between the host's balance announce and the automatic .status report. */
const HOST_BALANCE_STATUS_DELAY_MS = 100;
/**
 * Beat between the host's balance announce and the bot's OWN rebalance — long
 * enough for SPADS's shuffle to land as CLIENTBATTLESTATUS lines, so our balance
 * reads the teams the lobby really has (and `orientTeams` picks the orientation
 * that moves the fewest players from there).
 */
const HOST_BALANCE_REBALANCE_DELAY_MS = 500;
/** Tag on the matchup line of a rebalance somebody's `!balance` triggered. */
const HOST_BALANCE_SUFFIX = " (rebalanced after !balance)";

/**
 * When the HOST announces it just balanced the lobby (its standard balance summary
 * line — what anybody typing `!balance` produces), the bot answers a beat later.
 * WHAT it answers depends on who the lobby's balancer is:
 *
 *   the BOT is balancing this lobby (our arming flag is on — i.e. the lobby's own
 *     autoBalance is off — and nothing blocks our `!fb`) → run OUR balance, so the
 *     game is played on the bot's split rather than SPADS's. Otherwise any player
 *     could overwrite the bot's teams just by typing `!balance`. The matchup line
 *     it announces is tagged HOST_BALANCE_SUFFIX so the lobby can see why the
 *     teams moved again.
 *   the LOBBY balances itself (autoBalance on, or the bot may not force teams) →
 *     the bot is a bystander, so it only REPORTS: a `.status` in the battle chat.
 *
 * Either way the delay lets the CLIENTBATTLESTATUS updates from SPADS's shuffle
 * land first, so the bot works from the post-balance teams. Only when the bot is a
 * boss (the answer is a SAYBATTLEEX announce — a non-boss bot shouldn't speak up
 * uninvited). Gated on the speaker really being the battle's founder, and the
 * status path shares `.status`'s player minimum and global cooldown (tryRunStatus),
 * so repeated re-balances can't spam the lobby.
 */
function handleHostBalanceAnnounce(from: string, text: string): void {
  if (from.toLowerCase() === username.toLowerCase()) return;
  if (!text.startsWith(HOST_BALANCE_ANNOUNCE_PREFIX)) return;
  if (!isFounder(from)) return;
  if (!isBoss(username)) {
    status(`host balanced — not reporting status (the bot is not a boss)`);
    return;
  }
  if (autoBalance && botCanBalance("host balanced — not rebalancing")) {
    status(`host balanced — rebalancing in ${HOST_BALANCE_REBALANCE_DELAY_MS}ms`);
    setTimeout(() => {
      // Re-check: the delay is long enough for the lobby to have changed under us
      // (a boss turning autoBalance on, the bot losing boss, leaving the battle).
      if (!botCanBalance("host balance rebalance skipped")) return;
      // A live `!fb` of ours is still in flight — the composition watcher can have
      // reacted to SPADS's shuffle before this timer. Balancing on half-applied
      // teams is what makes two forces duel each other; that force is the bot's
      // split already, so let it land.
      if (pendingAnnounce !== null) {
        status("host balance rebalance skipped (our own force is still in flight)");
        return;
      }
      void runBalance(battleReply, true, { summarySuffix: HOST_BALANCE_SUFFIX });
    }, HOST_BALANCE_REBALANCE_DELAY_MS);
    return;
  }
  status(`host balanced — auto .status in ${HOST_BALANCE_STATUS_DELAY_MS}ms`);
  setTimeout(
    () => void tryRunStatus(`${from} (host balance)`, battleReply, { auto: true }),
    HOST_BALANCE_STATUS_DELAY_MS,
  );
}

/** Whispered commands only accounts in BOT_ADMINS may run. */
const ADMIN_COMMANDS = new Set([".join", ".lavatoggle", ".splitparties"]);

/**
 * `.splitparties on|off` — enable/disable the party-split rule (see the
 * `splitParties` flag). Bare `.splitparties` reports the current state, so the
 * setting can be checked without changing it. Answered where it was asked.
 */
function handleSplitParties(arg: string | undefined, reply: (msg: string) => void): void {
  if (arg === "on" || arg === "off") {
    splitParties = arg === "on";
    reply(
      splitParties
        ? `party splitting is now on — parties are broken up when keeping them together ` +
            `leaves a side above ${(PARTY_SPLIT_MAX_WIN * 100).toFixed(0)}% win chance`
        : "party splitting is now off — parties are always kept together, however imbalanced",
    );
    return;
  }
  if (arg === undefined) {
    reply(`party splitting is ${splitParties ? "on" : "off"} — .splitparties on|off to change`);
    return;
  }
  reply("usage: .splitparties on|off");
}

function handleCommand(from: string, text: string): void {
  const words = text.trim().split(/\s+/);
  const reply = (msg: string) => send(sayPrivate(from, msg));
  // Website login. WHISPER ONLY: the link logs in whoever opens it, so it goes to
  // the account that asked and nowhere else — the whispering account being the
  // proof of who that is. Open to everyone.
  // Accepted with or without the dot ("login" is what the /login page tells
  // people to send), in any case.
  const loginCmd = (words[0] ?? "").toLowerCase().replace(/^\./, "");
  if ((words.length === 1 || words[0]!.startsWith(".")) && (loginCmd === "login" || loginCmd === "logout")) {
    void handleLoginCommand(from, "." + loginCmd, reply);
    return;
  }
  // A whisper that is not a command at all still gets an answer: silence reads
  // as a broken bot, and somebody typing "can you balance?" has no way to learn
  // that there is a command for it.
  if (!(words[0] ?? "").startsWith(".")) {
    answerUnknownWhisper(from, text, reply);
    return;
  }
  // .status is open to EVERYONE and always answers when asked directly — the
  // LOS lookup is cached, so a repeat costs nothing worth a silent ignore.
  if (words[0] === ".status") {
    void tryRunStatus(from, reply);
    return;
  }
  // .info is WHISPER-ONLY (handleBattleCommand doesn't know it): a read-only dump
  // of everything the bot tracks, whispered back. No lookups, so no cooldown.
  if (words[0] === ".info") {
    printInfo(reply);
    return;
  }
  // .balance whispered is a read-only PREVIEW: the !fb is whispered back, nothing
  // reaches the host — so like .status it is open to EVERYONE, and the boss checks
  // (balanceAllowed) gate only the battle-chat form, which really moves players.
  // A cooldown caps the LOS lookup + party scrape it costs; the throttled asker
  // is told, so a whisper never goes silently dead.
  if (words[0] === ".balance") {
    const now = Date.now();
    if (now - lastBalancePreviewRun < STATUS_COOLDOWN_MS) {
      reply(".balance: just ran — try again in a few seconds");
      return;
    }
    lastBalancePreviewRun = now;
    void runBalance(reply, false);
    return;
  }
  // The avoid list (src/avoids.ts). WHISPER ONLY: a list is between the player
  // and the bot, and the battle-chat form (handleBattleCommand) only points
  // back here. Open to everyone — each asker edits their OWN list, the
  // whispering account being the only proof of who that is.
  if (AVOID_COMMANDS.has(words[0] ?? "")) {
    void handleAvoidCommand(from, words, reply);
    return;
  }
  // .bot is the self-introduction (src/bot/blurb.ts — assembled from three lists,
  // so asking twice answers twice differently), open to EVERYONE and answered
  // where it was asked. No lookup, so no cooldown and nothing to throttle.
  if (words[0] === ".bot") {
    reply(botBlurb());
    return;
  }
  // .scout <player> — how someone plays, from OneTrickLava's replay analysis.
  // Open to everyone, answered where it was asked; one cached public read.
  if (words[0] === ".scout") {
    void handleScoutCommand(words.slice(1).join(" "), reply);
    return;
  }
  // .help is open to EVERYONE and lists exactly what the asker may use (the admin
  // section only for admins).
  if (words[0] === ".help") {
    printHelp(reply, admins.has(from.toLowerCase()));
    return;
  }
  // Everything below is admin-only. A non-admin is TOLD so and an unknown command
  // is answered at all — a bot that silently drops what you typed reads as broken.
  if (!ADMIN_COMMANDS.has(words[0] ?? "")) {
    reply(`unknown command: ${words[0]} — whisper .help for the list of commands`);
    return;
  }
  if (!admins.has(from.toLowerCase())) {
    status(`ignoring admin command from non-admin ${from}: ${text}`);
    reply(`${words[0]} is an admin-only command — whisper .help for what you can use`);
    return;
  }
  switch (words[0]) {
    case ".join": {
      // `.join me` = the battle the whisperer is in, resolved from the public
      // battle list, then exactly the `.join <id>` path.
      if (words[1]?.toLowerCase() === "me") {
        void findPlayerBattle(from)
          .then((id) => {
            if (id === null) {
              reply("you're not in any battle");
              return;
            }
            requestJoin(id, from);
            reply(`joining battle ${id}`);
          })
          .catch((e) => {
            logError(".join me: battle lookup failed", e);
            reply(".join me: couldn't look up your battle right now, try .join <battleID>");
          });
        return;
      }
      const id = Number(words[1]);
      if (!words[1] || !Number.isInteger(id) || id < 0) {
        reply("usage: .join <battleID> | .join me");
        return;
      }
      requestJoin(id, from);
      reply(`joining battle ${id}`);
      break;
    }
    case ".lavatoggle":
      toggleAutoBalance(reply);
      break;
    case ".splitparties":
      handleSplitParties(words[1]?.toLowerCase(), reply);
      break;
  }
}

/**
 * How long a sender who whispered something unparseable is left alone after
 * being pointed at `.help`. They have the answer; repeating it every line would
 * be noise — and the lobby is full of other bots, so two of them answering each
 * other's "I didn't understand" must not become a conversation.
 */
const UNKNOWN_WHISPER_COOLDOWN_MS = 5 * 60_000;
/** Senders remembered for that window; the map is dropped wholesale past this. */
const UNKNOWN_WHISPER_MAX_SENDERS = 500;
/** lowercased sender → when they were last told. */
const lastUnknownWhisper = new Map<string, number>();

/** Whether a name is the host of any battle the bot tracks — an autohost, not a
 * person: it PMs the bot (force refusals, notices) and reads no answers. */
function isTrackedHost(name: string): boolean {
  const key = name.toLowerCase();
  return tracker.battles
    .all()
    .some((b) => (b.snapshot().founder ?? "").toLowerCase() === key);
}

/**
 * A whisper the bot has no command for. It answers rather than dropping it:
 * saying nothing is exactly what a broken bot does, and somebody typing "can you
 * balance this?" has no way to learn there is a command for that. The answer is
 * one line naming `.help`, at most once per UNKNOWN_WHISPER_COOLDOWN_MS per
 * sender, and never to ourselves or to an autohost (see the constants above).
 */
function answerUnknownWhisper(from: string, text: string, reply: (msg: string) => void): void {
  if (text.trim() === "") return;
  if (from.toLowerCase() === username.toLowerCase()) return;
  if (isTrackedHost(from)) return;
  const key = from.toLowerCase();
  const now = Date.now();
  if (now - (lastUnknownWhisper.get(key) ?? 0) < UNKNOWN_WHISPER_COOLDOWN_MS) return;
  if (lastUnknownWhisper.size >= UNKNOWN_WHISPER_MAX_SENDERS) lastUnknownWhisper.clear();
  lastUnknownWhisper.set(key, now);
  reply("sorry, I only understand commands — whisper .help for the list of them");
}

/** The avoid-list commands, both whisper-only (see handleAvoidCommand). */
/** Per-account spacing between `.login` links (each new one voids the last). */
const LOGIN_COOLDOWN_MS = 30_000;
/** lowercased sender → when they were last sent a link. */
const lastLoginLink = new Map<string, number>();

/** `.login` / `.logout`, whispered (see the authClient comment above). */
async function handleLoginCommand(from: string, cmd: string, reply: (msg: string) => void): Promise<void> {
  const key = from.toLowerCase();
  if (key === username.toLowerCase() || isTrackedHost(from)) return;
  const userId = accountIds.get(key);
  if (userId === undefined) {
    // ADDUSER arrives for everyone online at login and for each later login, so
    // this only happens in the moments after the bot itself (re)connected.
    reply(`${cmd}: I don't know your account yet — try again in a minute`);
    return;
  }
  if (cmd === ".logout") {
    try {
      const ended = await authClient.revoke(userId);
      reply(`logged out of the website everywhere (${ended} session${ended === 1 ? "" : "s"} ended)`);
    } catch (e) {
      logError(`.logout for ${from}`, e);
      reply(".logout: unavailable right now, try again later");
    }
    return;
  }
  const now = Date.now();
  if (now - (lastLoginLink.get(key) ?? 0) < LOGIN_COOLDOWN_MS) {
    reply(".login: a link was just sent — use that one, or ask again in 30 seconds");
    return;
  }
  lastLoginLink.set(key, now);
  if (lastLoginLink.size > UNKNOWN_WHISPER_MAX_SENDERS) lastLoginLink.clear();
  try {
    const link = await authClient.issue(from, userId);
    status(`website login link sent to ${from} (${userId})`);
    reply(`your website login link (works once, for 5 minutes — don't share it): ${link.url}`);
  } catch (e) {
    lastLoginLink.delete(key);
    logError(`.login for ${from}`, e);
    reply(".login: unavailable right now, try again later");
  }
}

const AVOID_COMMANDS = new Set([".avoid", ".avoidremove"]);

/** The one-line syntax reminder every avoid reply that needs it carries. */
const AVOID_SYNTAX =
  "syntax: .avoid <player> to add someone, .avoidremove <player> to remove them, " +
  ".avoid on its own to see your list";

/** The asker's list as one line: "Bob, Carol (2/10)", or that it is empty. */
function avoidListLine(entries: { avoid: string }[], limit: number): string {
  if (entries.length === 0) return "your avoid list is empty";
  return (
    `your avoid list (${entries.length}/${limit}): ` + entries.map((e) => e.avoid).join(", ")
  );
}

/**
 * .avoid [player] / .avoidremove <player> — the asker's OWN avoid list: the
 * people the balancer should keep them off a team with (when the split stays
 * inside AVOID_WIN_MIN..AVOID_WIN_MAX; see src/balance/balancer.ts).
 *
 * `.avoid` bare lists the entries and the syntax; `.avoid <player>` adds them.
 * Every command that CHANGES the list (an add, a removal, and a refusal of
 * either) ends by showing the list, so the asker always sees the state they
 * are left with rather than having to ask again.
 *
 * The lists live in the Worker (avoidClient), so every branch can fail on the
 * network: the asker is told the feature is unavailable and the real error goes
 * to the log, never to a player.
 */
async function handleAvoidCommand(
  from: string,
  words: string[],
  reply: (msg: string) => void,
): Promise<void> {
  const cmd = words[0] ?? "";
  const args = words.slice(1).filter((w) => w.length > 0);
  /** Show where the list stands now — the closing line of every change. */
  const replyList = async () => {
    const list = await avoidClient.list(from);
    reply(avoidListLine(list.entries, list.limit));
  };
  try {
    if (args.length === 0) {
      await replyList();
      reply(AVOID_SYNTAX);
      return;
    }
    if (args.length > 1) {
      reply(`${cmd}: one player name at a time — ${AVOID_SYNTAX}`);
      return;
    }
    const target = args[0];
    if (cmd === ".avoidremove") {
      const r = await avoidClient.remove(from, target);
      reply(r.removed ? `removed ${r.name} from your avoid list` : `${r.name} is not on your avoid list`);
      await replyList();
      return;
    }
    const r = await avoidClient.add(from, target);
    if (r.ok) {
      reply(
        `added ${r.entry.avoid} — you two are kept on opposite teams whenever the ` +
          `balance allows it`,
      );
      await replyList();
      return;
    }
    switch (r.reason) {
      case "self":
        reply("you cannot avoid yourself");
        return;
      case "duplicate":
        reply(`${r.entry.avoid} is already on your avoid list`);
        await replyList();
        return;
      case "limit":
        reply(
          `your avoid list is full (${r.count}/${r.limit}) — ` +
            `remove someone first with .avoidremove <player>`,
        );
        await replyList();
        return;
      case "unknown-player":
        reply(
          `no player called "${target}" in the ranking` +
            (r.suggestions.length ? ` — did you mean: ${r.suggestions.join(", ")}?` : ""),
        );
        return;
    }
  } catch (e) {
    logError(`${cmd} failed`, e);
    reply(`${cmd}: unavailable right now, try again later`);
  }
}

/** Where the bot points people for ratings, lobbies and match history. */
const SITE_URL = "https://lavabalance.fogofwar.dev/";

/** When the last battle-chat `.scout` ran (the lobby form's cooldown). */
let lastBattleScoutRun = 0;

/**
 * `.scout <player>` — one line on how that player plays: OneTrickLava's
 * archetypes, their main lanes and record there, and the warning badges
 * (💥 comm bomber, 🪂 comm dropper…), with a link to the full card. The card
 * is read from the Worker's public route, so a private LOS profile has none.
 * A lookup failure tells the asker it is unavailable; the error goes to the log.
 */
async function handleScoutCommand(arg: string, reply: (msg: string) => void): Promise<void> {
  const name = arg.trim().split(/\s+/)[0] ?? "";
  if (!name) {
    reply(".scout <player> — how they play (style, lanes, comm habits), from OneTrickLava's replay analysis");
    return;
  }
  try {
    const card = await scoutClient.card(name);
    if (!card) {
      reply(`no scouting card for ${name} — OneTrickLava has not analysed enough of their lava games`);
      return;
    }
    reply(`${scoutLine(card)} — ${SITE_URL}player/${card.userId}`);
  } catch (e) {
    logError(".scout failed", e);
    reply(".scout: unavailable right now, try again later");
  }
}

/**
 * ONE INDENT STEP in chat. **Not a space**: BAR's lobby chat collapses leading
 * ASCII spaces, so every indented help line rendered flush left (verified in the
 * lobby, 2026-09-22). U+2001 EM QUAD is a real character to the renderer, so it
 * survives — one per step, an em wide each.
 */
const IND = " ";
/** A command's own line, and the wrapped remainder of its description. */
const CMD_INDENT = IND;
const WRAP_INDENT = IND + IND + IND;

/** A visually blank help line. Not "" — an empty SAYPRIVATE payload is not worth
 * betting on; one EM QUAD renders the same and is unambiguously a message (and,
 * unlike a space, is not collapsed away). */
const BLANK = IND;

/**
 * .help — a `--help`-shaped listing of every command the asker may use: a two
 * sentence intro, then the commands, then (admins only) the admin section. BAR's
 * chat font is proportional, so this uses `cmd — description` rather than padded
 * columns, which would not line up; the hierarchy comes from `IND` instead — the
 * command a step in from its section, its wrapped lines a step in from the
 * command. One SAYPRIVATE per line.
 */
function printHelp(reply: (msg: string) => void, isAdmin: boolean): void {
  const cmd = (line: string) => CMD_INDENT + line;
  const wrap = (line: string) => WRAP_INDENT + line;
  const lines = [
    `lavabalance is a rating-aware autobalance bot for Lava lobbies. ` +
      `For more details and player ranking see: ${SITE_URL}`,
    BLANK,
    "USAGE",
    cmd("whisper a command to this bot, or type it in the battle chat where noted"),
    BLANK,
    "COMMANDS",
    cmd(".help — show this help"),
    cmd(".bot — one line saying what this bot is, with the ranking link (worded"),
    wrap("differently every time). Whisper or battle chat; in the battle chat"),
    wrap("everyone sees it."),
    cmd(".status — the teams with their LOS, plus the matchup (average LOS and win"),
    wrap("chance). Whisper or battle chat; needs 6+ players in the lobby."),
    cmd(".balance — LOS balance, following the lobby's balanceMode (parties kept"),
    wrap("together on clan;skill, ignored on skill/random). Whispered it is a"),
    wrap("read-only preview (the !fb is whispered back, nobody is moved). In battle"),
    wrap("chat it is live: bosses only, and the lobby's autoBalance must be off."),
    cmd(".avoid — your avoid list: the people the balancer keeps you off a team"),
    wrap("with. On its own it lists them; .avoid <player> adds one,"),
    wrap(".avoidremove <player> drops one. Up to " + MAX_AVOIDS_PER_PLAYER + " people, and an avoid is"),
    wrap(
      "only honoured while the teams stay inside " +
        Math.round(AVOID_WIN_MIN * 100) + "-" + Math.round(AVOID_WIN_MAX * 100) +
        "% win chance. Whisper only.",
    ),
    cmd(".scout <player> — how they play: style, main lanes and their record there,"),
    wrap("comm-bomb/drop habits (OneTrickLava's replay analysis). Whisper or battle"),
    wrap("chat; in the battle chat everyone sees it."),
    cmd(".info — everything the bot tracks: its own state, the battle, host settings"),
    wrap("and the roster. Whisper only."),
    cmd(".login (or login) — a one-time link that logs you in to " + SITE_URL + " with this"),
    wrap("account. .logout logs you out of the website everywhere. Whisper only."),
  ];
  if (isAdmin) {
    lines.push(
      BLANK,
      "ADMIN COMMANDS",
      cmd(".join <battleID> — join that battle as a spectator, leaving the current one"),
      cmd(".join me — join the battle you are in"),
      cmd(".lavatoggle — flip the bot's auto-balance flag"),
      cmd(".splitparties on|off — whether .balance may break up parties when keeping"),
      wrap("them together leaves the lobby too imbalanced (default on; bare"),
      wrap(".splitparties shows the current state). Bosses may also use it in the"),
      wrap("battle chat."),
    );
  }
  for (const line of lines) reply(line);
}

/** Max characters per whispered .info line; longer groups are split across lines. */
const INFO_LINE_MAX = 400;

/**
 * .info — whisper-only dump of everything the bot tracks: its own connection and
 * balance state, then the joined battle's full tracked snapshot — the BATTLEOPENED
 * facts, the lobby settings the host broadcasts via BarManager (autoBalance,
 * balanceMode, bosses), and the roster with each player's decoded battle status.
 * Only values the bot actually uses are shown (so no mod options — the tracker
 * records them, but nothing reads them). Read-only, no lookups; one SAYPRIVATE
 * per group.
 */
function printInfo(reply: (msg: string) => void): void {
  const yn = (b: boolean) => (b ? "yes" : "no");
  // Whisper `items` joined by `sep`, split into lines under INFO_LINE_MAX.
  const replyList = (prefix: string, items: string[], sep = ", ") => {
    if (items.length === 0) {
      reply(`${prefix} none`);
      return;
    }
    let line = prefix;
    let first = true;
    for (const item of items) {
      if (!first && line.length + sep.length + item.length > INFO_LINE_MAX) {
        reply(line);
        line = `${prefix} …`;
        first = true;
      }
      line += (first ? " " : sep) + item;
      first = false;
    }
    reply(line);
  };

  const pending = pendingBattleId !== null ? ` (joining ${pendingBattleId})` : "";
  const web = teiserverWeb ? (teiserverWeb.hasSession() ? "ok" : "pending") : "off";
  reply(
    `bot: ${username}@${host}:${port} connected=${yn(sock !== null)} ` +
      `battle=${joinedBattleId ?? "none"}${pending} webLogin=${web} ` +
      `los=${losBase} admins=${[...admins].join(",") || "none"}`,
  );
  const parties =
    partyCache && partyCache.battleId === joinedBattleId
      ? `${partyCache.byName.size} names, ${Math.round((Date.now() - partyCache.fetchedAt) / 1000)}s old`
      : "none";
  reply(
    `balance: botCanAutobalance=${yn(autoBalance)} balancedThisBattle=${yn(balanced)} ` +
      `size=${BALANCE_SIZE} ` +
      `minPlayersToReport=${MIN_PLAYERS_FOR_REPORT} lastPlayerCount=${lastPlayerCount} ` +
      `parties=${lobbyKeepsParties() ? "kept" : "ignored (balanceMode)"} ` +
      `splitParties=${splitParties ? "on" : "off"} ` +
      `partyCache=${parties} losCache=${losCache.size}`,
  );
  reply(
    `comp watcher: ${compWatcher.describe()} ` +
      `forceRejected=${yn(forceRejectedByAutoBalance)} ` +
      `forceTeamsBlocked=${forceTeamsBlocked() ?? "no"}`,
  );
  reply(
    `autoBlockBalance: lobby=${lobbyAutoBlockBalance ?? "?"} ` +
      `heldOpenByBot=${yn(autoBlockBalanceOffByUs)} ` +
      `pendingAnnounce=${pendingAnnounce === null ? "no" : "yes"}`,
  );
  if (lastForceRejection !== null) {
    const ago = Math.round((Date.now() - lastForceRejection.at) / 1000);
    reply(`last !fb refused by the host ${ago}s ago: ${lastForceRejection.reason}`);
  }
  if (joinedBattleId === null) return;
  const battle = tracker.battles.get(joinedBattleId);
  if (!battle) {
    reply(`battle ${joinedBattleId}: no tracked state yet`);
    return;
  }
  const s = battle.snapshot();
  reply(
    `battle ${s.battleId}: title="${s.title}" founder=${s.founder} map="${s.map}" ` +
      `game="${s.gameName}" engine=${s.engineVersion}`,
  );
  reply(
    `lobby: maxPlayers=${s.maxPlayers} passworded=${yn(s.passworded)} locked=${yn(s.locked)} ` +
      `spectators=${s.spectatorCount} players=${s.playerCount}`,
  );
  // balanceMode is shown with what it MEANS for our balancer (we always balance on
  // LOS; the mode only decides whether parties are kept together) — the setting
  // alone reads as if the bot reproduced SPADS's algorithm, which it does not.
  const mode = balanceModeInfo(s.balanceMode);
  reply(
    `host settings: autoBalance=${s.autoBalance ?? "?"} balanceMode=${s.balanceMode ?? "?"} ` +
      `(${mode.partyNote}) bosses=${s.bosses.join(",") || "none"}`,
  );
  if (s.vote) {
    reply(
      `vote in progress: "${s.vote.command.join(" ")}" by ${s.vote.caller || "?"} ` +
        `(start-vote guard ${voteGuard ? (voteGuard.fired ? "fired" : "armed") : "off"})`,
    );
  }
  // Roster: one line per ally team (1-based like the lobby UI), then spectators,
  // then members whose battle status hasn't been seen yet.
  const known = s.players.filter((p) => p.statusKnown && !p.spectator);
  const describe = (p: (typeof s.players)[number]) => {
    const flags = [`t${p.team + 1}`, p.ready ? "ready" : "notready"];
    if (p.sync === 2) flags.push("unsynced");
    else if (p.sync === 0) flags.push("sync?");
    return `${p.name}(${flags.join(" ")})`;
  };
  for (const ally of [...new Set(known.map((p) => p.ally))].sort((a, b) => a - b)) {
    replyList(`team ${ally + 1}:`, known.filter((p) => p.ally === ally).map(describe));
  }
  const specs = s.players.filter((p) => p.statusKnown && p.spectator).map((p) => p.name);
  if (specs.length) replyList("spectators:", specs);
  const unknown = s.players.filter((p) => !p.statusKnown).map((p) => p.name);
  if (unknown.length) replyList("status unknown:", unknown);
  // Mod options (SETSCRIPTTAGS) are recorded by the tracker but the bot uses none
  // of them, so none are printed — .info shows only what the bot acts on. When a
  // mod option starts to matter, list just that one here.
}

/**
 * The head-to-head line for a set of players grouped by their CURRENT ally teams.
 * LOS throughout, matching the web UI's matchup strip: average shown LOS per team
 * (a never-rated player counts as UNRATED_LOS ≈ 3.7, a debutant) and the win
 * chance from OpenSkill predictWin over every player's μ/σ with the rookie
 * handicap — the predictor the LOS fold is calibrated with, NOT an Elo formula on
 * the averages. Null unless the lobby has exactly two teams, where a head-to-head
 * is meaningful. Returns the text plus the first (lower-numbered) team's win
 * chance in percent — the number the composition watcher baselines on.
 */
function matchupLine(
  players: { name: string; ally: number }[],
  ratingOf: (name: string) => LosState | undefined,
): { text: string; winFirst: number } | null {
  const teams = [...new Set(players.map((p) => p.ally))].sort((a, b) => a - b);
  if (teams.length !== 2) return null;
  const members = (ally: number) => players.filter((p) => p.ally === ally);
  const states = (ally: number) => members(ally).map((p) => ratingOf(p.name) ?? null);
  const avg = (ally: number) => {
    const m = members(ally);
    return m.reduce((sum, p) => sum + shownLos(ratingOf(p.name)), 0) / m.length;
  };
  const [a, b] = [avg(teams[0]), avg(teams[1])];
  const winA = teamsWinProb(states(teams[0]), states(teams[1])) * 100;
  const text =
    `Lava OS: team ${teams[0] + 1}: ${a.toFixed(1)} (${winA.toFixed(1)}% win) vs ` +
    `team ${teams[1] + 1}: ${b.toFixed(1)} (${(100 - winA).toFixed(1)}% win)`;
  return { text, winFirst: winA };
}

/**
 * The lobby's own autoBalance setting, from the host's last BattleStateChanged
 * broadcast (null = not seen yet). Only as fresh as that broadcast.
 */
function lobbyAutoBalanceSetting(): string | null {
  return joinedBattleId !== null
    ? tracker.battles.get(joinedBattleId)?.snapshot().autoBalance ?? null
    : null;
}

/**
 * The lobby's own `balanceMode` setting, from the same broadcast (null = not seen
 * yet). The bot always balances on skill; the mode only decides whether PARTIES
 * constrain the split — see src/balance/balanceMode.ts.
 */
function lobbyBalanceModeSetting(): string | null {
  return joinedBattleId !== null
    ? tracker.battles.get(joinedBattleId)?.snapshot().balanceMode ?? null
    : null;
}

/** True while the joined lobby's balanceMode keeps party members on one team. */
function lobbyKeepsParties(): boolean {
  return honoursParties(lobbyBalanceModeSetting());
}

/**
 * SPADS refuses manual teams while its own autoBalance is enabled — `hForce` in
 * spads.pl answers `!fb` with "Cannot force id/team, autoBalance is enabled",
 * and that refusal only reaches us as a PM from the host. Latched here (see
 * `handleHostForceRejection`) because the tracked setting can be WRONG: it is
 * only as fresh as the host's last broadcast, so a lobby that looks "off" can
 * still reject. Cleared when a boss really turns autoBalance off (a fresh
 * broadcast flipping the setting to "off" — see `syncAutoBalanceWithLobby`) and
 * by `resetBalanceState`.
 */
let forceRejectedByAutoBalance = false;

/**
 * Why the bot cannot set teams in this lobby right now, or null when it can:
 * either the host's last broadcast says autoBalance isn't `off`, or SPADS has
 * already rejected an `!fb` for that reason. Everything that would move players
 * checks this FIRST — a rejected `!fb` moves nobody but still makes the bot
 * announce (and baseline on) an arrangement the lobby never got.
 */
function autoBalanceBlocksForce(): string | null {
  if (forceRejectedByAutoBalance) {
    return "the host rejected our last !fb because autoBalance is enabled";
  }
  const setting = lobbyAutoBalanceSetting();
  if (setting !== null && setting !== "off") return `the lobby's autoBalance is "${setting}"`;
  return null;
}

/**
 * Why the bot cannot set teams right now, or null when it can — the full check,
 * including the ones that have nothing to do with autoBalance. `.info`, `/health`
 * and the composition watcher all read THIS, so "why isn't it balancing?" has one
 * answer everywhere.
 */
function forceTeamsBlocked(): string | null {
  if (joinedBattleId === null) return "not in a battle";
  if (!isBoss(username)) return "the bot is not a boss";
  return autoBalanceBlocksForce();
}

// --- autoBlockBalance: SPADS's own lock on manual team changes ---
//
// With `autoBlockBalance` on, SPADS refuses EVERY `!fb` from the moment its own
// balancer has touched the teams — "Cannot force id/team, teams have been
// balanced and autoBlockBalance is enabled" — which any player can bring about by
// typing `!balance`. On 2026-09-07 that is exactly what happened, twice, and the
// game launched on SPADS's split. A lobby the bot balances cannot also be one any
// player can lock it out of, so while the bot IS the balancer (it is a boss and
// the lobby's own autoBalance is off) it holds the lock OPEN, and it hands it back
// the moment it stops being the balancer.
//
// The trade is deliberate: with the lock off, players can switch sides after a
// balance. That is what the start-vote guard (`!ev` on a change mid-vote) and the
// composition watcher (re-balance on a change) are there for.

/** Beat between clearing the lock and re-running the balance it refused. */
const BALANCE_LOCK_RETRY_MS = 500;

/** SPADS takes 0/1 for a boolean setting. */
const AUTO_BLOCK_BALANCE_OFF = "0";
const AUTO_BLOCK_BALANCE_ON = "1";

/** The lobby's autoBlockBalance as last announced by the host; null = unseen. */
let lobbyAutoBlockBalance: string | null = null;
/** True while the bot is the one holding the lock open. */
let autoBlockBalanceOffByUs = false;
/**
 * Guard on the recovery path: the bot clears the lock at most once between
 * successful forces, so a boss who puts it back does not get fought in a loop.
 */
let autoBlockBalanceUnblockTried = false;

/** `!set autoBlockBalance <value>`, with the reason on stdout. */
function setAutoBlockBalance(value: string, why: string): void {
  send(spadsWire(`!set autoBlockBalance ${value}`));
  status(`!set autoBlockBalance ${value} — ${why}`);
}

/**
 * Keep the lock out of the way exactly while the bot is this lobby's balancer.
 * Runs on the balance poll (and on joining/leaving), so it follows the lobby's
 * autoBalance setting and the boss list without needing its own trigger.
 */
function syncAutoBlockBalance(): void {
  const canForce = forceTeamsBlocked() === null;
  if (canForce === autoBlockBalanceOffByUs) return;
  autoBlockBalanceOffByUs = canForce;
  if (canForce) {
    autoBlockBalanceUnblockTried = false;
    setAutoBlockBalance(AUTO_BLOCK_BALANCE_OFF, "the bot is this lobby's balancer");
  } else {
    setAutoBlockBalance(AUTO_BLOCK_BALANCE_ON, "the bot is no longer balancing this lobby");
  }
}

/** Hand the lock back before walking away from a lobby we opened it in. */
function restoreAutoBlockBalance(why: string): void {
  if (!autoBlockBalanceOffByUs) return;
  autoBlockBalanceOffByUs = false;
  setAutoBlockBalance(AUTO_BLOCK_BALANCE_ON, why);
}

/**
 * SPADS just refused an `!fb` because of the lock. If the bot is the balancer here
 * the lock should not have been on — a boss put it back, or our `!set` never took
 * — so clear it and say so. Returns whether it did: the caller skips the composition
 * watcher's retry cooldown when it did, because the block is gone.
 */
function clearBalanceLockAfterRefusal(): boolean {
  if (forceTeamsBlocked() !== null) return false; // not the bot's lobby to manage
  if (autoBlockBalanceUnblockTried) return false; // already tried; a boss wants it on
  autoBlockBalanceUnblockTried = true;
  autoBlockBalanceOffByUs = true;
  setAutoBlockBalance(AUTO_BLOCK_BALANCE_OFF, "it just refused our !fb");
  return true;
}

/** The host's setting announce, e.g. `* Global setting changed by Songi (balanceMode=clan;skill)`. */
const SETTING_CHANGED_RE = /setting changed by \S+ \(([A-Za-z]+)=([^)]*)\)/;

/**
 * Follow autoBlockBalance when someone else changes it. The bot does not fight a
 * boss over it: it records the new value and stops claiming to hold the lock open,
 * which is what makes the next refusal explain itself instead of surprising anyone.
 */
function handleHostSettingAnnounce(from: string, text: string): void {
  if (!isFounder(from)) return;
  const m = SETTING_CHANGED_RE.exec(text);
  if (m === null || m[1].toLowerCase() !== "autoblockbalance") return;
  lobbyAutoBlockBalance = m[2];
  if (m[2] === AUTO_BLOCK_BALANCE_OFF) return;
  if (!autoBlockBalanceOffByUs) return;
  autoBlockBalanceOffByUs = false;
  status(`autoBlockBalance is "${m[2]}" again — our !fb can be refused from here on`);
}

/** What the bot says when asked to balance a lobby SPADS won't let it touch. */
function autoBalanceRefusal(reason: string): string {
  return (
    `.balance: autoBalance must be off for the bot to set teams — ${reason}. ` +
    `A boss can turn it off with "!set autoBalance off"`
  );
}

/**
 * The last `!fb` the host refused: the reason and when, for `.info`. Cleared by
 * `resetBalanceState` — unlike the autoBalance latch this is a record, not a gate.
 */
let lastForceRejection: { reason: string; at: number } | null = null;

/**
 * Record SPADS's refusal of our `!fb` (`classifyForceRejection` decides whether a
 * host PM is one). The teams were NOT set, so the matchup the bot announced a
 * moment earlier — and baselined the composition watcher on — is fiction. Both
 * kinds of refusal get that corrected, and both get SAID in battle chat, because
 * players read the announce as the teams they are about to play:
 *
 *   autoBalance — indefinite, so it latches into `forceTeamsBlocked()` and the bot
 *     stops trying until a boss turns the setting off. Said once per latch.
 *   everything else — chiefly `autoBlockBalance` after somebody ran `!balance`,
 *     which the next roster change clears. NEVER latched (that would wedge the bot
 *     out of a lobby that unblocks itself seconds later): the watcher re-reads the
 *     real teams and holds off automatic forces for the retry cooldown.
 */
function handleHostForceRejection(from: string, text: string): void {
  const rejection = classifyForceRejection(text);
  if (rejection === null) return;
  if (!isFounder(from)) return;
  lastForceRejection = { reason: rejection.reason, at: Date.now() };
  if (rejection.kind === "autoBalance") {
    compWatcher.setBaseline(null); // the announced arrangement was never applied
    compWatcher.endBlackout();
    if (forceRejectedByAutoBalance) return; // already latched — say it once
    forceRejectedByAutoBalance = true;
    status("host rejected !fb (autoBalance is enabled) — not balancing until a boss turns it off");
    battleReply(autoBalanceRefusal("the host rejected the teams it was sent"));
    return;
  }
  // The lock is the bot's to manage in a lobby it balances: clearing it here is
  // what turns "refused again" into "refused once", and it means the retry the
  // watcher is about to allow will actually land — so no cooldown in that case.
  const cleared = rejection.kind === "balanceLock" && clearBalanceLockAfterRefusal();
  compWatcher.forceRejected(rejection.reason, !cleared);
  dropPendingAnnounce("the host refused the teams");
  battleReply(
    cleared
      ? `those teams were NOT applied — SPADS's autoBlockBalance refused them. ` +
          `I've turned it off ("!set autoBlockBalance 0"); balancing again now`
      : `those teams were NOT applied — the host refused them (${rejection.reason}). ` +
          `The lobby keeps the teams it has; a boss can clear it with ` +
          `"!set autoBlockBalance 0"`,
  );
  if (cleared) {
    // The blocker is gone; redo the balance the host just threw away rather than
    // waiting for the next roster event. Once only — clearBalanceLockAfterRefusal
    // latches, so a second refusal cannot start this again.
    setTimeout(() => void runBalance(battleReply, true), BALANCE_LOCK_RETRY_MS);
  }
}

/**
 * A LIVE `.balance` (battle chat) is boss-only, on BOTH sides: only a lobby boss
 * may ask for it (being a BOT_ADMIN is not enough — this is a lobby-shaping
 * action, so it follows lobby authority), and the BOT must be a boss too, since
 * without that SPADS would reject the `!force` commands it produces. A refusal is
 * SAID — the reason goes back through `reply` (the battle chat) — so `.balance`
 * never looks ignored. The whispered preview doesn't come through here at all:
 * it moves nobody, so it has no boss requirement.
 */
function balanceAllowed(from: string, reply: (msg: string) => void): boolean {
  if (joinedBattleId === null) {
    reply(".balance: not in a battle");
    status(`ignoring .balance from ${from} (not in a battle)`);
    return false;
  }
  if (!isBoss(from)) {
    reply(`.balance: won't balance — ${from} is not a lobby boss`);
    status(`ignoring .balance from ${from} (${from} is not a boss)`);
    return false;
  }
  if (!isBoss(username)) {
    reply("won't balance - I'm not a boss");
    status(`ignoring .balance from ${from} (the bot is not a boss)`);
    return false;
  }
  // SPADS would throw the `!fb` away and the bot would announce teams the lobby
  // never got. Refuse with the reason instead of pretending it worked.
  const blocked = autoBalanceBlocksForce();
  if (blocked !== null) {
    reply(autoBalanceRefusal(blocked));
    status(`ignoring .balance from ${from} (${blocked})`);
    return false;
  }
  return true;
}

/**
 * The bot-side half of the check, shared with auto-balance (which has no asker):
 * we must be in a battle and be a boss, or SPADS would reject the `!force` lines.
 */
function botCanBalance(context: string): boolean {
  if (joinedBattleId === null) {
    status(`${context} (not in a battle)`);
    return false;
  }
  if (!isBoss(username)) {
    status(`${context} (the bot is not a boss)`);
    return false;
  }
  const blocked = autoBalanceBlocksForce();
  if (blocked !== null) {
    status(`${context} (${blocked})`);
    return false;
  }
  return true;
}

// --- Party cache (the one thing the lobby protocol doesn't carry) ---
//
// Party membership exists ONLY on Teiserver's web UI: the show page's "Party"
// column colours each party's cell (2+ members; players sharing a colour play
// together — see `partyKey` in src/teiserver.ts). That scrape takes seconds
// (LiveView render + TLS on a 1/16-vCPU container), so `.balance` no longer
// waits for it: the roster comes from the bot's own SessionTracker (instant),
// and each `.balance` kicks off a BACKGROUND scrape whose parties are cached
// and used by the NEXT run. First run in a lobby = no parties honoured yet;
// good enough, per the operator's call.

/** Cached party membership for one battle: lowercased player name → party key. */
let partyCache: { battleId: number; fetchedAt: number; byName: Map<string, string> } | null = null;
/** One background scrape at a time. */
let partyRefreshInFlight = false;

/**
 * Refresh the party cache from Teiserver's web UI, in the background (never
 * awaited on a command path). Silently skipped when the web login is not
 * configured — `.balance` then simply runs party-blind — and when the lobby's
 * balanceMode ignores parties anyway (a "skill"/"random" lobby: nothing would
 * read the result, and the scrape costs seconds on a 1/16-vCPU container). A
 * mode flipping back to "clan;skill" simply makes the next run the party-blind
 * "first run in this lobby", exactly as a fresh join is.
 */
function refreshParties(): void {
  if (!teiserverWeb || joinedBattleId === null || partyRefreshInFlight) return;
  if (!lobbyKeepsParties()) return;
  const battleId = joinedBattleId;
  partyRefreshInFlight = true;
  (async () => {
    await teiserverWeb.ensureLogin();
    const show = parseLobbyShow(await teiserverWeb.authedFetch(`/battle/lobbies/show/${battleId}`));
    const byName = new Map<string, string>();
    for (const m of show.members) {
      if (m.party && !m.spectator) byName.set(m.name.toLowerCase(), m.party);
    }
    partyCache = { battleId, fetchedAt: Date.now(), byName };
    status(
      `parties refreshed for battle ${battleId}: ` +
        `${byName.size} partied player${byName.size === 1 ? "" : "s"}`,
    );
  })()
    .catch((e) => logError("party refresh failed", e))
    .finally(() => {
      partyRefreshInFlight = false;
    });
}

/**
 * The avoid pairs constraining THIS roster (src/avoids.ts), from the Worker.
 * Never throws and never blocks a balance: a lookup that fails balances the
 * lobby as if nobody had asked, with the reason in the log — a bot that
 * refuses to balance because a side lookup is down is worse than one that
 * balances without it.
 */
async function fetchAvoidPairs(names: string[]): Promise<AvoidPair[]> {
  try {
    return await avoidClient.pairs(names);
  } catch (e) {
    logError("avoid lookup failed (balancing without avoids)", e);
    return [];
  }
}

/** What the balancer did with the avoid requests — stdout only, see runBalance. */
function logAvoidOutcome(outcome: {
  requested: AvoidPair[];
  honoured: AvoidPair[];
  violated: AvoidPair[];
  skippedForBalance: boolean;
}): void {
  if (outcome.requested.length === 0) return;
  const pair = (p: AvoidPair) => `${p.a} / ${p.b}`;
  status(
    `avoids: ${outcome.requested.length} pair${outcome.requested.length === 1 ? "" : "s"} in this ` +
      `lobby, ${outcome.honoured.length} kept apart, ${outcome.violated.length} together` +
      (outcome.skippedForBalance
        ? ` (honouring more would push the match outside ` +
          `${Math.round(AVOID_WIN_MIN * 100)}-${Math.round(AVOID_WIN_MAX * 100)}%)`
        : ""),
  );
  if (outcome.violated.length) {
    console.log(`  avoids not honoured: ${outcome.violated.map(pair).join(", ")}`);
  }
}

/**
 * .balance — our OWN balancer, party-aware, output to stdout only.
 *
 * The roster comes from the bot's own SessionTracker (the tracked protocol
 * state — same source as `.status`), so there is no network wait before the
 * balance. Parties come from the cache above: this run uses whatever the LAST
 * background scrape learned, and starts a fresh scrape for the next one.
 * Ratings are LOS (the lookup API); a never-rated player counts as a debutant
 * (UNRATED_LOS ≈ 3.7 — see src/balance/balancer.ts).
 *
 * `opts.summarySuffix` is appended to the announced matchup line (the composition
 * watcher tags its automatic rebalance with " (rebalanced after comp change)").
 * `opts.skipUnlessBetterThan` is the composition watcher's dead-band: the win
 * chance the lobby ALREADY has, against which the balanced arrangement must be an
 * improvement of at least MIN_REBALANCE_GAIN_PP or nothing is sent at all.
 */
interface BalanceOptions {
  summarySuffix?: string;
  skipUnlessBetterThan?: number;
}

async function runBalance(
  reply: (msg: string) => void,
  live: boolean,
  opts: BalanceOptions = {},
): Promise<void> {
  const summarySuffix = opts.summarySuffix ?? "";
  try {
    if (joinedBattleId === null) {
      reply(".balance: not in a battle");
      return;
    }
    // Start the background party scrape for the NEXT run right away (a no-op in a
    // lobby whose balanceMode ignores parties).
    refreshParties();
    // 1) the lobby's roster from the tracker (let queued lines apply first).
    await trackerQueue;
    // The lobby's balanceMode decides whether parties constrain the split at all:
    // "clan;skill" (and an unseen mode) keeps them together, "skill"/"random"
    // balances everyone individually. Either way the objective stays LOS.
    const mode = balanceModeInfo(lobbyBalanceModeSetting());
    const partyOfName = (name: string): string | null =>
      mode.parties && partyCache && partyCache.battleId === joinedBattleId
        ? partyCache.byName.get(name.toLowerCase()) ?? null
        : null;
    const players = knownPlayers().map((p) => ({
      name: p.name,
      ally: p.ally,
      party: partyOfName(p.name),
    }));
    if (players.length < 2) {
      reply(`.balance: battle ${joinedBattleId} has too few players`);
      return;
    }

    // 2) the parties, from the cache (a leftover "party" of one — the rest of it
    // left the lobby — constrains nothing in the balancer and is shown as-is).
    const parties = new Map<string, string[]>();
    for (const p of players) {
      if (!p.party) continue;
      const members = parties.get(p.party) ?? [];
      members.push(p.name);
      parties.set(p.party, members);
    }
    const cacheNote = !mode.parties
      ? `balanceMode ${mode.label}`
      : partyCache && partyCache.battleId === joinedBattleId
        ? `party data ${Math.round((Date.now() - partyCache.fetchedAt) / 1000)}s old`
        : "no party data yet (refreshing in background)";
    status(
      `balance: battle ${joinedBattleId}, ${players.length} players, ` +
        `${parties.size} part${parties.size === 1 ? "y" : "ies"} (${cacheNote})`,
    );
    if (!mode.parties) {
      console.log(`  (parties ignored — the lobby's balanceMode is ${mode.mode ?? "?"})`);
    } else if (parties.size === 0) {
      console.log("  (no parties)");
    } else {
      let i = 0;
      for (const [colour, members] of parties) {
        console.log(`  party ${++i} (${colour}): ${members.join(", ")}`);
      }
    }

    // 3) LOS ratings and the avoid requests, then our own party-aware balancer
    // (predictWin objective). Party splitting: when even the best
    // party-constrained split leaves one side's win chance above
    // PARTY_SPLIT_MAX_WIN, the parties are re-balanced individually as balance
    // mode "skill" would (result.partiesIgnored). The avoids are a SOFT
    // constraint on the same search — honoured only while the win chance stays
    // inside AVOID_WIN_MIN..AVOID_WIN_MAX (src/balance/balancer.ts).
    const ratings = await cachedLos(players.map((p) => p.name));
    const avoid = await fetchAvoidPairs(players.map((p) => p.name));
    const balanceInput = players.map((p) => ({
      name: p.name,
      rating: losOfName(ratings, p.name) ?? null,
      partyId: p.party,
    }));
    // `.splitparties off` disables the split rule: plain balanceTeams keeps the
    // parties whole whatever the resulting win chance (partiesIgnored never set).
    const result = splitParties
      ? balanceTeamsWithPartySplit(balanceInput, { avoid })
      : balanceTeams(balanceInput, { avoid });
    // Who avoids whom is NOT announced: it goes to the log, never to a chat
    // line the lobby (or the whispering asker) reads.
    logAvoidOutcome(result.avoid);
    if (result.partiesIgnored) {
      console.log(
        `note: keeping the parties together left a win chance above ` +
          `${(PARTY_SPLIT_MAX_WIN * 100).toFixed(0)}% — re-balanced ignoring parties`,
      );
    }

    // 4) the suggested teams.
    const nameWidth = Math.max(...players.map((p) => p.name.length));
    const partyOf = new Map<string, number>();
    [...parties.keys()].forEach((colour, idx) => partyOf.set(colour, idx + 1));
    for (const [idx, team] of [result.teamA, result.teamB].entries()) {
      if (!team.players.length) continue;
      console.log(`suggested team ${idx + 1} (${team.players.length} players, avg LOS ${team.avg.toFixed(1)}):`);
      for (const p of [...team.players].sort((x, y) => shownLos(y.rating) - shownLos(x.rating))) {
        const score = p.rating ? shownLos(p.rating).toFixed(1) : "-";
        const tag = p.partyId ? `  «party ${partyOf.get(p.partyId) ?? "?"}»` : "";
        console.log(`  ${p.name.padEnd(nameWidth)} ${score.padStart(5)}${tag}`);
      }
    }
    if (result.unrated.length) {
      console.log(`unrated (counted as LOS ${UNRATED_LOS.toFixed(1)}, a debutant): ${result.unrated.join(", ")}`);
    }
    if (result.sizeCompromised) {
      console.log("note: the parties made an even split impossible");
    }
    if (result.rookies.tieBreak) {
      console.log(
        `note: rookie tie-break — ${result.rookies.count} players under ${ROOKIE_SPLIT_GAMES} games ` +
          `spread ${result.rookies.gap === 0 ? "evenly" : `with a gap of ${result.rookies.gap}`} ` +
          `(within ${(ROOKIE_SPLIT_TOLERANCE * 100).toFixed(0)}pp of the best-balanced split)`,
      );
    }

    // 5) the arrangement's orientation and its win chance. Every LIVE path is
    // gated on autoBalance being off (balanceAllowed / botCanBalance), so no
    // pre-emptive "SPADS will reject this" warning is needed here; a rejection
    // that slips through a stale setting is latched by handleHostForceRejection.
    // A whispered PREVIEW moves nobody, so it runs either way — with a note when
    // forcing these teams would currently be refused.
    const { first, second, changed } = orientTeams(players, result);
    const winFirst = (first === result.teamA ? result.winProbA : 1 - result.winProbA) * 100;

    // The auto-rebalance path only pays for itself if the arrangement it would
    // force is meaningfully different from what the lobby already has: a change
    // smaller than MIN_REBALANCE_GAIN_PP is not worth moving everyone for.
    if (opts.skipUnlessBetterThan !== undefined) {
      const gain = Math.abs(winFirst - opts.skipUnlessBetterThan);
      if (gain < MIN_REBALANCE_GAIN_PP) {
        status(
          `balance: rebalancing would move team 1 from ` +
            `${opts.skipUnlessBetterThan.toFixed(1)}% to ${winFirst.toFixed(1)}% win ` +
            `(${gain.toFixed(1)}pp < ${MIN_REBALANCE_GAIN_PP}pp) — not worth it, leaving the teams alone`,
        );
        // Nothing was moved, so the lobby's OWN win chance is the new baseline.
        // No hold-off: every composition change at a full lobby is a fresh
        // reason to rebalance (ABS_UNFAIR_PP = 0), and a hold-off here would
        // swallow the next real one for 30s. The watcher only runs on an
        // actual change, so this cannot loop.
        compWatcher.setBaseline(opts.skipUnlessBetterThan);
        return;
      }
    }

    // 6) the SPADS !fb — really sent when asked in the lobby, previewed to the
    // asker when whispered. A live balance arms the start-vote guard's protection
    // window (only changes within BALANCE_PROTECT_MS of this earn an !ev) and the
    // composition watcher's blackout (see sendTeams).
    if (!live) {
      const blocked = autoBalanceBlocksForce();
      if (blocked !== null) reply(`.balance: preview only — ${blocked}`);
    }
    const sent = sendTeams(first, second, changed, live, reply);
    if (live) lastLiveBalanceAt = Date.now();

    // 7) the head-to-head summary for the assignment — straight from the
    // balancer's own numbers, oriented the way the !fb groups map onto team 1/2.
    // A party split (parties too stacked to keep together) says so in the line.
    const partySuffix = result.partiesIgnored ? " (too imbalanced -> ignoring parties)" : "";
    const line =
      `Lava OS: team 1: ${first.avg.toFixed(1)} (${winFirst.toFixed(1)}% win) vs ` +
      `team 2: ${second.avg.toFixed(1)} (${(100 - winFirst).toFixed(1)}% win)` +
      partySuffix +
      summarySuffix;
    if (sent) {
      // A force is in flight. Say nothing until the lobby arrives at it — see
      // "The matchup line waits for the teams to actually land". The baseline
      // waits with it: the watcher must never judge against teams only asked for.
      dropPendingAnnounce("a newer force supersedes it");
      pendingAnnounce = { line, winFirst };
      console.log(`${line} (holding until the teams land)`);
      return;
    }
    // Nothing is in flight: a whispered preview, or a lobby that already matches
    // the suggestion. Either way the line describes something true right now.
    console.log(line);
    reply(line);
    if (live) compWatcher.setBaseline(winFirst);
  } catch (e) {
    // Internal errors are logged (with stack + cause) and NEVER echoed to players.
    logError(".balance failed", e);
    reply(".balance: unavailable right now, try again later");
  }
}

/**
 * Decide which suggested team becomes team 1. The current lobby sides
 * (`current`) settle two things and nothing else: the orientation that changes
 * fewer players' sides, and how many players that costs (`changed` — 0 means the
 * lobby already matches the suggestion and nothing need be sent).
 *
 * Returns the teams in `!fb` order — [what becomes team 1, what becomes team 2] —
 * so the caller can report the matchup for the assignment it is about to set.
 */
function orientTeams(
  current: { name: string; ally: number }[],
  result: ReturnType<typeof balanceTeams>,
): { first: typeof result.teamA; second: typeof result.teamB; changed: number } {
  const allyNow = new Map(current.map((p) => [p.name, p.ally]));
  // How many players end up on a different side if `team` is forced onto `ally`.
  const changes = (team: typeof result.teamA, ally: number) =>
    team.players.filter((p) => allyNow.get(p.name) !== ally).length;
  const straight = changes(result.teamA, 0) + changes(result.teamB, 1);
  const swapped = changes(result.teamA, 1) + changes(result.teamB, 0);
  const [first, second] =
    swapped < straight ? [result.teamB, result.teamA] : [result.teamA, result.teamB];
  return { first, second, changed: Math.min(straight, swapped) };
}

/**
 * Set the teams with ONE SPADS command: the manual-balance form of `!force` —
 * `!fb (a,b,c)(d,e,f)` (`!fb` is SPADS's built-in alias for `force *`). There are
 * no per-player moves: each parenthesised group is a full team — the first group
 * is forced onto team 1 (ally 0), the second onto team 2 (ally 1); SPADS also
 * assigns ids sequentially within each group. One command sets the whole
 * arrangement atomically, so there is no window mid-balance for players to
 * shuffle (the old per-player `!force <name> team <N>` burst had one, and the
 * flood-control spacing made it seconds wide).
 *
 * Within each group players are listed by LOS, highest first (unrated = a
 * debutant, sorted by that effective value), so the SPADS ids are deterministic
 * and the strongest players get the low ids.
 *
 * `live` decides delivery: a `.balance` asked in the LOBBY really sends the
 * command (privately to the autohost — see `spadsWire`) and opens the composition
 * watcher's blackout on the teams it asks for, so the watcher cannot judge the
 * lobby against a change that is still in flight; a whispered `.balance` is a
 * PREVIEW — the command is whispered back and nothing reaches the host.
 */
function sendTeams(
  first: ReturnType<typeof balanceTeams>["teamA"],
  second: ReturnType<typeof balanceTeams>["teamB"],
  changed: number,
  live: boolean,
  reply: (msg: string) => void,
): boolean {
  if (changed === 0) {
    console.log("teams: the lobby already matches the suggestion — nothing to send");
    return false;
  }
  // Players highest LOS first inside each group.
  const group = (team: typeof first) =>
    [...team.players]
      .sort((x, y) => shownLos(y.rating) - shownLos(x.rating))
      .map((p) => p.name)
      .join(",");
  const cmd = `!fb (${group(first)})(${group(second)})`;
  console.log(
    `teams: ${changed} player${changed === 1 ? "" : "s"} ` +
      (live ? "changing side" : "would change side") +
      ` — ${cmd}`,
  );
  if (live) {
    send(spadsWire(cmd));
    lastForcedTeams = {
      first: first.players.map((p) => p.name.toLowerCase()),
      second: second.players.map((p) => p.name.toLowerCase()),
    };
    compWatcher.startBlackout(lastForcedTeams);
    return true;
  }
  // Preview: show the command to the asker instead of running it.
  status(`[dry-run] would send: ${spadsWire(cmd)}`);
  reply(cmd);
  return false;
}

// --- The matchup line waits for the teams to actually land ---
//
// The `!fb` and the "Lava OS: …" line used to go out in the same millisecond, so
// the bot stated an arrangement it had only ASKED for. Anything that stopped the
// force — SPADS refusing it (2026-09-07 23:18, `autoBlockBalance`), a drop, a
// half-apply — left that claim standing in the lobby as the teams about to be
// played, and the game launched on something else.
//
// So a live force now announces NOTHING until the composition watcher says the
// lobby has REACHED those teams (`teamsLanded`, the same test its blackout uses).
// It arrives ~200-420ms later. The three ways it can fail all say so instead: the
// host's refusal (`handleHostForceRejection`), the blackout expiring off-target
// (`onForceLost`), and a new force superseding this one. Nothing else changes —
// a whispered preview and a lobby that already matches announce immediately,
// because there is nothing in flight to wait for.

/** A live `!fb`'s matchup line, held until the lobby reaches those teams. */
let pendingAnnounce: { line: string; winFirst: number } | null = null;

/**
 * Say the held line: the lobby now REALLY has these teams. Always into battle
 * chat — only a LIVE balance holds a line, and every live path replies there
 * (`runBalance(battleReply, true, …)`); a whisper is a preview and never waits.
 */
function announceLandedTeams(): void {
  const pending = pendingAnnounce;
  if (pending === null) return;
  pendingAnnounce = null;
  // The teams landed, so whatever was in the way is not any more.
  autoBlockBalanceUnblockTried = false;
  console.log(pending.line);
  battleReply(pending.line);
  // The baseline is the arrangement the lobby HAS, which is only now known.
  compWatcher.setBaseline(pending.winFirst);
}

/** Drop the held line unsaid — the force did not take. */
function dropPendingAnnounce(why: string): void {
  if (pendingAnnounce === null) return;
  pendingAnnounce = null;
  status(`not announcing the matchup: ${why}`);
}

// --- Auto-balance (originally ported from the LavaBar Auto-Balance widget) ---
//
// `.lavatoggle` arms the automatic trigger; when the lobby reaches BALANCE_SIZE it
// runs the SAME machinery as a lobby `.balance` (our party-aware LOS balancer, live
// moves, announcement in battle chat). It had a `.lavastatus` companion — a
// party-blind preview of the balancer's split — which is gone: a whispered
// `.balance` is the same preview with parties, open to everyone.

/** Trigger threshold: balance when exactly this many non-spectator players are in. */
const BALANCE_SIZE = 16;
/** How often the auto-trigger re-checks the roster (the widget checked per frame). */
const BALANCE_POLL_MS = 5_000;

/**
 * OUR balancer's arming flag — NOT the lobby's `autoBalance` setting, and in
 * normal operation its INVERSE: `syncAutoBalanceWithLobby` arms us exactly when
 * the lobby's own autoBalance is "off", so that SPADS and the bot never shuffle
 * the same lobby. Published as `botCanAutobalance` (it spent a while published as
 * `autoBalance`, where it read as the lobby setting and meant the opposite).
 */
let autoBalance = false;
/**
 * Whether party splitting is enabled (`.splitparties on|off`, default on): when
 * even the best party-constrained split leaves one side's win chance above
 * PARTY_SPLIT_MAX_WIN, the parties are re-balanced individually. Off = parties
 * are always kept together, however imbalanced. A bot-level setting, not
 * per-battle — it survives lobby changes until toggled.
 */
let splitParties = true;
/** Set once a balance was issued; no re-balance until the battle changes. */
let balanced = false;
/** Last seen player count, so the auto-trigger only acts on changes. */
let lastPlayerCount = 0;

/**
 * Announcement channel. Live mode will send SAYBATTLEEX when the bot is boss and
 * plain SAYBATTLE otherwise; for now it only prints.
 */
function announce(msg: string): void {
  status(`[lavabar] ${msg}`);
}

/**
 * The wire line for a SPADS command. Delivery is a PRIVATE MESSAGE to the autohost
 * rather than battle chat, so moving players doesn't spam the lobby: SPADS accepts
 * its commands by PM (its `logPvChat` setting exists to log "private messages sent
 * to the AutoHost", and BYAR-Chobby PMs `!privatehost` to a host the same way).
 * Battle chat is only the fallback when we don't know the host's name. Either way
 * it must be plain SAYBATTLE/SAYPRIVATE — never SAYBATTLEEX, which SPADS does not
 * parse.
 */
function spadsWire(cmd: string): string {
  const founder =
    joinedBattleId !== null ? tracker.battles.get(joinedBattleId)?.snapshot().founder ?? "" : "";
  return founder ? sayPrivate(founder, cmd) : sayBattle(cmd);
}


/**
 * Members we KNOW are players: a CLIENTBATTLESTATUS has been seen for them and it
 * isn't a spectator. The `statusKnown` check matters — BATTLEOPENED adds the
 * founder to the roster before any status arrives, and a status-less entry defaults
 * to `spectator: false`, so counting it would inflate the roster by one (the host)
 * and an exact-count auto-trigger would never fire.
 */
function knownPlayers(): TrackedPlayer[] {
  const roster = joinedBattleId !== null ? tracker.roster(joinedBattleId) : null;
  return roster?.filter((p) => p.statusKnown && !p.spectator) ?? [];
}

/** Names of the joined battle's known players. */
function lobbyPlayers(): string[] {
  return knownPlayers().map((p) => p.name);
}

/**
 * Whether `name` is a boss of the joined battle. Read from the battle's BarManager
 * boss list directly rather than the roster, so it also works for someone with no
 * CLIENTBATTLESTATUS yet — including the bot itself, which is what decides between
 * plain and announce-style battle chat. Case-insensitive: the boss list is free
 * text from the host.
 */
function isBoss(name: string): boolean {
  if (joinedBattleId === null) return false;
  const bosses = tracker.battles.get(joinedBattleId)?.snapshot().bosses ?? [];
  return bosses.some((b) => b.toLowerCase() === name.toLowerCase());
}

/** .lavatoggle — flip auto-balance; enabling with a full lobby balances at once. */
function toggleAutoBalance(reply: (msg: string) => void): void {
  autoBalance = !autoBalance;
  announce(autoBalance ? "Auto-balance ENABLED" : "Auto-balance DISABLED");
  reply(`auto-balance ${autoBalance ? "enabled" : "disabled"}`);
  if (autoBalance) {
    lastPlayerCount = 0; // force a re-check
    autoBalanceTick(); // a lobby that is already full balances right away
  }
}

/**
 * The lobby's own autobalance setting drives ours: we balance only when the lobby
 * doesn't. The host announces `BattleStateChanged.autoBalance` unsolicited (see
 * Battle.applyBarManager), so "off" arms the bot exactly as `.lavatoggle` would and
 * anything else ("advanced", …) disarms it — otherwise SPADS and the bot would be
 * shuffling the same lobby against each other.
 *
 * `.lavatoggle` still flips the flag by hand, but the next setting CHANGE the host
 * announces re-asserts the lobby-derived value.
 */
let lastLobbySetting: string | null = null;

function syncAutoBalanceWithLobby(): void {
  const setting = lobbyAutoBalanceSetting();
  if (setting === null || setting === lastLobbySetting) return; // unknown or unchanged
  lastLobbySetting = setting;
  if (setting === "off" && forceRejectedByAutoBalance) {
    // A boss just turned it off for real: retry from scratch in this lobby.
    forceRejectedByAutoBalance = false;
    balanced = false;
    status('lobby autoBalance="off" — clearing the recorded !fb rejection');
  }
  const wanted = setting === "off";
  if (wanted === autoBalance) return;
  autoBalance = wanted;
  lastPlayerCount = 0; // re-check the roster on the next tick
  status(
    `lobby autoBalance="${setting}" → bot auto-balance ${wanted ? "ENABLED" : "DISABLED"}`,
  );
}

/** Reset the per-battle balance state (battle changed / connection dropped). */
function resetBalanceState(): void {
  balanced = false;
  lastPlayerCount = 0;
  // A different battle has its own autoBalance setting: forget the cached one so
  // the next broadcast re-syncs us (a new lobby must not inherit the old arming).
  lastLobbySetting = null;
  voteGuard = null;
  lastLiveBalanceAt = 0;
  // The composition watcher's baseline is per-lobby too: a new battle starts
  // unbaselined (nothing to compare against until the first .status/.balance).
  compWatcher.reset();
  lastForcedTeams = null;
  pendingGame = null;
  lastGameRunning = false;
  // A different lobby has its own autoBalance: a rejection latched in the old one
  // must not keep the bot from balancing here.
  forceRejectedByAutoBalance = false;
  lastForceRejection = null;
  pendingAnnounce = null;
  // The lock is per-lobby too, and a battle we are no longer in cannot be told
  // anything: `requestJoin` hands it back while we still can.
  lobbyAutoBlockBalance = null;
  autoBlockBalanceOffByUs = false;
  autoBlockBalanceUnblockTried = false;
  // Parties are per-lobby: a new battle must not inherit the old cache.
  partyCache = null;
}

// --- Start-vote guard ---
//
// SPADS launches a passed `!start` vote with whatever the teams look like AT THAT
// MOMENT — nothing invalidates the vote when players shuffle while it runs (checked
// against spads.pl: votes are cancelled only by !endvote, by the same command being
// run directly, or by the game actually launching). So a player can wait for the
// boss's arrangement, call `!cv start`, and jump teams mid-vote. The guard closes
// that hole: while a start vote is in progress (tracked from the host's BarManager
// onVoteStart/onVoteStop announces — see Battle.applyBarManager), any change to the
// team composition — someone left, joined as a player, or switched sides — makes
// the bot cancel the vote with `!ev` (SPADS's alias for `!endvote`), but ONLY when
// there is a fresh arrangement to protect: within BALANCE_PROTECT_MS of the last
// live `.balance`/auto-balance; otherwise the change just becomes the new baseline.
// Boss-gated
// like every other lobby-shaping action: without boss rights SPADS would ignore
// our `!ev`, so the bot only logs what it would have done.

/**
 * Ignore a tracked vote older than this: onVoteStop can be missed (disconnect,
 * dropped line), and a stale "vote in progress" must not keep the guard armed
 * forever. SPADS's voteTime is 45s (one re-call adds another round), so 2 minutes
 * comfortably outlives any real vote.
 */
const VOTE_GUARD_MAX_MS = 120_000;

/**
 * The guard protects a FRESH `.balance` arrangement, not any old lobby state: it
 * cancels only when the teams change within this long after the last LIVE balance
 * (the `!fb` really sent). A change later than that is accepted as the new
 * baseline instead — people reorganising a stale arrangement is not the exploit.
 */
const BALANCE_PROTECT_MS = 15_000;

/** When the last LIVE `.balance`/auto-balance was applied (0 = never). */
let lastLiveBalanceAt = 0;

/**
 * Armed while a start vote is in progress: the team composition when we first saw
 * the vote, when that was, and whether we already cancelled (once per vote).
 */
let voteGuard: { signature: string; sawAt: number; fired: boolean } | null = null;

/**
 * The protocol lines that can change what the guard watches: the vote lifecycle
 * (SAIDBATTLEEX carries the BarManager announces) and every roster/leave signal
 * the tracker consumes (see Battles.observe — REMOVEUSER and REMOVESCRIPTTAGS are
 * how most departures actually arrive).
 */
const VOTE_GUARD_CMDS = new Set([
  "SAIDBATTLEEX",
  "CLIENTBATTLESTATUS",
  "JOINEDBATTLE",
  "LEFTBATTLE",
  "REMOVEUSER",
  "REMOVESCRIPTTAGS",
]);

/** Is this voted command a vote to launch the game? (`start` / `forcestart`.) */
function isStartVote(command: string[]): boolean {
  return /^(force)?start$/i.test(command[0] ?? "");
}

/**
 * The joined battle's team composition as a comparable string: every known
 * non-spectator player with their ally team, name-sorted so arrival order doesn't
 * matter. Any join/leave/side-switch/spec-change alters it.
 */
function teamSignature(): string {
  return knownPlayers()
    .map((p) => `${p.name.toLowerCase()}:${p.ally}`)
    .sort()
    .join(",");
}

/** Human-readable diff of two team signatures, for the log/announce line. */
function describeTeamChange(before: string, after: string): string {
  const toMap = (sig: string) =>
    new Map(
      sig
        .split(",")
        .filter(Boolean)
        .map((entry) => {
          const i = entry.lastIndexOf(":");
          return [entry.slice(0, i), entry.slice(i + 1)] as const;
        }),
    );
  const was = toMap(before);
  const now = toMap(after);
  const parts: string[] = [];
  for (const [name, ally] of now) {
    if (!was.has(name)) parts.push(`${name} joined`);
    else if (was.get(name) !== ally) parts.push(`${name} switched team`);
  }
  for (const name of was.keys()) if (!now.has(name)) parts.push(`${name} left`);
  if (!parts.length) return "teams changed";
  return parts.slice(0, 4).join(", ") + (parts.length > 4 ? `, +${parts.length - 4} more` : "");
}

/**
 * Run after every roster/vote-relevant protocol line (behind the tracker queue, so
 * the tracked state already includes the line). Arms on a start vote, fires `!ev`
 * once if the teams change while it runs, disarms when the vote ends.
 */
function checkVoteGuard(): void {
  const vote =
    joinedBattleId !== null
      ? tracker.battles.get(joinedBattleId)?.voteInProgress ?? null
      : null;
  if (!vote || !isStartVote(vote.command)) {
    voteGuard = null;
    return;
  }
  if (voteGuard === null) {
    // First sight of this start vote: baseline the composition, don't fire — the
    // vote was called on these teams.
    voteGuard = { signature: teamSignature(), sawAt: Date.now(), fired: false };
    status(`start vote by ${vote.caller || "?"} — watching for team changes`);
    return;
  }
  if (voteGuard.fired || Date.now() - voteGuard.sawAt > VOTE_GUARD_MAX_MS) return;
  const sig = teamSignature();
  if (sig === voteGuard.signature) return;
  const change = describeTeamChange(voteGuard.signature, sig);
  if (Date.now() - lastLiveBalanceAt > BALANCE_PROTECT_MS) {
    // No fresh .balance to protect: accept the change as the new baseline (so a
    // later jump right after a mid-vote .balance is still caught) and stand down.
    status(
      `start vote: teams changed (${change}) but no .balance in the last ` +
        `${BALANCE_PROTECT_MS / 1000}s — not cancelling`,
    );
    voteGuard.signature = sig;
    return;
  }
  voteGuard.fired = true; // once per vote, whether or not we can act on it
  if (!botCanBalance(`start vote: teams changed (${change}) but not cancelling`)) return;
  status(`start vote in progress and teams changed (${change}) — sending !ev`);
  send(spadsWire("!ev"));
  battleReply(`Start vote cancelled: ${change}`);
}

// --- Composition watcher (auto-rebalance on a win-chance degrade) ---
//
// The state machine lives in `./compWatcher` — bot.ts opens a socket and starts
// timers at import, so nothing can import IT, and the 2026-09-07 storms were a
// state-machine bug. Its module comment documents the rules; here is only the
// wiring: the thresholds, the hooks that read the lobby, and the callers that
// re-baseline it (`.status`, a live `.balance`) or open its blackout (`sendTeams`).

/** Degrade threshold: |win−50| may grow by at most this many percentage points. */
const WIN_DEGRADE_PP = 10;

/**
 * Absolute threshold: rebalance a lobby further than this from even, whatever
 * the baseline says. 0 = EVERY composition change at a full lobby is
 * rebalanced (decided 2026-09-27) — whether the new arrangement is worth
 * sending is then decided by the dead band alone (MIN_REBALANCE_GAIN_PP).
 *
 * Was 20 (set in the 2026-09-07 storm aftermath), which left a full lobby at
 * anything up to 70/30 untouched: on 2026-09-27 a replacement took a slot in a
 * freshly balanced 8v8, the lobby read 53.6% and nothing happened. The storms
 * are stopped by the blackout, the dead band and the retry cooldown, not by
 * this number. At 0 it also subsumes the degrade rule.
 */
const ABS_UNFAIR_PP = 0;

/**
 * Rebalance only when the balancer's arrangement moves team 1's win chance by at
 * least this much: below it the reshuffle costs the lobby more than it buys.
 */
const MIN_REBALANCE_GAIN_PP = 1;

/** Trailing debounce after a composition change before re-estimating. */
const COMP_CHANGE_DEBOUNCE_MS = 100;

/** Hard cap on how long a live `!fb` silences the watcher. */
const BLACKOUT_MS = 3_000;

/** No automatic force for this long after one failed to land or was blocked. */
const FORCE_RETRY_COOLDOWN_MS = 30_000;

const compWatcher = new CompositionWatcher(
  {
    fullLobby: BALANCE_SIZE,
    degradePp: WIN_DEGRADE_PP,
    absUnfairPp: ABS_UNFAIR_PP,
    debounceMs: COMP_CHANGE_DEBOUNCE_MS,
    blackoutMs: BLACKOUT_MS,
    retryCooldownMs: FORCE_RETRY_COOLDOWN_MS,
  },
  {
    signature: () => (joinedBattleId !== null ? teamSignature() : ""),
    players: () => knownPlayers().map((p) => ({ name: p.name, ally: p.ally })),
    winChance: async (players) => {
      const ratings = await cachedLos(players.map((p) => p.name));
      return matchupLine(players, (name) => losOfName(ratings, name))?.winFirst ?? null;
    },
    gameInProgress: () => gameInProgress(),
    forceBlocked: forceTeamsBlocked,
    // The matchup line the last live force is holding: said when the lobby
    // arrives at those teams, dropped (with a word in chat) when it does not.
    onTeamsLanded: announceLandedTeams,
    onForceLost: () => {
      if (pendingAnnounce === null) return;
      dropPendingAnnounce("the lobby never reached the forced teams");
      battleReply("the teams I set did not take — the lobby still has the teams it had");
    },
    rebalance: (currentWin) =>
      runBalance(battleReply, true, {
        summarySuffix: " (rebalanced after comp change)",
        skipUnlessBetterThan: currentWin,
      }),
    status,
    onError: logError,
  },
);

/**
 * Say something in the battle chat — ALWAYS the announce form (SAYBATTLEEX, rendered
 * italic like a server/host notice rather than a player's line), boss or not, so
 * `.status` and `.balance` answers look the same. SPADS commands must NOT go through
 * here (SPADS doesn't parse SAYBATTLEEX); those go out through `spadsWire` instead.
 */
function battleReply(msg: string): void {
  send(sayBattleEx(msg));
}

/**
 * Whether the joined battle's game is currently RUNNING. Protocol convention
 * (see src/protocol/CLAUDE.md, CLIENTSTATUS): a battle is in-game when its founder/host is
 * in-game — the founder's global in-game bit, from the user directory. Unknown
 * founder/status reads as not in progress.
 */
function gameInProgress(): boolean {
  if (joinedBattleId === null) return false;
  const founder = tracker.battles.get(joinedBattleId)?.snapshot().founder ?? "";
  return founder !== "" && (tracker.users.get(founder)?.inGame ?? false);
}

// --- Payoff (did the balancing help?) ---
//
// See `./payoff`. Two triggers: the founder's in-game bit going up (the protocol's
// "the game launched" — captured here because the launch ROSTER is gone seconds
// later, players leave a running game) and the host's result announce.

/** The arrangement of the last live `!fb` in this lobby; null = none forced. */
let lastForcedTeams: WantedTeams | null = null;

/** The launch snapshot, waiting for the host's result. */
let pendingGame: GameStart | null = null;

/** The founder's in-game bit as of the last check, to spot the 0→1 edge. */
let lastGameRunning = false;

/**
 * Catch the moment the game starts and snapshot what actually launched — the
 * launch roster is gone seconds later, players leave a running game. Driven by
 * the FOUNDER's CLIENTSTATUS only (see the dispatch in `handleLine`; the command
 * is server-wide, so it is deliberately not in VOTE_GUARD_CMDS), behind the
 * tracker queue so the roster it reads is current.
 */
function watchGameLifecycle(): void {
  const running = gameInProgress();
  if (running === lastGameRunning) return;
  lastGameRunning = running;
  if (!running) {
    launchWatch = null;
    // The founder's in-game bit dropped: tell the Worker so the lobby page
    // stops showing the frozen roster (a fallback for the host's verdict,
    // which handleGameResult also relays). Deliberately does NOT touch
    // pendingGame — the payoff record still waits for the verdict, which
    // arrives after the founder leaves the game.
    if (joinedBattleId !== null) {
      void uplink.gameEnd({ battleId: joinedBattleId, endedAt: Date.now(), reason: "ingame-clear" });
    }
    return;
  }
  if (joinedBattleId === null) return;
  const battleId = joinedBattleId;
  const forced = lastForcedTeams;
  const predicted = compWatcher.baseline;
  pendingGame = captureGameStart(
    battleId,
    knownPlayers().map((p) => ({ name: p.name, ally: p.ally })),
    forced,
    predicted,
  );
  const launch = pendingGame;
  // Upload the launch roster to the Worker so the lobby page can show the
  // teams that are PLAYING while the lobby churns. The FULL tracked roster
  // (spectators included — the page lists them too), not knownPlayers().
  const snap = tracker.battles.get(battleId)?.snapshot();
  const upload: GameStartSnapshot = {
    battleId,
    startedAt: Date.now(),
    players: tracker.roster(battleId) ?? [],
    founder: snap?.founder ?? "",
    title: snap?.title ?? "",
    botBalanced: pendingGame.botBalanced,
    predictedFirstWin: pendingGame.predictedFirstWin,
  };
  void uplink.gameStart(upload);
  status(
    `game started with ${pendingGame.players.length} players ` +
      `(${pendingGame.botBalanced === null ? "the bot never forced teams here" : pendingGame.botBalanced ? "on the bot's teams" : "NOT on the bot's teams"})`,
  );
  // The tracked roster can hold ghosts — players who left without a leave
  // signal the bot saw (see confirmLaunchRoster). Watch the launch roster's
  // in-game bits from now on (watchLaunchInGame); once the clients have had
  // time to launch, drop the players whose bit never went up and re-upload.
  launchWatch = {
    battleId,
    upload,
    launch,
    forced,
    predicted,
    names: new Set(upload.players.map((p) => p.name.toLowerCase())),
    seen: new Set(),
    confirmed: false,
    shown: upload.players.length,
  };
  for (const p of upload.players) noteLaunchInGame(p.name);
  setTimeout(() => {
    const w = launchWatch;
    if (w === null || w.launch !== launch) return;
    w.confirmed = true;
    publishLaunchRoster(w);
  }, LAUNCH_CONFIRM_MS);
}

/**
 * The launch being confirmed (see watchGameLifecycle). `seen` = lowercased
 * names whose in-game bit has been up at ANY point since the launch, so a
 * player who launched and quit early still counts as having played.
 */
interface LaunchWatch {
  battleId: number;
  upload: GameStartSnapshot;
  launch: GameStart;
  forced: WantedTeams | null;
  predicted: number | null;
  names: Set<string>;
  seen: Set<string>;
  /** True once the confirm window passed (later changes re-upload at once). */
  confirmed: boolean;
  /** How many roster entries the last upload carried. */
  shown: number;
}
let launchWatch: LaunchWatch | null = null;

/** Record `name`'s in-game bit for the launch watch; true when it newly counts. */
function noteLaunchInGame(name: string): boolean {
  const w = launchWatch;
  const key = name.toLowerCase();
  if (w === null || !w.names.has(key) || w.seen.has(key)) return false;
  if (!(tracker.users.get(name)?.inGame ?? false)) return false;
  w.seen.add(key);
  return true;
}

/**
 * A CLIENTSTATUS for one of the launch roster's players: a player whose client
 * launched AFTER the confirm window (slow start) is put back on the roster.
 */
function watchLaunchInGame(name: string): void {
  const w = launchWatch;
  if (w === null) return;
  if (!lastGameRunning || joinedBattleId !== w.battleId || pendingGame !== w.launch) {
    launchWatch = null; // game over, moved on, or a newer launch
    return;
  }
  if (noteLaunchInGame(name) && w.confirmed) publishLaunchRoster(w);
}

/** Upload the launch roster minus the never-in-game players, when that changes it. */
function publishLaunchRoster(w: LaunchWatch): void {
  try {
    if (!lastGameRunning || joinedBattleId !== w.battleId || pendingGame !== w.launch) {
      launchWatch = null;
      return;
    }
    const roster =
      confirmLaunchRoster(w.upload.players, (n) => w.seen.has(n.toLowerCase())) ?? w.upload.players;
    if (roster.length === w.shown) return; // seen only grows: same length = same roster
    w.shown = roster.length;
    const players = roster.filter((p) => p.statusKnown && !p.spectator);
    pendingGame = captureGameStart(
      w.battleId,
      players.map((p) => ({ name: p.name, ally: p.ally })),
      w.forced,
      w.predicted,
    );
    w.launch = pendingGame;
    void uplink.gameStart({ ...w.upload, players: roster, botBalanced: pendingGame.botBalanced });
    const missing = w.upload.players.filter((p) => !roster.includes(p)).map((p) => p.name);
    status(
      `launch roster: ${players.length} players` +
        (missing.length ? `; never went in game: ${missing.join(", ")}` : "; all went in game"),
    );
  } catch (e) {
    logError("launch roster confirmation failed", e);
  }
}

/** The host's result announces (SAIDBATTLEEX), e.g. `* Ally team 0 won! (a, b, …)`. */
const ALLY_WON_RE = /^\*\s*Ally team (\d+) won!/;
const UNDECIDED_TEXT = "Game result undecided";

/**
 * Close the payoff record on the host's verdict. One `[payoff]` line per game,
 * then the snapshot is dropped — a second announce for the same game (the host
 * repeats itself on occasion) must not log twice.
 */
function handleGameResult(from: string, text: string): void {
  if (!isFounder(from)) return;
  const won = ALLY_WON_RE.exec(text);
  if (won === null && !text.includes(UNDECIDED_TEXT)) return;
  // Relay the game-over to the Worker BEFORE the pendingGame guard: a verdict
  // seen after a bot restart (no snapshot to close) must still unfreeze the
  // lobby page's roster.
  if (joinedBattleId !== null) {
    void uplink.gameEnd({ battleId: joinedBattleId, endedAt: Date.now(), reason: "result" });
  }
  if (pendingGame === null) return;
  status(describePayoff(pendingGame, { winnerAlly: won === null ? null : Number(won[1]) }));
  pendingGame = null;
}

/** Whether `name` is the battle's founder/host (from BATTLEOPENED, via the tracker). */
function isFounder(name: string): boolean {
  if (joinedBattleId === null) return false;
  const founder = tracker.battles.get(joinedBattleId)?.snapshot().founder ?? "";
  return founder !== "" && founder.toLowerCase() === name.toLowerCase();
}

/**
 * Battle-chat commands: `.status` is open to everyone (same global cooldown as the
 * whispered form); a `!start` / `!cv start` from anyone also triggers a `.status`
 * into the battle chat (the teams being voted on go on record);
 * `.lavatoggle` needs a lobby BOSS or a BOT_ADMIN. Everything the bot answers, it
 * answers in the battle chat.
 *
 * Chat from players who are loaded into a running game arrives RELAYED by the host
 * (`SAIDBATTLE <host> "<player> msg"`), so that form is unwrapped — but only when
 * the speaker really is the battle's founder, otherwise anyone could impersonate a
 * boss by typing "<bossname> .lavatoggle" in plain chat.
 */
function handleBattleCommand(from: string, text: string): void {
  // Never react to our own chat — the server echoes back everything we say, and
  // a reply that re-triggered a command would loop.
  if (from.toLowerCase() === username.toLowerCase()) return;
  let cmd = text.trim();
  const relay = cmd.match(/^<(\S+)>\s+(.*)$/);
  if (relay && isFounder(from)) {
    from = relay[1];
    cmd = relay[2].trim();
  }
  // Someone calling !start (or the equivalent !cv start — SPADS turns a plain
  // !start into a start vote anyway): print the current lobby status into the
  // battle chat, so the teams being voted on are on record. An automatic
  // trigger, so it honours the cooldown (repeated votes must not spam), plus
  // the usual min-player gate.
  if (/^!(cv\s+)?start\b/i.test(cmd)) {
    void tryRunStatus(`${from} (!start)`, battleReply, { auto: true });
    return;
  }
  if (!cmd.startsWith(".")) return;
  if (cmd === ".status") {
    // Asked in battle chat → answered in battle chat. This is the one thing the
    // bot says out loud: read-only info. Everything the balancer would DO to the
    // lobby is gated on the boss checks in balanceAllowed.
    void tryRunStatus(from, battleReply);
    return;
  }
  // .balance is boss-only on both sides. Asked in the LOBBY it runs for real: the
  // players are moved and the resulting status is announced here (SAYBATTLEEX, since
  // balanceAllowed already required the bot to be a boss). A refusal is announced
  // too, with the reason — a silent .balance reads as the bot being broken.
  if (cmd === ".balance") {
    if (balanceAllowed(from, battleReply)) void runBalance(battleReply, true);
    return;
  }
  // `.bot` in the LOBBY is the point of the command: the introduction is FOR the
  // lobby, so it is said out loud where everyone reading the chat sees it. Open to
  // everyone and uncapped, like `.help` here — it costs no lookup, and a bot that
  // ignores the question "what are you" reads as broken. Each ask picks its own
  // wording (blurb.ts), so a second one in the same lobby is not the same line.
  if (cmd === ".bot") {
    battleReply(botBlurb());
    return;
  }
  // `.scout <player>` in the LOBBY answers in the lobby — scouting the other team
  // is a lobby conversation. Shares the .status cooldown window so a burst of
  // asks cannot flood the chat.
  if (cmd === ".scout" || cmd.startsWith(".scout ")) {
    const now = Date.now();
    if (now - lastBattleScoutRun < STATUS_COOLDOWN_MS) return;
    lastBattleScoutRun = now;
    void handleScoutCommand(cmd.slice(".scout".length).trim(), battleReply);
    return;
  }
  // A login link said in the battle chat would log in whoever clicks it first.
  if (cmd === ".login" || cmd === ".logout") {
    battleReply(`website login is by whisper — whisper me ${cmd}`);
    return;
  }
  // The avoid commands are whisper-only: who someone avoids is between them and
  // the bot, so the lobby form says where to type it and shows nobody's list.
  if (AVOID_COMMANDS.has(cmd)) {
    battleReply("avoid lists are set by whisper — whisper me .avoid");
    return;
  }
  // `.help` in the LOBBY answers with ONE line pointing at the whisper — the full
  // listing is a dozen lines, which a shared chat doesn't want.
  if (cmd === ".help") {
    battleReply(`whisper me .help for the command list — ${SITE_URL}`);
    return;
  }
  // .lavatoggle and .splitparties change how the bot balances, so in the battle
  // chat both take a boss or an admin (same gate; a non-boss asking is only logged,
  // like every other unknown lobby command staying silent).
  const words = cmd.split(/\s+/);
  if (words[0] !== ".lavatoggle" && words[0] !== ".splitparties") return;
  if (!admins.has(from.toLowerCase()) && !isBoss(from)) {
    status(`ignoring battle command from non-boss/non-admin ${from}: ${cmd}`);
    return;
  }
  if (words[0] === ".splitparties") {
    handleSplitParties(words[1]?.toLowerCase(), battleReply);
    return;
  }
  // Asked in battle chat → answered in battle chat, like `.status`: it used to
  // report through `status()`, so its whole output landed in a log file, which
  // reads as a broken bot to the lobby.
  toggleAutoBalance(battleReply);
}

/**
 * Auto-balance trigger. The widget re-checked in its Update loop; the bot polls the
 * tracker instead. When armed and the lobby reaches exactly BALANCE_SIZE players it
 * runs the SAME machinery as a lobby `.balance` — our party-aware balancer, live
 * moves, and the announcement in battle chat — once per battle.
 */
function autoBalanceTick(): void {
  syncAutoBalanceWithLobby();
  syncAutoBlockBalance();
  if (!autoBalance || balanced || joinedBattleId === null) return;
  const count = lobbyPlayers().length;
  if (count === lastPlayerCount) return;
  lastPlayerCount = count;
  if (count !== BALANCE_SIZE) return;
  if (!botCanBalance("auto-balance skipped")) return;
  balanced = true; // once per battle; reset by resetBalanceState()
  announce(`lobby full (${BALANCE_SIZE} players) — balancing`);
  void runBalance(battleReply, true);
}

setInterval(autoBalanceTick, BALANCE_POLL_MS);

// --- Idle lobby finder ---
//
// A logged-in bot in NO battle (its rejoin target gone, the join failed, the lobby
// closed under it) looks for one to join: every IDLE_LOBBY_POLL_MS it scrapes
// Teiserver's web lobby index and joins the lobby pickIdleLobby selects — a
// "lava" + "unranked" lobby on IDLE_LOBBY_MAP with IDLE_LOBBY_MIN_PLAYERS+
// players (src/bot/idleLobby.ts). Nothing happens while a join is pending or
// while the bot is in a battle, so this never fights `.join` / the autojoin; a
// join that fails (JOINBATTLEFAILED) just leaves it idle for the next tick.
// Needs the Teiserver web session (BOT_TEISERVER_EMAIL) — without it the finder
// is off.

const IDLE_LOBBY_POLL_MS = 60_000;
let idleLobbyLookupInFlight = false;

/**
 * Consecutive lobby-index reads (made while in a battle) that did not list our
 * battle. A backstop for a missed BATTLECLOSED (e.g. the lobby closed while a
 * reconnect was in flight): MISSING_FROM_INDEX_LIMIT misses in a row and the
 * battle is treated as gone. One miss is not enough — a lobby can briefly drop
 * out of the index while its host reconnects.
 */
let missingFromIndex = 0;
const MISSING_FROM_INDEX_LIMIT = 2;

/** In a battle: check that Teiserver's lobby index still lists it. */
async function checkJoinedBattleListed(): Promise<void> {
  const id = joinedBattleId;
  if (!teiserverWeb || id === null) return;
  await teiserverWeb.ensureLogin();
  const index = parseLobbyIndex(await teiserverWeb.authedFetch("/battle/lobbies"));
  // An empty index is far likelier a scrape problem than no lobbies at all.
  if (joinedBattleId !== id || index.size === 0) return;
  if (index.has(id)) {
    missingFromIndex = 0;
    return;
  }
  missingFromIndex++;
  status(`battle ${id} not in the lobby index (${missingFromIndex}/${MISSING_FROM_INDEX_LIMIT})`);
  if (missingFromIndex >= MISSING_FROM_INDEX_LIMIT) battleGone(id, "not in the lobby index");
}

async function idleLobbyTick(): Promise<void> {
  if (!teiserverWeb || !loggedIn || sock === null) return;
  if (pendingBattleId !== null || idleLobbyLookupInFlight) return;
  idleLobbyLookupInFlight = true;
  try {
    if (joinedBattleId !== null) {
      await checkJoinedBattleListed();
      return;
    }
    await teiserverWeb.ensureLogin();
    const index = [...parseLobbyIndex(await teiserverWeb.authedFetch("/battle/lobbies")).values()];
    // Re-check: a `.join` or a reconnect may have happened during the fetch.
    if (!loggedIn || joinedBattleId !== null || pendingBattleId !== null) return;
    const picked = pickIdleLobby(index);
    if (!picked) {
      status(
        `idle: no open lava+unranked lobby on ${IDLE_LOBBY_MAP} with ` +
          `${IDLE_LOBBY_MIN_PLAYERS}+ players (${index.length} lobbies listed)`,
      );
      return;
    }
    status(`idle: joining battle ${picked.id} "${picked.name}" (${picked.playerCount} players)`);
    requestJoin(picked.id, null);
  } catch (e) {
    logError("idle lobby lookup failed", e);
  } finally {
    idleLobbyLookupInFlight = false;
  }
}

setInterval(() => void idleLobbyTick(), IDLE_LOBBY_POLL_MS);

/**
 * .status — print the current lobby's players (spectators skipped) with their LOS,
 * grouped by the lobby's CURRENT teams (team 1 first, then team 2, ...): the
 * roster comes from the bot's own SessionTracker (the same state machine the
 * Worker runs), the ratings from the LOS lookup API. Output goes to stdout;
 * internal errors are logged, and the asker only gets a generic notice.
 *
 * Every run that produces a head-to-head summary re-baselines the composition
 * watcher's win chance.
 */
/**
 * Above this many points off 50/50, a reported matchup that the bot cannot fix
 * says why. 2026-10-12: battle 867 launched at 7.6% vs 92.4% — the bot was not a
 * boss, so it could neither rebalance after `!balance` nor stop the start vote,
 * and its matchup line gave nobody a reason to think it could have.
 */
const NOT_BOSS_HINT_PP = 10;

/**
 * The tail appended to a reported matchup when it is lopsided and the ONLY thing
 * keeping the bot from fixing it is that it is not a boss (the lobby's own
 * autoBalance is off, so the bot would otherwise be the balancer). Empty otherwise:
 * a lobby that balances itself, or a fair matchup, needs no explanation.
 */
function notBossHint(winFirst: number): string {
  if (Math.abs(winFirst - 50) <= NOT_BOSS_HINT_PP) return "";
  if (joinedBattleId === null || isBoss(username)) return "";
  if (autoBalanceBlocksForce() !== null) return "";
  return ` - I can't fix these teams, I'm not a boss here`;
}

async function runStatus(reply: (msg: string) => void): Promise<void> {
  try {
    if (joinedBattleId === null) {
      reply(".status: not in a battle");
      return;
    }
    // Keep the party cache warm for the next .balance (background, not awaited).
    refreshParties();
    // Let any just-observed lines finish applying before reading the roster.
    await trackerQueue;
    const roster = tracker.roster(joinedBattleId);
    if (!roster) {
      reply(`.status: no tracked state for battle ${joinedBattleId} yet`);
      return;
    }
    const players = knownPlayers();
    if (!players.length) {
      status(`status: battle ${joinedBattleId} has no players`);
      reply(`.status: battle ${joinedBattleId} has no players (yet?)`);
      return;
    }

    const ratings = await cachedLos(players.map((p) => p.name));
    const ratingOf = (name: string) => losOfName(ratings, name);

    // Group by the lobby's current ally team, ascending (team 1 first, then team 2).
    const teams = [...new Set(players.map((p) => p.ally))].sort((a, b) => a - b);
    const nameWidth = Math.max(...players.map((p) => p.name.length));
    const scoreText = (name: string) => {
      const r = ratingOf(name);
      return r ? shownLos(r).toFixed(1) : "-";
    };
    const scoreWidth = Math.max(1, ...players.map((p) => scoreText(p.name).length));
    status(`status: battle ${joinedBattleId}, ${players.length} players`);
    for (const team of teams) {
      // Ally numbers in the battle-status bitfield are 0-based; display 1-based
      // ("team 1"/"team 2"), matching the in-game lobby UI.
      console.log(`team ${team + 1}:`);
      for (const p of players.filter((x) => x.ally === team)) {
        console.log(`  ${p.name.padEnd(nameWidth)} ${scoreText(p.name).padStart(scoreWidth)}`);
      }
    }
    // Head-to-head summary of the CURRENT lobby state. To stdout AND back to
    // whoever asked (whisper → SAYPRIVATE, battle chat → battle chat).
    const summary = matchupLine(players, ratingOf);
    if (summary) {
      const text = summary.text + notBossHint(summary.winFirst);
      console.log(text);
      reply(text);
      compWatcher.setBaseline(summary.winFirst);
    }
  } catch (e) {
    // Internal errors (LOS lookup down, a bug, ...) are logged in full — stack and
    // cause chain — and NEVER echoed to players: the reply is a generic notice.
    logError(".status failed", e);
    reply(".status: unavailable right now, try again later");
  }
}

// --- Connection lifecycle ---

const PING_INTERVAL_MS = 30_000;
const BACKOFF_START_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;

let sock: Socket | null = null;
/** LOGININFOEND seen on the current connection (JOINBATTLE is only valid after it). */
let loggedIn = false;
let pingTimer: NodeJS.Timeout | null = null;
let backoffMs = BACKOFF_START_MS;
let stopping = false;

// Redact the password hash in the LOGIN line (word 2 after the command) before logging.
function redact(line: string): string {
  if (!line.startsWith("LOGIN ")) return line;
  const tok = line.split(" ");
  if (tok.length > 2) tok[2] = "***";
  return tok.join(" ");
}

// Local lobby awareness: THE same SessionTracker state machine the Worker's
// Dispatcher runs over this very stream (src/tracker.ts), fed both directions —
// so the bot's view of who is in the lobby can never diverge from the Worker's.
// observe() is async (the Dispatcher awaits persistence hooks in it), so calls are
// chained to keep strict line order — exactly like the Dispatcher's batch loop.
const tracker = new SessionTracker(username);
let trackerQueue: Promise<unknown> = Promise.resolve();
function track(src: "client" | "server", msg: string): void {
  const env = { ts: Date.now(), src, msg };
  trackerQueue = trackerQueue.then(() => tracker.observe(env));
}

function send(line: string): void {
  // Raw protocol traffic goes to the daily log file only (see fileLog); stdout is
  // reserved for status lines, chat, and errors.
  fileLog("→", redact(line));
  track("client", line);
  sock?.write(line + "\n");
}

function handleLine(line: string): void {
  fileLog("←", line);
  track("server", line);
  const m = parseMessage(line);
  // Roster lines warm the LOS cache: a debounced background prefetch of any
  // uncached/stale ratings, so commands later run without a lookup wait.
  if (m.cmd === "JOINEDBATTLE" || m.cmd === "CLIENTBATTLESTATUS") scheduleLosPrefetch();
  // Vote/roster-relevant lines re-check the start-vote guard once the tracker has
  // applied them (the check is chained behind the same queue track() feeds; a
  // guard failure is logged and must never poison that shared queue).
  if (VOTE_GUARD_CMDS.has(m.cmd)) {
    trackerQueue = trackerQueue.then(() => {
      try {
        checkVoteGuard();
        compWatcher.observe();
      } catch (e) {
        logError("start-vote guard failed", e);
      }
    });
  }
  // A game starting reaches us as the FOUNDER's global in-game bit (the protocol's
  // battle-in-game convention). CLIENTSTATUS is server-wide — 100,785 lines in one
  // day, 38% of all traffic — and says nothing about team composition, so it is
  // deliberately NOT in VOTE_GUARD_CMDS: only our own host's line is followed up.
  // While a launch roster is being confirmed, its players' own in-game bits.
  if (m.cmd === "CLIENTSTATUS" && launchWatch?.names.has((m.words[0] ?? "").toLowerCase())) {
    const who = m.words[0] ?? "";
    trackerQueue = trackerQueue.then(() => {
      try {
        watchLaunchInGame(who);
      } catch (e) {
        logError("launch roster watcher failed", e);
      }
    });
  }
  if (m.cmd === "CLIENTSTATUS" && isFounder(m.words[0] ?? "")) {
    trackerQueue = trackerQueue.then(() => {
      try {
        watchGameLifecycle();
      } catch (e) {
        logError("game lifecycle watcher failed", e);
      }
    });
  }
  if (m.cmd === "ADDUSER") noteAddUser(m);
  if (handleChat(m)) return;
  // Raw inbound lines are NOT echoed to stdout (they're in the log file). The one
  // exception is server feedback text — SERVERMSG, e.g. "No incomming match" for a
  // malformed command — which is reported as a status line.
  if (m.cmd === "SERVERMSG") status(`server: ${trailingText(m, 0)}`);
  switch (m.cmd) {
    case "TASSERVER":
      send(
        login({
          username,
          passwordHash,
          lobbyName: "lavabalance-bot 0.1.0",
          compatFlags: "b sp",
          userId: lobbyHash,
        }),
      );
      break;
    case "ACCEPTED":
      status(`logged in as ${m.words[0] ?? username}`);
      backoffMs = BACKOFF_START_MS;
      // Also log into Teiserver's web (HTTP) API. Async and non-blocking: the
      // protocol loop keeps running while the login round-trips.
      webLogin();
      break;
    case "DENIED": {
      // Credentials are wrong (or the account is banned) — retrying won't help, so
      // this is a FATAL exit (FATAL_EXIT_CODE, the one code the supervisor doesn't
      // restart). Say so explicitly: the container supervisor only sees "the
      // process died", and this line is the explanation next to it.
      const reason = [...m.words, ...m.sentences].join(" ");
      logEvent("error", `FATAL: login denied, exiting with code ${FATAL_EXIT_CODE}`, {
        reason,
        username,
        hint:
          "Check BOT_LOGIN / BOT_PASSWORD (the plaintext password; a trailing newline from a piped " +
          "secret also fails). Not retrying.",
      });
      stopping = true;
      sock?.destroy();
      process.exit(FATAL_EXIT_CODE);
      break;
    }
    case "LOGININFOEND": {
      // Login fully done (fires on every connection, so a reconnect rejoins too).
      // Prefer the battle we were actually in this process life; the boot-time
      // BOT_AUTOJOIN_ROOM (resolved by the supervisor: last battle, else the main
      // lobby) covers the first login and the JOINBATTLEFAILED fallback below.
      // Sweep pending friend requests: the reply's FRIENDREQUESTLIST lines are
      // each accepted below (a fresh login is the only time we could have
      // missed requests sent while offline).
      loggedIn = true;
      send(friendRequestList());
      const target = lastJoinedBattleId ?? autojoinRoom;
      if (target !== null) {
        status(
          `autojoining battle ${target} ` +
            (lastJoinedBattleId !== null ? "(last joined)" : "(BOT_AUTOJOIN_ROOM)"),
        );
        requestJoin(target, null);
      }
      break;
    }
    case "PING":
      send(pong());
      break;
    case "JOINBATTLE": {
      // Server confirmation that we're in: JOINBATTLE <battleId> <hashCode>.
      const id = Number(m.words[0]);
      joinedBattleId = Number.isInteger(id) ? id : pendingBattleId;
      if (joinedBattleId !== null) lastJoinedBattleId = joinedBattleId;
      pendingBattleId = null;
      missingFromIndex = 0;
      resetBalanceState();
      status(`joined battle ${joinedBattleId} as spectator`);
      send(myBattleStatus()); // spectator bit set (SPECTATOR_STATUS default)
      if (pendingRequester) send(sayPrivate(pendingRequester, `joined battle ${joinedBattleId}`));
      pendingRequester = null;
      break;
    }
    case "JOINBATTLEFAILED": {
      const failedId = pendingBattleId;
      const wasAutomatic = pendingRequester === null;
      const reason = [...m.words, ...m.sentences].join(" ");
      status(`join battle ${failedId} failed: ${reason}`);
      if (pendingRequester) send(sayPrivate(pendingRequester, `join failed: ${reason}`));
      pendingBattleId = null;
      pendingRequester = null;
      // An automatic rejoin of a battle that is gone (closed while we were
      // disconnected) falls back to the boot-time room once; forgetting the dead
      // id keeps this from looping if the fallback fails too.
      if (
        wasAutomatic &&
        failedId !== null &&
        failedId === lastJoinedBattleId &&
        autojoinRoom !== null &&
        autojoinRoom !== failedId
      ) {
        lastJoinedBattleId = null;
        status(`falling back to battle ${autojoinRoom} (BOT_AUTOJOIN_ROOM)`);
        requestJoin(autojoinRoom, null);
      }
      break;
    }
    case "FRIENDREQUESTLIST": {
      // One pending incoming request: FRIENDREQUESTLIST userName=<name>. (The
      // block's FRIENDREQUESTLISTBEGIN/END wrapper lines parse as their own
      // cmds and are ignored.) The bot befriends anyone who asks.
      const arg = m.words[0] ?? "";
      const eq = arg.indexOf("=");
      const name = eq === -1 ? "" : arg.slice(eq + 1);
      if (name) {
        status(`accepting friend request from ${name}`);
        send(acceptFriendRequest(name));
      }
      break;
    }
    case "S.USER.NEW_INCOMING_FRIEND_REQUEST":
      // Live push while online — it carries only the requester's account id, so
      // re-query the request list and let the FRIENDREQUESTLIST lines above do
      // the accepting (no id→name resolution needed).
      send(friendRequestList());
      break;
    case "BATTLECLOSED": {
      // BATTLECLOSED <battleId> — every lobby on the server; only ours matters.
      const id = Number(m.words[0]);
      if (Number.isInteger(id)) battleGone(id, "closed");
      break;
    }
    case "LEFTBATTLE": {
      // LEFTBATTLE <battleId> <userName> — only our own departure matters here.
      if ((m.words[1] ?? "").toLowerCase() === username.toLowerCase()) {
        status(`left battle ${m.words[0]}`);
        joinedBattleId = null;
        resetBalanceState();
      }
      break;
    }
  }
}

function openConnection(): void {
  const buf = new LineBuffer();
  status(`connecting to ${host}:${port} as ${username}`);
  const s = netConnect({ host, port }, () => {
    status("connected, waiting for greeting");
  });
  sock = s;
  s.setEncoding("utf8");
  s.on("data", (chunk: string) => {
    for (const line of buf.push(chunk)) handleLine(line);
  });
  s.on("error", (err) => logError("socket error", err));
  s.on("close", () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    sock = null;
    loggedIn = false;
    // A fresh connection starts outside any battle.
    pendingBattleId = null;
    pendingRequester = null;
    joinedBattleId = null;
    resetBalanceState();
    if (stopping) return;
    status(`disconnected, reconnecting in ${backoffMs / 1000}s`);
    setTimeout(openConnection, backoffMs);
    backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP_MS);
  });
  pingTimer = setInterval(() => send(ping()), PING_INTERVAL_MS);
}

// Ctrl-C on a laptop, SIGTERM from the container supervisor (Cloudflare sends
// SIGTERM on stop/rollout, then SIGKILL after a grace period).
function shutdown(signal: string): void {
  stopping = true;
  status(`shutting down (${signal})`);
  if (pingTimer) clearInterval(pingTimer);
  sock?.destroy();
  commandsLog.end();
  botLog.end();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Health endpoint (container only — BOT_HEALTH_PORT is set in the Dockerfile): the
// BotContainer supervisor waits for this port to come up after starting the
// container and reads it for GET /bot/status. Plain node:http, JSON only.
// Also accepts POST /join {"battle": <id>} — the HTTP twin of the .join whisper,
// relayed from the Worker's POST /bot/join (BotContainer.joinLobby). Only the
// supervisor can reach this port (nothing routes external HTTP to the container),
// so the bearer auth lives on the Worker side.
const healthPort = Number(process.env.BOT_HEALTH_PORT || 0);
if (healthPort > 0) {
  const answer = (res: ServerResponse, code: number, body: Record<string, unknown>) =>
    res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
  createHttpServer((req, res) => {
    if (req.url === "/join" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 4096) req.destroy(); // no reason for a bigger body
      });
      req.on("end", () => {
        let id: number;
        try {
          id = Number((JSON.parse(raw) as { battle?: unknown }).battle);
        } catch {
          id = NaN;
        }
        if (!Number.isInteger(id) || id < 0) {
          answer(res, 400, { ok: false, error: "body must be {\"battle\": <non-negative integer>}" });
          return;
        }
        if (sock === null) {
          answer(res, 409, { ok: false, error: "not connected to the lobby server" });
          return;
        }
        if (joinedBattleId === id) {
          answer(res, 200, { ok: true, battle: id, alreadyJoined: true });
          return;
        }
        status(`join battle ${id} requested over HTTP`);
        requestJoin(id, null); // async: the JOINBATTLE reply lands in /health's battle field
        answer(res, 202, { ok: true, requested: id });
      });
      return;
    }
    if (req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        ok: true,
        username,
        connected: sock !== null,
        battle: joinedBattleId,
        pendingBattle: pendingBattleId,
        webLogin: teiserverWeb ? teiserverWeb.hasSession() : null,
        // The LOBBY's own setting, verbatim from the host's last BarManager
        // broadcast ("off" / "advanced" / …; null = not broadcast yet). This is
        // the thing people mean by "is autoBalance on?".
        lobbyAutoBalance: lobbyAutoBalanceSetting(),
        // The LOBBY's balanceMode, verbatim from the same broadcast ("clan;skill" /
        // "skill" / "random"; null = not broadcast yet), and what it means for our
        // balancer: we always balance on LOS, the mode only decides whether party
        // members are kept on one team.
        lobbyBalanceMode: lobbyBalanceModeSetting(),
        botKeepsParties: lobbyKeepsParties(),
        // OUR balancer's arming flag, which is the INVERSE: the bot balances only
        // when the lobby's own autoBalance is off. It used to be published as
        // `autoBalance`, which read as the lobby setting and meant its opposite.
        botCanAutobalance: autoBalance,
        // null when the bot can set teams; otherwise why it cannot.
        forceTeamsBlocked: forceTeamsBlocked(),
        boss: joinedBattleId !== null && isBoss(username),
        balancedThisBattle: balanced,
        lastPlayerCount,
      }),
    );
  }).listen(healthPort, () => status(`health endpoint on :${healthPort}/health`));
}

openConnection();
