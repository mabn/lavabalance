// Battle state tracking.
//
// `Battle` holds the live state of a single lobby battle: the players currently in
// it (with their decoded battle-status) and the lobby's own status (host, map,
// locked, spectator count). `Battles` is the registry the Dispatcher drives: it
// routes each observed protocol line to the battle it concerns, but ONLY for the
// configured "lava lobbies" (battle ids). Lines that don't concern a configured
// battle are not applied — the caller drops/logs them.
//
// Everything here is transport-agnostic and does no I/O: the Dispatcher feeds it the
// proxied protocol stream line by line.

import { parseMessage, type ParsedMessage } from "./protocol/framing";
import {
  parseBattleOpened,
  parseClientBattleStatus,
  parseJoinedBattle,
  parseLeftBattle,
  parseRemoveScriptTags,
  parseRemoveUser,
  parseSaidBattleEx,
  parseSetScriptTags,
  parseUpdateBattleInfo,
  parseUpdateLobbyTitle,
  type BattleOpened,
  type ScriptTags,
} from "./protocol/events";
import { decodeBattleStatus } from "./protocol/battleStatus";

/** One observed protocol line plus its proxy-envelope metadata, recorded per battle. */
export interface ObservedMessage {
  /** epoch millis when the proxy observed the line. */
  ts: number;
  /** which side sent it: the lobby client, or the lobby server. */
  src: "client" | "server";
  /** one raw protocol line (no trailing newline), unparsed. */
  msg: string;
}

/** Max observed messages retained per battle (in memory, not persisted). */
const BATTLE_LOG_CAP = 10;

/**
 * A SPADS vote in progress, from the host's BarManager `onVoteStart` /
 * `currentVote` announces (cleared by `onVoteStop`).
 */
export interface VoteInProgress {
  /** The voted command's tokens, e.g. ["start"] or ["forceStart"]. */
  command: string[];
  /** Who called the vote ("" when the payload doesn't say). */
  caller: string;
}

/** One player currently in a battle, with their decoded battle-status. */
export interface Player {
  name: string;
  /** Raw CLIENTBATTLESTATUS bitfield; 0 until a status has been observed. */
  battleStatus: number;
  teamColor: number;
  /** True once a CLIENTBATTLESTATUS has been seen (the decoded fields are real). */
  statusKnown: boolean;
  spectator: boolean;
  ally: number;
  team: number;
  ready: boolean;
  /**
   * Sync status from the battle-status bitfield: 0 = unknown, 1 = synced, 2 = unsynced.
   * A member is `2` (unsynced) while they lack the map/game content — typically because
   * they are still downloading the map after the host changed it.
   */
  sync: number;
}

function blankPlayer(name: string): Player {
  return {
    name,
    battleStatus: 0,
    teamColor: 0,
    statusKnown: false,
    spectator: false,
    ally: 0,
    team: 0,
    ready: false,
    sync: 0,
  };
}

