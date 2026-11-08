// SessionTracker — THE lobby-session state machine, shared verbatim by the Worker's
// Dispatcher DO and the Node bot so the two can never drift apart.
//
// It owns the full observation pipeline for one observed session's protocol stream
// (an ObservedMessage per line, both directions):
//   1. learn the session's account from its own `c LOGIN <name>` line,
//   2. global user directory upkeep (SETSCRIPTTAGS skills, CLIENTSTATUS),
//   3. self-membership: the session's own JOINEDBATTLE/LEFTBATTLE manages the
//      tracked (lava) lobby set — with the implicit-leave rule for a direct
//      re-join — via pluggable hooks so the Dispatcher can persist the set,
//   4. routing/battle state via `Battles` (rosters, leave signals, logs).
//
// It also owns the roster/user merge (`players()`): battle-specific facts from the
// roster snapshot + room-independent ones (skill, rank, in-game, away) from the
// user directory — the one shape both the Dispatcher API and the bot consume.
//
// Pure TypeScript: no `cloudflare:*`, no `node:*` — runs in workerd and Node alike.

import { Battle, Battles, type ObservedMessage } from "./battle";
import { UserRepository } from "./user";
import { parseMessage } from "./protocol/framing";
import {
  parseClientStatus,
  parseJoinedBattle,
  parseLeftBattle,
  parseSetScriptTags,
} from "./protocol/events";

/** One roster entry: the shared battle-snapshot × user-directory merge. */
export interface TrackedPlayer {
  name: string;
  skill: number | null;
  rank: number | null;
  inGame: boolean;
  away: boolean;
  ready: boolean;
  spectator: boolean;
  sync: number;
  ally: number;
  team: number;
  boss: boolean;
  statusKnown: boolean;
}

/**
 * Pluggable side effects for the tracked-lobby set. When provided (the Dispatcher),
 * the callee owns applying the change — persisting it and pushing the new set back
 * in via `setLavaLobbies` (so a stored config and the live set stay one thing).
 * When absent (the bot), the tracker applies the change to an internal in-memory
 * set itself. The DECISIONS (what to add/remove and when) are made here either way.
 */
export interface SessionTrackerHooks {
  addLavaLobby?: (id: number) => void | Promise<void>;
  removeLavaLobby?: (id: number) => void | Promise<void>;
}

export class SessionTracker {
  /** Per-battle state; routes the observed stream. */
  readonly battles: Battles;
  /**
   * Global per-account directory of room-independent details (rank, skill/OS,
   * in-game, away), keyed by lowercased name.
   */
  readonly users = new UserRepository();
  /**
   * The account name of the observed session, learned from its `c LOGIN <name>`
   * line. Falls back to the constructor-provided name until a LOGIN is seen.
   */
  private sessionUser = "";
  private readonly fallbackSelf: string;
  /** In-memory lava set, used only when no hooks manage it externally. */
  private readonly localLava = new Set<number>();

  constructor(selfName = "", private readonly hooks: SessionTrackerHooks = {}) {
    this.fallbackSelf = selfName;
    this.battles = new Battles(selfName);
  }

  /** Externally-managed lava-lobby set (the Dispatcher's persisted config). */
  setLavaLobbies(ids: number[]): void {
    this.battles.setLavaLobbies(ids);
  }

  currentBattleId(): number | null {
    return this.battles.currentBattleId();
  }

  /**
   * Process one observed protocol line — the ONE pipeline both the Dispatcher and
   * the bot run. Returns the battle id the line routed to, or null (caller may
   * record it as unrouted).
   */
  async observe(env: ObservedMessage): Promise<number | null> {
    // Learn whose session we are observing from its own LOGIN line. Ground truth
    // for both the proxy tap and the bot uplink; beats any statically configured
    // name (which may belong to a different account than the one streaming).
    this.noteSessionLogin(env);
    // Maintain the global user directory from the SETSCRIPTTAGS (skill/OS) and
    // CLIENTSTATUS (rank, in-game, away) streams. Room-independent facts, so
    // they're kept here rather than on any one battle's roster.
    this.noteSkill(env.msg);
    this.noteClientStatus(env.msg);
    // When the session's own account joins/leaves a battle, manage the tracked
    // lobby set. (Must run before routing so the joined battle is already
    // configured when the triggering JOINEDBATTLE is routed.)
    await this.handleSelfMembership(env.msg);
    // Route the message to the battle it concerns; it's recorded on that battle.
    return this.battles.observe(env);
  }

