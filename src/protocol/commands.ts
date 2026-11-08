// Outbound command builders for the legacy Spring lobby protocol.
// Each builder returns a single line WITHOUT the trailing newline; the transport
// appends '\n' when writing.

import { encodeBattleStatus, SPECTATOR_STATUS, type BattleStatus } from "./battleStatus";

export interface LoginParams {
  username: string;
  /** base64(md5(password)) — pre-hashed; we never hash at runtime. */
  passwordHash: string;
  /** "lobby name and version" sentence, e.g. "lavabalance 0.1.0". */
  lobbyName: string;
  /** Compatibility flags, space-separated, e.g. "b sp cl p et". */
  compatFlags: string;
  /** Stable user id (any integer-ish token); 0 is fine for a bot. */
  userId?: string;
}

// LOGIN userName passwordHash cpu localIP {lobbyName}\t{userId}\t{compatFlags}
// cpu is a legacy field (0); localIP "*" lets the server use the source address.
export function login(p: LoginParams): string {
  const userId = p.userId ?? "0";
  return (
    `LOGIN ${p.username} ${p.passwordHash} 0 * ${p.lobbyName}` +
    `\t${userId}\t${p.compatFlags}`
  );
}

// Teiserver's JOINBATTLE handler matches exactly three args (^(\S+) (\S+) (\S+)$);
// a bare "JOINBATTLE <id>" is silently rejected with a SERVERMSG "No incomming
// match". "empty" is the protocol's no-password placeholder, and the script
// password identifies us to the host when the game launches.
export function joinBattle(battleId: number | string, password = "empty", scriptPassword = "empty"): string {
  return `JOINBATTLE ${battleId} ${password} ${scriptPassword}`;
}

export function leaveBattle(): string {
  return "LEAVEBATTLE";
}

// MYBATTLESTATUS battleStatus teamColor
export function myBattleStatus(status: BattleStatus = SPECTATOR_STATUS, teamColor = 0): string {
  return `MYBATTLESTATUS ${encodeBattleStatus(status)} ${teamColor | 0}`;
}

export function ping(): string {
  return "PING";
}

export function pong(): string {
  return "PONG";
}

// --- Host force-moves (used in a later step; the bot must have been granted the
// privilege to issue these as a non-founder). Included now so the command surface
// lives in one place. ---

export function forceAllyNo(userName: string, allyTeam: number): string {
  return `FORCEALLYNO ${userName} ${allyTeam}`;
}

export function forceTeamNo(userName: string, team: number): string {
  return `FORCETEAMNO ${userName} ${team}`;
}

export function forceSpectatorMode(userName: string): string {
  return `FORCESPECTATORMODE ${userName}`;
}

export function sayBattle(message: string): string {
  return `SAYBATTLE ${message}`;
}

/**
 * Announce-style battle chat (rendered italic, like "* user does something").
 * NOTE: SPADS does NOT parse SAIDBATTLEEX, so any !force/$lock command must go
 * through `sayBattle` instead — this is for human-facing messages only.
 */
export function sayBattleEx(message: string): string {
  return `SAYBATTLEEX ${message}`;
}

export function sayPrivate(userName: string, message: string): string {
  return `SAYPRIVATE ${userName} ${message}`;
}

// --- Friends. Teiserver's legacy friend commands take one "userName=<name>"
// argument (spring_in.ex splits the payload on "="); the list queries take none.
// The reply to FRIENDREQUESTLIST is a FRIENDREQUESTLISTBEGIN /
// "FRIENDREQUESTLIST userName=<name>" per request / FRIENDREQUESTLISTEND block. ---

export function friendRequestList(): string {
  return "FRIENDREQUESTLIST";
}

export function acceptFriendRequest(userName: string): string {
  return `ACCEPTFRIENDREQUEST userName=${userName}`;
}