/** Live state of one battle: its lobby status and the players in it. */
export class Battle {
  readonly battleId: number;
  /** Account name of the host. */
  founder = "";
  /** Lobby name/title, e.g. "Lava Supreme T3 Eco | 8v8 | Unranked" (from BATTLEOPENED). */
  title = "";
  /** Current map name (BATTLEOPENED, then kept current by UPDATEBATTLEINFO). */
  map = "";
  /** Game/mod name, e.g. "Beyond All Reason test-30484-7185ea5" (from BATTLEOPENED). */
  gameName = "";
  /** Engine version, e.g. "2025.06.24" (from BATTLEOPENED). */
  engineVersion = "";
  /** Max players the host allows (from BATTLEOPENED). */
  maxPlayers = 0;
  /** Whether the battle requires a password (from BATTLEOPENED). */
  passworded = false;
  /** Whether the lobby is locked (from UPDATEBATTLEINFO). */
  locked = false;
  /** Spectator count reported by the server (from UPDATEBATTLEINFO). */
  spectatorCount = 0;
  /** Current bosses, in announce order (from BarManager BattleStateChanged). */
  private bosses: string[] = [];
  /**
   * The lobby's OWN autobalance setting, as announced by the host in BarManager
   * `BattleStateChanged.autoBalance` ("off", "advanced", ...). Lowercased; null
   * until the host broadcasts (it is pushed unsolicited, no query needed). Only as
   * fresh as the last broadcast, same caveat as the boss list.
   */
  private lobbyAutoBalance: string | null = null;
  /**
   * The lobby's balance mode, from BarManager `BattleStateChanged.balanceMode`
   * (e.g. "clan;skill", "skill", "random"). Lowercased; null until the host
   * broadcasts. Same freshness caveat as autoBalance/boss.
   */
  private lobbyBalanceMode: string | null = null;
  /**
   * Mod options by option name, from SETSCRIPTTAGS `game/modoptions/<name>`. Recorded
   * for later use but intentionally NOT exposed via the API or shown in the UI.
   * (Per-player skill from the same message is handled by the Dispatcher, which keeps it
   * in its global user directory.)
   */
  private modoptions = new Map<string, string>();
  /**
   * The SPADS vote currently in progress, from BarManager `onVoteStart` /
   * `currentVote` (cleared by `onVoteStop`). Only as fresh as the host's
   * announces — a missed `onVoteStop` leaves it stale, so time-sensitive
   * consumers (the bot's start-vote guard) apply their own expiry.
   */
  private vote: VoteInProgress | null = null;
  /** Players keyed by lobby name. */
  private players = new Map<string, Player>();
  /** In-memory ring buffer of messages routed to this battle (oldest first). */
  private log: ObservedMessage[] = [];
  /** Running total of messages ever routed here (the buffer is capped). */
  private logTotal = 0;

  constructor(battleId: number) {
    this.battleId = battleId;
  }

  /** Append an observed message to this battle's log. */
  record(env: ObservedMessage): void {
    this.logTotal++;
    this.log.push(env);
    if (this.log.length > BATTLE_LOG_CAP) {
      this.log.splice(0, this.log.length - BATTLE_LOG_CAP);
    }
  }

  /** Most-recent-first slice of this battle's message log. */
  readLog(limit: number) {
    const start = Math.max(0, this.log.length - limit);
    const entries = this.log.slice(start).reverse();
    return { total: this.logTotal, count: entries.length, entries };
  }

  applyOpened(b: BattleOpened): void {
    this.founder = b.founder;
    this.title = b.title;
    this.map = b.map;
    this.gameName = b.gameName;
    this.engineVersion = b.engineVersion;
    this.maxPlayers = b.maxPlayers;
    this.passworded = b.passworded;
    // The host is a member of its own battle.
    if (b.founder) this.addPlayer(b.founder);
  }

  /** Update the lobby title (from s.battle.update_lobby_title; the host renamed the lobby). */
  applyTitle(title: string): void {
    this.title = title;
  }

  applyUpdateInfo(spectatorCount: number, locked: boolean, map: string): void {
    this.spectatorCount = spectatorCount;
    this.locked = locked;
    if (map) this.map = map;
  }

  addPlayer(name: string): void {
    if (name && !this.players.has(name)) this.players.set(name, blankPlayer(name));
  }

  removePlayer(name: string): void {
    this.players.delete(name);
  }

  /**
   * Remove a member matching `name` case-insensitively. Needed for leave signals
   * whose names the server lowercases (REMOVESCRIPTTAGS keys), while the roster is
   * keyed by real-case names from CLIENTBATTLESTATUS.
   */
  removePlayerInsensitive(name: string): void {
    const key = name.toLowerCase();
    for (const existing of this.players.keys()) {
      if (existing.toLowerCase() === key) this.players.delete(existing);
    }
  }

  applyClientStatus(name: string, battleStatus: number, teamColor: number): void {
    if (!name) return;
    const p = this.players.get(name) ?? blankPlayer(name);
    const d = decodeBattleStatus(battleStatus);
    p.battleStatus = battleStatus;
    p.teamColor = teamColor;
    p.statusKnown = true;
    p.spectator = !d.player;
    p.ally = d.ally;
    p.team = d.team;
    p.ready = d.ready;
    p.sync = d.sync;
    this.players.set(name, p);
  }