  /**
   * The shared roster/user merge for one battle, ordered by OS (skill) high→low so
   * consumers list players in that order; unknown skills sort last (stable).
   */
  players(b: Battle, s: ReturnType<Battle["snapshot"]> = b.snapshot()): TrackedPlayer[] {
    return s.players
      .map((p) => {
        const u = this.users.get(p.name);
        return {
          name: p.name,
          skill: u?.skill ?? null,
          rank: u?.rank ?? null,
          inGame: u?.inGame ?? false,
          away: u?.away ?? false,
          ready: p.ready,
          spectator: p.spectator,
          sync: p.sync,
          ally: p.ally,
          team: p.team,
          boss: b.isBoss(p.name),
          statusKnown: p.statusKnown,
        };
      })
      .sort((a, b) => (b.skill ?? -Infinity) - (a.skill ?? -Infinity));
  }

  /**
   * The roster of `id` (default: the battle the session is currently in), or null
   * when that battle isn't tracked / the session isn't in one.
   */
  roster(id: number | null = this.currentBattleId()): TrackedPlayer[] | null {
    if (id === null) return null;
    const b = this.battles.get(id);
    return b ? this.players(b) : null;
  }

  /**
   * Auto-manage the tracked lobby set from the session's own membership. The bot
   * can only be in one battle at a time; the server normally sends a LEFTBATTLE
   * for the old battle before the next join, but a direct JOINBATTLE while still
   * in a battle (observed in the wild) gets no LEFTBATTLE — leaving the old id
   * stuck in the set forever (a phantom lobby) and letting strangers' joins to it
   * hijack routing. So our own join implicitly leaves the previous battle first.
   */
  private async handleSelfMembership(line: string): Promise<void> {
    const me = this.sessionUser || this.fallbackSelf;
    if (!me) return;
    const m = parseMessage(line);
    if (m.cmd === "JOINEDBATTLE") {
      const e = parseJoinedBattle(m);
      if (e && e.userName === me && Number.isFinite(e.battleId)) {
        const prev = this.battles.currentBattleId();
        if (prev !== null && prev !== e.battleId) await this.removeLava(prev);
        await this.addLava(e.battleId);
      }
    } else if (m.cmd === "LEFTBATTLE") {
      const e = parseLeftBattle(m);
      if (e && e.userName === me && Number.isFinite(e.battleId)) {
        await this.removeLava(e.battleId);
      }
    }
  }

  private async addLava(id: number): Promise<void> {
    if (this.hooks.addLavaLobby) return this.hooks.addLavaLobby(id);
    this.localLava.add(id);
    this.battles.setLavaLobbies([...this.localLava]);
  }

  private async removeLava(id: number): Promise<void> {
    if (this.hooks.removeLavaLobby) return this.hooks.removeLavaLobby(id);
    this.localLava.delete(id);
    this.battles.setLavaLobbies([...this.localLava]);
  }

  /**
   * Learn the observed session's account from its own `c LOGIN <name>` line (no-op
   * otherwise). Client-sent only — a server line can't be the session logging in.
   */
  private noteSessionLogin(env: ObservedMessage): void {
    if (env.src !== "client") return;
    const m = parseMessage(env.msg);
    if (m.cmd !== "LOGIN") return;
    const name = (m.words[0] ?? "").trim();
    if (!name || name === this.sessionUser) return;
    this.sessionUser = name;
    this.battles.setSelfName(name);
    console.log(`[session] observed session logs in as ${name}`);
  }

  /**
   * Update each user's skill (OS) from a SETSCRIPTTAGS line (no-op otherwise). The
   * server already lowercases SETSCRIPTTAGS keys, so the names reconcile with
   * real-case roster names via the repository's case-insensitive keying.
   */
  private noteSkill(line: string): void {
    const tags = parseSetScriptTags(parseMessage(line));
    if (!tags) return;
    for (const [name, skill] of tags.skills) this.users.noteSkill(name, skill);
  }

  /**
   * Update a user's global status (rank, in-game, away) from a CLIENTSTATUS line
   * (no-op otherwise). A server-wide broadcast, not battle-scoped.
   */
  private noteClientStatus(line: string): void {
    const e = parseClientStatus(parseMessage(line));
    if (!e) return;
    this.users.noteClientStatus(e);
  }
}
