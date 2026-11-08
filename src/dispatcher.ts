// Dispatcher — a single Durable Object holding the persisted runtime config
// (lava_lobbies, the auto-pick throttle) and a `SessionTracker` view of the lobby
// protocol, fed with observed lines `{ ts, src: "client" | "server", msg }`.
//
// Nothing uploads lines to it in production anymore: the TCP proxy / bot uplink
// WebSocket tap (`/dispatcher/ws`) was removed when the bot moved into its own
// container and became the lobby client itself. `ingest()` remains as a direct
// RPC (used by the workers tests to drive the tracker pipeline); the `src=proxy`
// lobby view therefore stays empty in production until the bot feeds it.
//
// There is exactly one Dispatcher instance (idFromName("singleton")). The control
// plane reads its state by calling the public methods directly over RPC.

import { DurableObject } from "cloudflare:workers";
import { Battle, type ObservedMessage } from "./battle";
import { SessionTracker } from "./tracker";
import { DEFAULT_CONFIG, parseConfig, type LavabalanceConfig } from "./config";

/** Durable Object storage key under which the runtime config JSON is persisted. */
const CONFIG_KEY = "config";
/** Storage key of the epoch millis of the last auto-pick lookup (see claimAutoPick). */
const AUTO_PICK_KEY = "autoPickAt";

/** One observed protocol line (`src` says which side sent it). */
type ProxyMessage = ObservedMessage;

/** Max unrouted messages retained in memory. Not persisted. */
const OBSERVED_CAP = 1000;
const OBSERVED_DEFAULT_LIMIT = 100;

export class Dispatcher extends DurableObject<Env> {
  /** In-memory ring buffer of UNROUTED messages (oldest first). Not persisted. */
  /** Messages that route to a battle are logged on that battle instead. */
  private observed: ProxyMessage[] = [];
  /** Running total of unrouted messages (the buffer is capped). */
  private observedTotal = 0;
  /** epoch millis of the last observed message (routed or not). */
  private lastActivity = 0;
  /**
   * THE session state machine — the exact same `SessionTracker` the Node bot runs
   * over its own connection (src/tracker.ts), so the two can never drift apart. It
   * owns the LOGIN-learned session account, the user directory, self-membership,
   * and battle routing; this DO adds only Worker concerns around it (persisting the
   * lava set via the hooks, the unrouted buffer).
   */
  private readonly tracker: SessionTracker;
  /** Cached runtime config; lazily loaded from storage on first access. */
  private config?: LavabalanceConfig;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Seed the tracker with the configured bot name (refined the moment the observed
    // stream's own LOGIN is seen), and hook the lava-set changes into the persisted
    // config so a DO eviction doesn't lose which lobbies are tracked.
    this.tracker = new SessionTracker((env.BOT_USERNAME ?? "").trim(), {
      addLavaLobby: (id) => this.addLavaLobby(id),
      removeLavaLobby: (id) => this.removeLavaLobby(id),
    });
  }

  /** The battle registry lives on the shared tracker. */
  private get battles() {
    return this.tracker.battles;
  }

  /**
   * Public RPC: feed observed protocol lines, in order. Returns how many were
   * accepted (malformed envelopes are dropped and logged). This is the only way
   * lines reach the tracker now (the WebSocket tap is gone); the workers tests use
   * it to drive the pipeline.
   */
  async ingest(messages: ProxyMessage[]): Promise<number> {
    let accepted = 0;
    for (const m of messages) {
      if (await this.handleObserved(m)) accepted++;
    }
    return accepted;
  }