  /**
   * Apply a BarManager payload (the JSON from a "* BarManager|{...}" announce line).
   * Consumes `BattleStateChanged.boss` (a comma-separated name list) to keep the
   * battle's boss roster current, plus the `autoBalance` and `balanceMode` settings;
   * and the vote lifecycle — `onVoteStart`/`currentVote` (a vote is in progress)
   * and `onVoteStop` (it ended, whatever the result). Other keys (teamSize,
   * nbTeams, locked, preset, mutes) are ignored for now.
   */
  applyBarManager(payload: Record<string, unknown>): void {
    // A vote started (or a mid-vote refresh): both carry SPADS's currentVote
    // object, whose `command` is the voted command's token array.
    const voteState = payload["onVoteStart"] ?? payload["currentVote"];
    if (voteState && typeof voteState === "object") {
      const v = voteState as Record<string, unknown>;
      const command = Array.isArray(v["command"])
        ? v["command"].filter((t): t is string => typeof t === "string")
        : [];
      this.vote = { command, caller: typeof v["user"] === "string" ? v["user"] : "" };
    }
    // The vote ended — passed (1), failed (-1) or cancelled (0) alike.
    if ("onVoteStop" in payload) this.vote = null;
    const state = payload["BattleStateChanged"];
    if (!state || typeof state !== "object") return;
    const fields = state as Record<string, unknown>;
    const boss = fields["boss"];
    if (typeof boss === "string") {
      this.bosses = boss.split(",").map((n) => n.trim()).filter((n) => n.length > 0);
    }
    const auto = fields["autoBalance"];
    if (typeof auto === "string") this.lobbyAutoBalance = auto.trim().toLowerCase();
    const mode = fields["balanceMode"];
    if (typeof mode === "string") this.lobbyBalanceMode = mode.trim().toLowerCase();
  }

  /** The SPADS vote currently in progress (per the host's announces), or null. */
  get voteInProgress(): VoteInProgress | null {
    return this.vote;
  }

  /** The lobby's balance mode ("clan;skill", "skill", …), or null if unseen. */
  get balanceModeSetting(): string | null {
    return this.lobbyBalanceMode;
  }

  /** The lobby's own autobalance setting ("off", "advanced", …), or null if unseen. */
  get autoBalanceSetting(): string | null {
    return this.lobbyAutoBalance;
  }

  isBoss(name: string): boolean {
    return this.bosses.includes(name);
  }

  /**
   * Apply a parsed SETSCRIPTTAGS payload: merge mod options. Tags arrive incrementally
   * (one message may set only a subset), so we merge rather than replace. Player skills
   * from the same payload are consumed by the Dispatcher, not here.
   */
  applyScriptTags(tags: ScriptTags): void {
    for (const [opt, value] of tags.modoptions) this.modoptions.set(opt, value);
  }

  /** Recorded mod options (game/modoptions/<name>). Not exposed via the API/UI. */
  modOptions(): Map<string, string> {
    return this.modoptions;
  }

  hasPlayer(name: string): boolean {
    return this.players.has(name);
  }

  get playerCount(): number {
    return this.players.size;
  }

  snapshot() {
    return {
      battleId: this.battleId,
      founder: this.founder,
      title: this.title,
      map: this.map,
      gameName: this.gameName,
      engineVersion: this.engineVersion,
      maxPlayers: this.maxPlayers,
      passworded: this.passworded,
      locked: this.locked,
      spectatorCount: this.spectatorCount,
      bosses: [...this.bosses],
      autoBalance: this.lobbyAutoBalance,
      balanceMode: this.lobbyBalanceMode,
      vote: this.vote ? { command: [...this.vote.command], caller: this.vote.caller } : null,
      playerCount: this.players.size,
      players: [...this.players.values()],
    };
  }
}

/**
 * Registry of tracked battles. The Dispatcher feeds every observed protocol line to
 * `observe`, which routes it to the battle it concerns. Every battle is tracked, not
 * just the configured lava lobbies — joining a lobby is what marks it as lava, so we
 * must keep processing messages for battles before they become lava (otherwise we'd
 * miss the lines that arrive up to that point). Lines that don't concern any battle
 * return `null` so the caller can drop/log them.
 */
