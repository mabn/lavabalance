// Typed extractors for the inbound messages the bot cares about. These operate on
// the generic ParsedMessage produced by framing.parseMessage.

import type { ParsedMessage } from "./framing";
import { decodeClientStatus, type ClientStatus } from "./clientStatus";

export interface BattleOpened {
  battleId: number;
  /** 0 = normal battle, 1 = battle replay. */
  type: number;
  /** NAT traversal: 0 none, 1 hole punching, 2 fixed source ports. */
  natType: number;
  /** Username of the client who started this battle. */
  founder: string;
  ip: string;
  port: number;
  maxPlayers: number;
  passworded: boolean;
  rank: number;
  /** Signed 32-bit map hash. */
  mapHash: number;
  engineName: string;
  engineVersion: string;
  map: string;
  /** The lobby name/title, e.g. "Lava Supreme T3 Eco | 8v8 | Unranked". */
  title: string;
  gameName: string;
  /** Battle chat channel, e.g. "__battle__1234" (may be absent). */
  channel: string;
  raw: string;
}

// BATTLEOPENED battleId type natType founder ip port maxPlayers passworded rank
//   mapHash engineName \t engineVersion \t map \t title \t gameName \t channel
// The head (space-separated, up to the first TAB) ends with engineName; the
// remaining fields are TAB-separated free text (they may contain spaces, e.g. the
// title and map). `channel` is optional.
export function parseBattleOpened(m: ParsedMessage): BattleOpened | null {
  if (m.cmd !== "BATTLEOPENED") return null;
  const battleId = Number(m.words[0]);
  if (!Number.isFinite(battleId)) return null;
  const num = (s: string | undefined) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    battleId,
    type: num(m.words[1]),
    natType: num(m.words[2]),
    founder: m.words[3] ?? "",
    ip: m.words[4] ?? "",
    port: num(m.words[5]),
    maxPlayers: num(m.words[6]),
    passworded: (m.words[7] ?? "0") !== "0",
    rank: num(m.words[8]),
    mapHash: num(m.words[9]),
    engineName: m.words[10] ?? "",
    engineVersion: m.sentences[0] ?? "",
    map: m.sentences[1] ?? "",
    title: m.sentences[2] ?? "",
    gameName: m.sentences[3] ?? "",
    channel: m.sentences[4] ?? "",
    raw: m.raw,
  };
}

export interface ClientBattleStatus {
  userName: string;
  battleStatus: number;
  teamColor: number;
}

// CLIENTBATTLESTATUS userName battleStatus teamColor
export function parseClientBattleStatus(m: ParsedMessage): ClientBattleStatus | null {
  if (m.cmd !== "CLIENTBATTLESTATUS") return null;
  return {
    userName: m.words[0] ?? "",
    battleStatus: Number(m.words[1] ?? 0) | 0,
    teamColor: Number(m.words[2] ?? 0) | 0,
  };
}

export interface ClientStatusEvent extends ClientStatus {
  /** The user whose global status changed (real case, as the server sends it). */
  userName: string;
  /** The raw status bitfield (for logging/debugging). */
  status: number;
}

// CLIENTSTATUS userName status
// A GLOBAL per-user status broadcast by the server (not battle-specific). The status
// is a small integer bitfield; we decode it (rank, in-game, away, moderator, bot) via
// decodeClientStatus. `rank` is the 1-8 display level used by the rank icons.
export function parseClientStatus(m: ParsedMessage): ClientStatusEvent | null {
  if (m.cmd !== "CLIENTSTATUS") return null;
  const userName = m.words[0] ?? "";
  if (!userName) return null;
  const status = Number(m.words[1] ?? 0) | 0;
  return { userName, status, ...decodeClientStatus(status) };
}

export interface UpdateBattleInfo {
  battleId: number;
  spectatorCount: number;
  locked: boolean;
  mapHash: string;
  mapName: string;
}

