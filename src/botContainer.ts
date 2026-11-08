// BotContainer — the Node bot (src/bot/bot.ts) hosted in a Cloudflare Container,
// supervised by this Durable Object (the @cloudflare/containers `Container` class
// IS a DO). The container image (./Dockerfile) runs `tsx src/bot/bot.ts` — the
// same process `pnpm run bot` starts on a laptop — with its credentials handed in
// as environment variables from the Worker's vars/secrets.
//
// Why a container and not the bot-as-a-DO (src/lavaBot.ts, since removed): a
// resident Durable Object is billed 128 MB of duration for every second it stays
// alive, while a `lite` container instance runs the unmodified Node bot for a
// fraction of that. See CLAUDE.md "The bot (BotContainer)".
//
// Keeping it running WITHOUT incoming requests — nothing routes HTTP to this
// container, so four things together keep it up:
//   1. `desired.running` is persisted in DO storage (POST /bot/start|stop).
//   2. `onActivityExpired()` is overridden to renew instead of stopping: the
//      package's default implementation stops the container `sleepAfter` after
//      the last request, which for us would be forever.
//   3. The Worker's cron trigger (`triggers`, cloudflare.config.ts) calls
//      `ensureRunning()` every few minutes, which restarts the bot after ANY
//      stop while the intent says "run" — a deploy's image rollout killing the
//      instance, a crash, a platform restart (Cloudflare guarantees no instance
//      lifetime). So after a deploy the bot is back within one cron interval;
//      `POST /bot/restart` (`pnpm run bot:kick`) bounces it sooner by hand.
// The bot exposes GET /health on HEALTH_PORT (node:http in bot.ts, port set by the
// Dockerfile): Cloudflare requires an exposed port, `startAndWaitForPorts` uses
// it to know the process is really up, and /bot/status reads it.

import { Container, getContainer } from "@cloudflare/containers";
import type { StopParams } from "@cloudflare/containers";
import { resolveAutoJoinBattle } from "./autoLobby";

/** The single supervisor instance (one bot account = one lobby session). */
export const BOT_CONTAINER_NAME = "bot";

/** Persisted intent — survives eviction/restarts; the cron consults it. */
interface DesiredState {
  running: boolean;
}

/** Persisted diagnostics: the last stop and the last start failure (survive eviction). */
export interface LastStop {
  at: string;
  exitCode: number;
  reason: string;
}

const DESIRED_KEY = "desired";
const LAST_STOP_KEY = "lastStop";
const LAST_ERROR_KEY = "lastError";
/**
 * The battle the bot was last in (persisted — the container's own memory dies
 * with it). Written whenever a status read or a join sees the bot in a battle;
 * read at container start to rejoin it (see ensureRunning / resolveAutoJoinBattle).
 */
const LAST_BATTLE_KEY = "lastBattle";

/** The bot's health port inside the container (Dockerfile: ENV BOT_HEALTH_PORT / EXPOSE). */
const HEALTH_PORT = 8080;

/** How long restartBot waits for the SIGTERMed instance to actually exit. */
const RESTART_STOP_WAIT_MS = 20_000;

/**
 * The one exit code the bot uses for genuinely fatal conditions (login DENIED,
 * missing/invalid configuration) — must match FATAL_EXIT_CODE in src/bot/bot.ts
 * (not imported: bot.ts is Node-only and outside the Worker's tsconfig). Any
 * OTHER non-zero exit (a crash, an OOM kill, a rollout's SIGKILL after the
 * grace period) is restartable, and treating it as fatal used to leave the bot
 * dead after deploys until a manual POST /bot/start.
 */
const FATAL_EXIT_CODE = 42;

export interface BotContainerStatus {
  /** Whether the bot is meant to be running (persisted intent). */
  running: boolean;
  /** The container instance's actual state, as the platform reports it. */
  status: string;
  exitCode?: number;
  lastStartedAt?: string;
  lastStop: LastStop | null;
  /**
   * Why the bot isn't running when it should be: the last start failure, or a
   * fatal exit that switched `running` off (e.g. "login denied"). Cleared by start.
   */
  lastError: string | null;
  /** The bot process's own GET /health answer (null when not running / unreachable). */
  bot: Record<string, unknown> | null;
  /** The battle the bot was last seen in (persisted) — the restart rejoin target. */
  lastBattle: number | null;
}