export class Battles {
  private lavaLobbies = new Set<number>();
  private battles = new Map<number, Battle>();
  /**
   * The battle the bot is currently joined to, or `null` when it isn't in any
   * battle. Maintained here from the routed stream: a JOINEDBATTLE for a configured
   * lava lobby (only the bot's own joins get a battle configured — see the
   * Dispatcher's `handleSelfMembership`) marks it current; it's cleared when that
   * battle closes or is dropped from the config. Used to route lines that concern
   * the currently joined battle but aren't tagged with a battle id
   * (CLIENTBATTLESTATUS, SAIDBATTLEEX, SETSCRIPTTAGS).
   */
  private currentBattle: number | null = null;

  /**
   * @param selfName the bot's own lobby account name (env.BOT_USERNAME). Only the bot's
   * own JOINEDBATTLE may adopt a battle as `currentBattle`; without this gate a stranger
   * joining a *stale* lava lobby (one the bot left without a LEFTBATTLE, so its id
   * lingered in the set) would hijack the routing of untagged lines to that battle.
   */
  constructor(private selfName = "") {}

  /**
   * Update whose session this tracker models. The Dispatcher calls this when it sees
   * the observed session's own `c LOGIN <name>` line — the account actually logged in
   * (bot or proxied client), which beats any statically configured name.
   */
  setSelfName(name: string): void {
    if (name) this.selfName = name;
  }

  /** The battle the bot is currently joined to (untagged-line routing target), or null. */
  currentBattleId(): number | null {
    return this.currentBattle;
  }

  /**
   * Set which battle ids are lava lobbies (the set `lava()` exposes). We track every
   * battle regardless (so we don't miss messages before a lobby is marked lava), so we
   * must NOT delete battles dropped from the set — battles are only forgotten on
   * BATTLECLOSED. Deleting here would destroy a still-live battle's state (e.g. its
   * title) only for the next routed line to re-`ensure` an empty one. We do still clear
   * the bot's current battle when it leaves the lava set.
   */
  setLavaLobbies(ids: number[]): void {
    this.lavaLobbies = new Set(ids);
    if (this.currentBattle !== null && !this.lavaLobbies.has(this.currentBattle)) {
      this.currentBattle = null;
    }
  }

  /** Clear the current battle (optionally only if it still matches `id`). */
  private clearCurrentBattle(id?: number): void {
    if (id === undefined || this.currentBattle === id) this.currentBattle = null;
  }

  /**
   * Route one observed message to the battle it concerns: record it in that battle's
   * log and apply any state change. Returns the battle id it was delegated to, or
   * `null` if it doesn't concern any battle (the caller records those in the
   * Dispatcher's own buffer).
   */
  observe(env: ObservedMessage): number | null {
    const m = parseMessage(env.msg);
    // REMOVEUSER = the user disconnected from the server entirely. It concerns every
    // battle (they are gone from whichever roster held them) and often arrives with
    // NO LEFTBATTLE — for a bot client Teiserver suppresses most membership
    // broadcasts — so without this, departed players linger on rosters forever.
    const removed = parseRemoveUser(m);
    if (removed) {
      for (const battle of this.battles.values()) battle.removePlayer(removed.userName);
      return null; // not battle-specific; recorded in the caller's unrouted buffer
    }
    const id = this.routeId(m);
    if (id === undefined) return null;
    this.ensure(id).record(env);
    this.apply(id, m);
    return id;
  }

  get(id: number): Battle | undefined {
    return this.battles.get(id);
  }

  all(): Battle[] {
    return [...this.battles.values()];
  }

  /**
   * Only the configured lava lobbies. We track every battle (so we don't miss
   * messages before a lobby is marked lava), but consumers like the UI want just
   * the lava ones.
   */
  lava(): Battle[] {
    return [...this.battles.values()].filter((b) => this.lavaLobbies.has(b.battleId));
  }

  get size(): number {
    return this.battles.size;
  }

