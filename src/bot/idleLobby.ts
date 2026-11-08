// Finding a lobby for an IDLE bot.
//
// The bot is meant to sit in a lava lobby. After a login it joins its rejoin
// target (BOT_AUTOJOIN_ROOM, see bot.ts LOGININFOEND); but that target can be
// gone, the join can fail, or the lobby can close under the bot — and then it
// sits in no battle at all until an admin whispers `.join`. This module is the
// pure half of the fix: given Teiserver's lobby index, which open lobby should
// an idle bot join? bot.ts polls this (idleLobbyTick) while it is connected and
// in no battle.
//
// A lobby qualifies when ALL of these hold:
//   • its name contains "lava" AND "unranked" (both case-insensitive),
//   • its map is IDLE_LOBBY_MAP (case-insensitive, trimmed),
//   • it has at least IDLE_LOBBY_MIN_PLAYERS non-spectator players,
//   • it is neither locked nor passworded (a JOINBATTLE there just fails).
// Among several, the one with the most players wins (ties keep the first).

import type { IndexLobby } from "../teiserver";

/** The map an idle bot's target lobby must be on. */
export const IDLE_LOBBY_MAP = "Supreme Isthmus v2.1";

/** Minimum non-spectator players in a lobby before the idle bot joins it. */
export const IDLE_LOBBY_MIN_PLAYERS = 8;

/** Every word that must appear in the lobby name (case-insensitive). */
export const IDLE_LOBBY_NAME_WORDS = ["lava", "unranked"] as const;

/** Does this lobby qualify as an idle bot's join target? */
export function isIdleLobbyCandidate(lobby: IndexLobby): boolean {
  const name = lobby.name.toLowerCase();
  if (!IDLE_LOBBY_NAME_WORDS.every((w) => name.includes(w))) return false;
  if (lobby.map.trim().toLowerCase() !== IDLE_LOBBY_MAP.toLowerCase()) return false;
  if (lobby.playerCount < IDLE_LOBBY_MIN_PLAYERS) return false;
  if (lobby.locked || lobby.passworded) return false;
  return true;
}

/**
 * Pick the lobby an idle bot should join from Teiserver's lobby index: the
 * qualifying lobby (isIdleLobbyCandidate) with the most players, ties keeping
 * the earlier entry. `null` when nothing qualifies.
 */
export function pickIdleLobby(index: IndexLobby[]): IndexLobby | null {
  let best: IndexLobby | null = null;
  for (const lobby of index) {
    if (!isIdleLobbyCandidate(lobby)) continue;
    if (!best || lobby.playerCount > best.playerCount) best = lobby;
  }
  return best;
}