  /**
   * Process one observed protocol line: updates the user directory, ensures config
   * is loaded, auto-manages lava_lobbies from the bot's own membership, then routes
   * the line to its battle (or the Dispatcher's unrouted buffer). False if dropped.
   */
  private async handleObserved(env: ProxyMessage): Promise<boolean> {
    if (!env || typeof env.msg !== "string" || (env.src !== "client" && env.src !== "server")) {
      console.error(`[dispatcher] dropping malformed envelope: ${JSON.stringify(env)?.slice(0, 200)}`);
      return false;
    }
    this.lastActivity = Date.now();
    // Make sure the configured lava lobbies are loaded into the battle tracker before
    // routing (survives DO eviction, where in-memory config is lost).
    await this.loadConfig();
    // Run THE shared session pipeline (src/tracker.ts — identical in the bot):
    // LOGIN-learned session account, user directory, self-membership (persisted via
    // our hooks), and battle routing. Messages that don't apply to any battle are
    // recorded here in the Dispatcher's unrouted buffer.
    const battleId = await this.tracker.observe(env);
    if (battleId === null) {
      this.record(env);
    }
    return true;
  }

  // ---- Public RPC surface (called directly by the Worker control plane) ----

  /**
   * Observation status for a single battle: its state snapshot (`battleState`, null
   * if that battle isn't currently tracked). `unrouted` counts messages that didn't
   * map to any configured battle.
   */
  status(battle: string) {
    const id = Number(battle);
    const one = Number.isFinite(id) ? this.battles.get(id)?.snapshot() ?? null : null;
    return {
      battle,
      unrouted: this.observedTotal,
      trackedBattles: this.battles.size,
      battleState: one,
      lastActivity: this.lastActivity || null,
    };
  }

  /**
   * Lobby LIST for the UI's index page: each tracked battle with its lobby status and
   * players (skill + rank attached from their global directories). Ratings are not
   * attached by any source anymore — the detail route (/api/lobbies/:id) resolves LOS
   * for the one lobby it shows and applies it via finalizeLobby.
   *
   * `all` returns every tracked battle (not just the configured lava lobbies).
   */
  async lobbies(all = false) {
    const source = all ? this.battles.all() : this.battles.lava();
    return source.map((b) => this.mapLobby(b, b.snapshot()));
  }

  /**
   * One lobby (by id) for the UI's detail page. Returns null when the id isn't an
   * open lobby (honoring the lava filter unless `all`). LOS ratings are layered on
   * by the route, not here.
   */
  async lobby(id: number, all = false) {
    const source = all ? this.battles.all() : this.battles.lava();
    const b = source.find((x) => x.battleId === id);
    if (!b) return null;
    return this.mapLobby(b, b.snapshot());
  }

  /**
   * Map a battle snapshot into the `lobbies()` API shape. The roster/user merge is
   * the tracker's shared `players()` (identical for the bot).
   */
  private mapLobby(b: Battle, s: ReturnType<Battle["snapshot"]>) {
    const players = this.tracker.players(b, s);
    return {
      battleId: s.battleId,
      founder: s.founder,
      title: s.title,
      map: s.map,
      gameName: s.gameName,
      engineVersion: s.engineVersion,
      maxPlayers: s.maxPlayers,
      passworded: s.passworded,
      locked: s.locked,
      // Shape parity with src=teiserver: a battle is in-game when its founder is
      // (per the protocol); the elapsed time / balance algorithm / party grouping
      // aren't in the protocol stream this view rebuilds, so they stay null.
      inProgress: players.some((p) => p.name === s.founder && p.inGame),
      inProgressSec: null as number | null,
      balanceAlgorithm: null as string | null,
      spectatorCount: s.spectatorCount,
      // The lobby's SPADS balanceMode ("clan;skill" / "skill" / "random"), from the
      // host's BarManager broadcast; null until it arrives. The other sources cannot
      // see it (it is not on Teiserver's pages nor in the public bar-rts API).
      balanceMode: s.balanceMode,
      bosses: s.bosses,
      playerCount: s.playerCount,
      players: players.map((p) => ({ ...p, party: null as string | null })),
    };
  }