  /** The battle id a parsed message concerns, or undefined if it isn't battle-specific. */
  private routeId(m: ParsedMessage): number | undefined {
    switch (m.cmd) {
      case "BATTLEOPENED":
      case "BATTLECLOSED":
      case "JOINEDBATTLE":
      case "LEFTBATTLE":
      case "UPDATEBATTLEINFO":
      case "S.BATTLE.UPDATE_LOBBY_TITLE":
      case "JOINBATTLE": {
        const id = Number(m.words[0]);
        return Number.isFinite(id) ? id : undefined;
      }
      case "CLIENTBATTLESTATUS":
      case "SAIDBATTLEEX":
      case "SETSCRIPTTAGS":
      case "REMOVESCRIPTTAGS":
        // Not tagged with a battle id: these concern the battle the bot is currently
        // joined to, so route them there.
        return this.currentBattle ?? undefined;
      // CLIENTSTATUS (rank, in-game, away) is a server-wide broadcast about a user, not
      // battle-scoped state, so it isn't routed to any battle. The Dispatcher records it
      // on the global user directory (UserRepository) instead.
      default:
        return undefined;
    }
  }

  private ensure(id: number): Battle {
    let b = this.battles.get(id);
    if (!b) {
      b = new Battle(id);
      this.battles.set(id, b);
    }
    return b;
  }

  private apply(id: number, m: ParsedMessage): void {
    switch (m.cmd) {
      case "BATTLEOPENED": {
        const b = parseBattleOpened(m);
        if (b) this.ensure(id).applyOpened(b);
        break;
      }
      case "BATTLECLOSED": {
        // The battle no longer exists: forget it.
        this.battles.delete(id);
        this.clearCurrentBattle(id);
        break;
      }
      case "JOINEDBATTLE": {
        // We track every battle, so a JOINEDBATTLE can be any user joining any battle.
        // `currentBattle` must stay the battle the BOT is in (it's what untagged lines
        // route to). We adopt it only for the bot's *own* join to a lava lobby: the
        // Dispatcher adds the bot's battle to the lava set (handleSelfMembership) before
        // this line is routed. The `selfName` check is essential — a stale lava id (a
        // battle the bot left without a LEFTBATTLE) must not let a *stranger's* join to
        // that battle hijack routing of untagged lines. We don't add the joiner as a
        // player here: real members are tracked from their CLIENTBATTLESTATUS, which
        // keeps the bot's own status-less spectator join from being counted.
        const e = parseJoinedBattle(m);
        if (e && this.selfName && e.userName === this.selfName && this.lavaLobbies.has(id)) {
          this.currentBattle = id;
        }
        break;
      }
      case "LEFTBATTLE": {
        const e = parseLeftBattle(m);
        if (e && e.userName) this.battles.get(id)?.removePlayer(e.userName);
        break;
      }
      case "UPDATEBATTLEINFO": {
        const e = parseUpdateBattleInfo(m);
        if (e) this.ensure(id).applyUpdateInfo(e.spectatorCount, e.locked, e.mapName);
        break;
      }
      case "S.BATTLE.UPDATE_LOBBY_TITLE": {
        const e = parseUpdateLobbyTitle(m);
        if (e) this.ensure(id).applyTitle(e.title);
        break;
      }
      case "CLIENTBATTLESTATUS": {
        const e = parseClientBattleStatus(m);
        if (e) this.ensure(id).applyClientStatus(e.userName, e.battleStatus, e.teamColor);
        break;
      }
      case "SAIDBATTLEEX": {
        // Most announce lines are plain chat (logged, no state change); BAR also
        // smuggles structured battle state as "* BarManager|{...}".
        const e = parseSaidBattleEx(m);
        if (e?.barManager) this.ensure(id).applyBarManager(e.barManager);
        break;
      }
      case "SETSCRIPTTAGS": {
        const e = parseSetScriptTags(m);
        if (e) this.ensure(id).applyScriptTags(e);
        break;
      }
      case "REMOVESCRIPTTAGS": {
        // SPADS clears a player's game/players/<name>/* tags when they leave the
        // battle — often the ONLY per-battle leave signal a bot client receives
        // (see routeId). The keys are lowercased by the server, hence the
        // case-insensitive removal. If the tags were cleared for another reason
        // (e.g. the player switched to spectator), their very next
        // CLIENTBATTLESTATUS re-adds them with correct state.
        const e = parseRemoveScriptTags(m);
        if (e) {
          const battle = this.battles.get(id);
          if (battle) for (const name of e.playerNames) battle.removePlayerInsensitive(name);
        }
        break;
      }
      // JOINBATTLE (our own join ack) is battle-specific but needs no roster change.
      default:
        break;
    }
  }
}