/** joinLobby's outcome: whether the bot accepted the join, plus the fresh status. */
export interface JoinLobbyResult {
  ok: boolean;
  error?: string;
  status: BotContainerStatus;
}

export class BotContainer extends Container<Env> {
  /** The bot's health endpoint; startAndWaitForPorts() waits for it. */
  override defaultPort = HEALTH_PORT;
  /** The idle timer never stops us (see onActivityExpired); keep it long anyway. */
  override sleepAfter = "1h";
  /** The bot needs plain TCP to the lobby server (:8200) + HTTPS to Teiserver/LOS. */
  override enableInternet = true;

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    // Credentials/config for src/bot/bot.ts (it reads process.env; the .env file
    // it would otherwise load doesn't exist in the image).
    this.envVars = {
      BOT_LOGIN: env.BOT_USERNAME,
      BOT_PASSWORD: env.BOT_PASSWORD ?? "",
      BOT_ADMINS: env.BOT_ADMINS ?? "",
      BOT_AUTOJOIN_ROOM: env.BOT_AUTOJOIN_ROOM ?? "",
      BOT_TEISERVER_EMAIL: env.TEISERVER_EMAIL ?? "",
      BOT_LAVAOS_URL: env.BOT_LAVAOS_URL ?? "",
      // The bot writes players' avoid lists through /api/avoids, which is
      // behind the control token when the deployment sets one.
      BOT_CONTROL_TOKEN: env.CONTROL_TOKEN ?? "",
      // The .login/.logout calls go through Cloudflare Access (/api/bot/*):
      // the bot's service token.
      BOT_ACCESS_CLIENT_ID: env.ACCESS_BOT_CLIENT_ID ?? "",
      BOT_ACCESS_CLIENT_SECRET: env.ACCESS_BOT_CLIENT_SECRET ?? "",
    };
  }

  // ---- Public RPC (control plane + cron) ----

  /** Persist "running" (clearing any previous failure) and start the container if it isn't up. */
  async startBot(): Promise<BotContainerStatus> {
    await this.ctx.storage.put<DesiredState>(DESIRED_KEY, { running: true });
    await this.ctx.storage.delete(LAST_ERROR_KEY);
    return this.ensureRunning();
  }

  /**
   * Persist "running" and restart the container: stop the current instance (if
   * any), wait for it to actually exit, then start fresh. This is what the
   * post-deploy kick calls (POST /bot/restart). A plain startBot() is a no-op
   * while an instance is still up, and right after `cf deploy` the
   * still-running instance is the PRE-rollout one — the kick then reported
   * "healthy" against the old container, the rollout killed it seconds later,
   * and the bot stayed down until the next cron tick. Stopping first guarantees
   * the start lands on a freshly created instance (the newly deployed image).
   */
  async restartBot(): Promise<BotContainerStatus> {
    await this.ctx.storage.put<DesiredState>(DESIRED_KEY, { running: true });
    await this.ctx.storage.delete(LAST_ERROR_KEY);
    if (await this.isUp()) {
      console.log("bot container: restart — stopping the current instance");
      await this.stop();
      // stop() only signals. Wait (bounded) for the process to really exit —
      // otherwise the start path would see a still-running container and no-op.
      const deadline = Date.now() + RESTART_STOP_WAIT_MS;
      while (this.ctx.container?.running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (this.ctx.container?.running) {
        console.warn("bot container: restart — instance still up after SIGTERM wait");
      }
      // A second stop() is a no-op signal-wise (the process is gone) but flushes
      // the pending stopped event into the package's persisted state, so
      // ensureRunning's isUp() check below sees the instance as down.
      await this.stop();
    }
    return this.ensureRunning();
  }

  /** Persist "stopped" and SIGTERM the container (the cron then leaves it alone). */
  async stopBot(): Promise<BotContainerStatus> {
    await this.ctx.storage.put<DesiredState>(DESIRED_KEY, { running: false });
    if (await this.isUp()) await this.stop();
    return this.botStatus();
  }

  /**
   * Start the container if the persisted intent says it should be running and it
   * isn't. Called by /bot/start and by the cron trigger; a no-op while stopped
   * on purpose. Never throws: a start failure (e.g. the process died before its
   * health port came up) is recorded as `lastError` and shown in the status.
   */
  async ensureRunning(): Promise<BotContainerStatus> {
    const desired = await this.getDesired();
    if (desired.running && !(await this.isUp())) {
      // Rejoin where the bot left off: resolve the auto-join target (the persisted
      // last battle while Teiserver still lists it, else the main lava lobby) and
      // hand it to the process as BOT_AUTOJOIN_ROOM — the bot joins that room after
      // EVERY login (LOGININFOEND), so restarts and reconnects both land there.
      // this.envVars is read by the package at container start, so setting it here
      // (before startAndWaitForPorts) applies to the instance being started. With
      // nothing resolved the static BOT_AUTOJOIN_ROOM var (constructor) stays.
      const autojoin = await resolveAutoJoinBattle(this.autoJoinDeps(), await this.getLastBattle());
      if (autojoin !== null) {
        console.log(`bot container: autojoin target is battle ${autojoin}`);
        this.envVars = { ...this.envVars, BOT_AUTOJOIN_ROOM: String(autojoin) };
      }
      console.log("bot container: starting");
      try {
        await this.startAndWaitForPorts();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`bot container: start failed: ${msg}`);
        // A fatal exit (onStop) may already have recorded the real reason; keep it.
        if (!(await this.ctx.storage.get<string>(LAST_ERROR_KEY))) {
          await this.ctx.storage.put(LAST_ERROR_KEY, `start failed: ${msg}`);
        }
      }
    }
    return this.botStatus();
  }

  /**
   * Tell the bot process to join a battle (the HTTP twin of the .join whisper):
   * relays POST /join to the bot's health server. The join itself is async on the
   * lobby protocol — a 202 from the bot means "JOINBATTLE sent"; the outcome shows
   * up in botStatus().bot (battle / pendingBattle). Returns {ok:false, error} when
   * the container is down or the bot refuses (not connected, bad id).
   */
  async joinLobby(battle: number): Promise<JoinLobbyResult> {
    if (!(await this.isUp())) {
      return { ok: false, error: "the bot container is not running", status: await this.botStatus() };
    }
    let ok = false;
    let error: string | undefined;
    try {
      const res = await this.containerFetch(
        "http://bot/join",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ battle }),
        },
        HEALTH_PORT,
      );
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      ok = res.ok && body?.ok === true;
      if (!ok) error = body?.error ?? `bot answered ${res.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    // An accepted join is the freshest "last battle" there is — record the intent
    // now rather than waiting for a status poll to observe the JOINBATTLE outcome.
    if (ok) await this.rememberBattle(battle);
    return { ok, error, status: await this.botStatus() };
  }

  async botStatus(): Promise<BotContainerStatus> {
    const [desired, state, lastStop, lastError] = await Promise.all([
      this.getDesired(),
      this.getState(),
      this.ctx.storage.get<LastStop>(LAST_STOP_KEY),
      this.ctx.storage.get<string>(LAST_ERROR_KEY),
    ]);
    const up = state.status === "running" || state.status === "healthy";
    const bot = up ? await this.botHealth() : null;
    // Every status read doubles as the lastBattle recorder: the .join whisper and
    // the auto-join both happen inside the bot process, and this is where the
    // supervisor sees the result (the admin page polls 5s, the cron every 5 min).
    if (bot && typeof bot.battle === "number") await this.rememberBattle(bot.battle);
    return {
      running: desired.running,
      status: state.status,
      exitCode: "exitCode" in state ? state.exitCode : undefined,
      lastStartedAt: state.lastChange ? new Date(state.lastChange).toISOString() : undefined,
      lastStop: lastStop ?? null,
      lastError: lastError ?? null,
      bot,
      lastBattle: await this.getLastBattle(),
    };
  }

  // ---- Lifecycle hooks ----

  override onStart(): void {
    console.log("bot container: started");
  }

  /**
   * The bot exits with FATAL_EXIT_CODE only for conditions it cannot fix by
   * restarting (login DENIED — wrong password / banned account — or missing
   * credentials). In that case switch the persisted intent off, so the cron does
   * not retry a bad login against Teiserver every 5 minutes; `lastError` says
   * why, and POST /bot/start re-arms it once the secret is fixed. EVERY other
   * stop — a clean exit, a platform-initiated stop (`runtime_signal`, e.g. an
   * image rollout), and any other non-zero exit (a crash, an OOM kill, a
   * SIGKILL after the rollout grace period) — leaves the intent alone and the
   * cron restarts the bot. (Matching any non-zero exit here used to misread
   * deploy rollouts as fatal and leave the bot down until a manual start.)
   */
  override async onStop({ exitCode, reason }: StopParams): Promise<void> {
    await this.ctx.storage.put<LastStop>(LAST_STOP_KEY, {
      at: new Date().toISOString(),
      exitCode,
      reason,
    });
    console.log(`bot container: stopped (exit ${exitCode}, ${reason})`);
    if (reason === "exit" && exitCode === FATAL_EXIT_CODE) {
      const msg =
        `bot exited with code ${exitCode} (fatal — login denied or missing ` +
        `credentials); not restarting until POST /bot/start. Check the container logs.`;
      console.error(`bot container: ${msg}`);
      await this.ctx.storage.put<DesiredState>(DESIRED_KEY, { running: false });
      await this.ctx.storage.put(LAST_ERROR_KEY, msg);
      return;
    }
    // Any other stop leaves the intent alone; the cron's next ensureRunning()
    // restarts the bot. (An onStop-scheduled self-restart via the package's
    // schedule()/alarm used to live here — it did not actually bring the bot
    // back after deploys, so it was removed.)
  }

  override onError(error: unknown): void {
    console.error(`bot container: error: ${error instanceof Error ? error.message : String(error)}`);
  }

  /**
   * The package would stop the container `sleepAfter` after the last request —
   * and nothing ever sends this container a request. Renew instead, so the bot
   * runs until stopBot() (or the platform) stops it.
   */
  override async onActivityExpired(): Promise<void> {
    this.renewActivityTimeout();
  }

  // ---- Helpers ----

  /** GET /health from the bot process; null if it doesn't answer (never throws). */
  private async botHealth(): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.containerFetch("http://bot/health", { method: "GET" }, HEALTH_PORT);
      return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private async isUp(): Promise<boolean> {
    const { status } = await this.getState();
    return status === "running" || status === "healthy";
  }

  private async getDesired(): Promise<DesiredState> {
    return (await this.ctx.storage.get<DesiredState>(DESIRED_KEY)) ?? { running: false };
  }

  private async getLastBattle(): Promise<number | null> {
    return (await this.ctx.storage.get<number>(LAST_BATTLE_KEY)) ?? null;
  }

  /** Persist the battle the bot is (or is about to be) in; write only on change. */
  private async rememberBattle(battle: number): Promise<void> {
    if (!Number.isInteger(battle) || battle < 0) return;
    if ((await this.getLastBattle()) !== battle) {
      console.log(`bot container: last battle is now ${battle}`);
      await this.ctx.storage.put(LAST_BATTLE_KEY, battle);
    }
  }

  /** The Dispatcher/TeiserverDO pair resolveAutoJoinBattle consults (the same
   *  singletons the Worker routes use). */
  private autoJoinDeps() {
    return {
      dispatcher: this.env.DISPATCHER.get(this.env.DISPATCHER.idFromName("singleton")),
      teiserver: this.env.TEISERVER.get(this.env.TEISERVER.idFromName("singleton")),
    };
  }
}

/** The supervisor stub (the one instance named BOT_CONTAINER_NAME). */
export function botContainerStub(env: Env) {
  return getContainer<BotContainer>(env.BOT_CONTAINER, BOT_CONTAINER_NAME);
}