  /** Add a battle id to the persisted lava_lobbies (idempotent) and start tracking it. */
  private async addLavaLobby(id: number): Promise<void> {
    const cfg = await this.loadConfig();
    if (cfg.lava_lobbies.includes(id)) return;
    await this.applyConfig({ ...cfg, lava_lobbies: [...cfg.lava_lobbies, id] });
    console.log(`[dispatcher] auto-added battle ${id} to lava_lobbies (self joined)`);
  }

  /** Remove a battle id from the persisted lava_lobbies (idempotent) and stop tracking it. */
  private async removeLavaLobby(id: number): Promise<void> {
    const cfg = await this.loadConfig();
    if (!cfg.lava_lobbies.includes(id)) return;
    await this.applyConfig({ ...cfg, lava_lobbies: cfg.lava_lobbies.filter((x) => x !== id) });
    console.log(`[dispatcher] auto-removed battle ${id} from lava_lobbies (self left)`);
  }

  /** Persist a config, cache it, and push lava_lobbies into the tracker. */
  private async applyConfig(cfg: LavabalanceConfig): Promise<void> {
    await this.ctx.storage.put(CONFIG_KEY, cfg);
    this.config = cfg;
    this.tracker.setLavaLobbies(cfg.lava_lobbies);
  }

  /** Read the persisted runtime config (defaults when nothing has been set). */
  async getConfig(): Promise<LavabalanceConfig> {
    return this.loadConfig();
  }

  /**
   * Validate and persist the runtime config (the whole JSON object), returning the
   * normalized config. Throws if the payload is malformed; the error propagates to
   * the RPC caller (the control plane), which turns it into a 400.
   */
  async setConfig(input: unknown): Promise<LavabalanceConfig> {
    const cfg = parseConfig(input);
    await this.applyConfig(cfg);
    return cfg;
  }

  /**
   * Rate limiter for the "no lava lobby configured → pick one from Teiserver" lookup
   * (src/autoLobby.ts). Returns true — and records `now` — when at least `minIntervalMs`
   * have passed since the last claim (or none was ever made); false otherwise. The DO is
   * single-threaded, so the check-and-set is atomic and the limit holds across every
   * Worker isolate. `now` is injectable for tests.
   */
  async claimAutoPick(minIntervalMs: number, now = Date.now()): Promise<boolean> {
    const last = (await this.ctx.storage.get<number>(AUTO_PICK_KEY)) ?? 0;
    if (now - last < minIntervalMs) return false;
    await this.ctx.storage.put(AUTO_PICK_KEY, now);
    return true;
  }

  private async loadConfig(): Promise<LavabalanceConfig> {
    if (!this.config) {
      this.config = (await this.ctx.storage.get<LavabalanceConfig>(CONFIG_KEY)) ?? DEFAULT_CONFIG;
      this.tracker.setLavaLobbies(this.config.lava_lobbies);
    }
    return this.config;
  }

  /**
   * Most-recent-first slice of the message log, newest-first. `limit` defaults to
   * 100, max 1000. A numeric `battle` returns that battle's own log (empty if it's
   * not currently tracked); any non-numeric value returns the Dispatcher's unrouted
   * buffer (e.g. `/battles/unrouted/log`).
   */
  log(battle: string, limit?: number) {
    const lim =
      Number.isFinite(limit) && (limit as number) > 0
        ? Math.min(Math.floor(limit as number), OBSERVED_CAP)
        : OBSERVED_DEFAULT_LIMIT;

    const id = Number(battle);
    if (Number.isFinite(id)) {
      const b = this.battles.get(id);
      const res = b ? b.readLog(lim) : { total: 0, count: 0, entries: [] };
      return { battle, ...res };
    }

    const start = Math.max(0, this.observed.length - lim);
    const entries = this.observed.slice(start).reverse();
    return { battle, total: this.observedTotal, count: entries.length, entries };
  }

  private record(env: ProxyMessage): void {
    this.observedTotal++;
    this.observed.push(env);
    if (this.observed.length > OBSERVED_CAP) {
      this.observed.splice(0, this.observed.length - OBSERVED_CAP);
    }
  }
}