// UPDATEBATTLEINFO battleId spectatorCount locked mapHash {mapName}
// `mapName` is a single Spring "sentence": the space-delimited remainder after mapHash
// (it may contain spaces, e.g. "Hellas Basin v1.4"), NOT a TAB-separated field. Chobby's
// ParseBattleInfo reads it as `([^\t]+)` right after mapHash, so the real server sends it
// space-delimited with no TAB — reading it from `sentences[0]` (post-TAB) would miss it
// entirely. We rejoin the words after mapHash; the fallback to `sentences[0]` keeps a
// hypothetical TAB-delimited variant working.
export function parseUpdateBattleInfo(m: ParsedMessage): UpdateBattleInfo | null {
  if (m.cmd !== "UPDATEBATTLEINFO") return null;
  const battleId = Number(m.words[0]);
  if (!Number.isFinite(battleId)) return null;
  return {
    battleId,
    spectatorCount: Number(m.words[1] ?? 0) | 0,
    locked: (m.words[2] ?? "0") !== "0",
    mapHash: m.words[3] ?? "",
    mapName: m.words.slice(4).join(" ") || (m.sentences[0] ?? ""),
  };
}

export interface UpdateLobbyTitle {
  battleId: number;
  title: string;
}

// s.battle.update_lobby_title <battleId>\t<title>
// A Teiserver push (relayed alongside the legacy protocol): the host renamed the
// lobby. The battle id is a space-separated word; the title is free text after the
// first TAB and may contain spaces and "|" separators
// (e.g. "Supreme LAVA | 8v8 | Unranked").
export function parseUpdateLobbyTitle(m: ParsedMessage): UpdateLobbyTitle | null {
  if (m.cmd !== "S.BATTLE.UPDATE_LOBBY_TITLE") return null;
  const battleId = Number(m.words[0]);
  if (!Number.isFinite(battleId)) return null;
  // Rejoin in case a title itself contains a TAB (the framing split on the first one).
  return { battleId, title: m.sentences.join("\t") };
}

// JOINEDBATTLE battleId userName [scriptPassword]
export function parseJoinedBattle(m: ParsedMessage): { battleId: number; userName: string } | null {
  if (m.cmd !== "JOINEDBATTLE") return null;
  return { battleId: Number(m.words[0]), userName: m.words[1] ?? "" };
}

// LEFTBATTLE battleId userName
export function parseLeftBattle(m: ParsedMessage): { battleId: number; userName: string } | null {
  if (m.cmd !== "LEFTBATTLE") return null;
  return { battleId: Number(m.words[0]), userName: m.words[1] ?? "" };
}

/** The "* BarManager|<json>" prefix BAR hosts use to embed structured state in chat. */
const BAR_MANAGER_PREFIX = "* BarManager|";

export interface SaidBattleEx {
  /** Who spoke (typically the host bot). */
  userName: string;
  /** The chat text after the username (BAR's "* ..." announce line). */
  message: string;
  /**
   * Parsed BarManager payload when `message` is a "* BarManager|<json>" line and the
   * JSON parses, else null. BAR uses this to broadcast structured battle state.
   */
  barManager: Record<string, unknown> | null;
}

// SAIDBATTLEEX userName {message}
// The message is free text (it may contain spaces and, in theory, tabs). It's an
// announce-style line; BAR additionally smuggles JSON state as "* BarManager|{...}".
export function parseSaidBattleEx(m: ParsedMessage): SaidBattleEx | null {
  if (m.cmd !== "SAIDBATTLEEX") return null;
  const userName = m.words[0] ?? "";
  if (!userName) return null;
  // Rebuild the original message text: words rejoined by space, then any tab-separated
  // sentences (the framing split the line on its first TAB).
  let message = m.words.slice(1).join(" ");
  if (m.sentences.length) message += "\t" + m.sentences.join("\t");

  let barManager: Record<string, unknown> | null = null;
  if (message.startsWith(BAR_MANAGER_PREFIX)) {
    const json = message.slice(BAR_MANAGER_PREFIX.length);
    try {
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === "object") barManager = parsed as Record<string, unknown>;
    } catch {
      // Not valid JSON — leave barManager null and keep the raw message.
    }
  }
  return { userName, message, barManager };
}

export interface ScriptTags {
  /**
   * Player skill (OS) by player name, from `game/players/<name>/skill`. The server
   * lowercases all keys, so names here are lowercase — look them up case-insensitively.
   */
  skills: Map<string, number>;
  /** Mod options by option name, from `game/modoptions/<name>`. */
  modoptions: Map<string, string>;
}

/** Parse a bracketed/plain skill value (e.g. "[12.81]" or "12.81") to a number, or null. */
function parseSkill(raw: string): number | null {
  const n = Number(raw.replace(/[[\]]/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

// SETSCRIPTTAGS {pair1} [{pair2}] [{pair3}] [...]
// Relayed from the battle host. Each pair is "key=value"; the server lowercases all
// keys. Pairs are TAB-separated, so the first one lands in `words` (a value MAY contain
// spaces, e.g. "debugcommands=extremebelow -25 0.125") and the rest in `sentences`.
// We extract player skills (game/players/<name>/skill) and mod options
// (game/modoptions/<name>); all other tags are ignored.
export function parseSetScriptTags(m: ParsedMessage): ScriptTags | null {
  if (m.cmd !== "SETSCRIPTTAGS") return null;
  const skills = new Map<string, number>();
  const modoptions = new Map<string, string>();
  // Rebuild the first pair (words were space-split) and append the tab-separated rest.
  const pairs = [m.words.join(" "), ...m.sentences].filter((p) => p.length > 0);
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);

    const player = key.match(/^game\/players\/(.+)\/skill$/);
    if (player) {
      const skill = parseSkill(value);
      if (skill !== null) skills.set(player[1], skill);
      continue;
    }
    const mod = key.match(/^game\/modoptions\/(.+)$/);
    if (mod) modoptions.set(mod[1], value);
  }
  return { skills, modoptions };
}

/** True if the message indicates our own JOINBATTLE succeeded. */
export function isJoinBattleOk(m: ParsedMessage): boolean {
  // JOINBATTLE battleId hashCode  (sent to the joining client on success)
  return m.cmd === "JOINBATTLE";
}

/** Returns the failure reason if our JOINBATTLE was rejected, else null. */
export function joinBattleFailedReason(m: ParsedMessage): string | null {
  if (m.cmd !== "JOINBATTLEFAILED") return null;
  return [...m.words, ...m.sentences].join(" ").trim() || "unknown";
}

// REMOVESCRIPTTAGS {key1} {key2}… — the host removed script tags. SPADS clears a
// player's `game/players/<name>/…` tags when they leave the battle, and for a bot
// client Teiserver often sends NO corresponding LEFTBATTLE (its "optimisation level"
// suppresses most membership broadcasts), so these keys are a load-bearing leave
// signal. Keys are space- and/or tab-separated; the server lowercases them, so the
// names come back lowercased and must be matched case-insensitively.
export function parseRemoveScriptTags(m: ParsedMessage): { playerNames: string[] } | null {
  if (m.cmd !== "REMOVESCRIPTTAGS") return null;
  const keys = [...m.words, ...m.sentences.flatMap((s) => s.split(" "))];
  const names = new Set<string>();
  for (const key of keys) {
    const player = key.match(/^game\/players\/(.+?)\//);
    if (player) names.add(player[1]);
  }
  return { playerNames: [...names] };
}

// REMOVEUSER userName — the user disconnected from the server entirely. Clients are
// expected to infer "left their battle" from this; for departures without a
// LEFTBATTLE it is the only battle-roster signal we get.
export function parseRemoveUser(m: ParsedMessage): { userName: string } | null {
  if (m.cmd !== "REMOVEUSER") return null;
  const userName = m.words[0] ?? "";
  return userName ? { userName } : null;
}
