// The idle bot's lobby picker (src/bot/idleLobby.ts): which open lobby a bot in
// no battle should join.

import { describe, expect, it } from "vitest";
import {
  IDLE_LOBBY_MAP,
  IDLE_LOBBY_MIN_PLAYERS,
  isIdleLobbyCandidate,
  pickIdleLobby,
} from "../src/bot/idleLobby";
import type { IndexLobby } from "../src/teiserver";

const row = (id: number, name: string, playerCount: number, extra: Partial<IndexLobby> = {}): IndexLobby => ({
  id,
  name,
  map: IDLE_LOBBY_MAP,
  inProgress: false,
  locked: false,
  passworded: false,
  memberCount: playerCount,
  playerCount,
  spectatorCount: 0,
  ...extra,
});

describe("isIdleLobbyCandidate", () => {
  it("accepts a lava unranked lobby on the map with enough players", () => {
    expect(isIdleLobbyCandidate(row(1, "Lava Unranked 8v8", 8))).toBe(true);
  });

  it("matches both name words case-insensitively, anywhere in the name", () => {
    expect(isIdleLobbyCandidate(row(1, "[UNRANKED] supreme LAVA | 8v8", 10))).toBe(true);
    expect(isIdleLobbyCandidate(row(2, "Lava 8v8", 10))).toBe(false); // no "unranked"
    expect(isIdleLobbyCandidate(row(3, "Unranked 8v8", 10))).toBe(false); // no "lava"
  });

  it("requires the exact map (case-insensitive, surrounding whitespace ignored)", () => {
    expect(isIdleLobbyCandidate(row(1, "Lava Unranked", 9, { map: " supreme isthmus V2.1 " }))).toBe(true);
    expect(isIdleLobbyCandidate(row(2, "Lava Unranked", 9, { map: "Supreme Isthmus v2.0" }))).toBe(false);
    expect(isIdleLobbyCandidate(row(3, "Lava Unranked", 9, { map: "Supreme Isthmus" }))).toBe(false);
  });

  it("counts players, not spectators, against the minimum", () => {
    expect(IDLE_LOBBY_MIN_PLAYERS).toBe(8);
    expect(isIdleLobbyCandidate(row(1, "Lava Unranked", 7, { spectatorCount: 20, memberCount: 27 }))).toBe(false);
    expect(isIdleLobbyCandidate(row(2, "Lava Unranked", 8))).toBe(true);
  });

  it("skips locked and passworded lobbies (the join would fail), keeps in-progress ones", () => {
    expect(isIdleLobbyCandidate(row(1, "Lava Unranked", 9, { locked: true }))).toBe(false);
    expect(isIdleLobbyCandidate(row(2, "Lava Unranked", 9, { passworded: true }))).toBe(false);
    expect(isIdleLobbyCandidate(row(3, "Lava Unranked", 9, { inProgress: true }))).toBe(true);
  });
});

describe("pickIdleLobby", () => {
  it("picks the qualifying lobby with the most players", () => {
    const picked = pickIdleLobby([
      row(1, "Lava Ranked 8v8", 16),
      row(2, "Lava Unranked A", 9),
      row(3, "Lava Unranked B", 12),
      row(4, "Lava Unranked C", 12, { map: "Glitters" }),
    ]);
    expect(picked?.id).toBe(3);
  });

  it("keeps the earlier entry on a tie", () => {
    expect(pickIdleLobby([row(7, "Lava Unranked A", 8), row(8, "Lava Unranked B", 8)])?.id).toBe(7);
  });

  it("returns null when nothing qualifies", () => {
    expect(pickIdleLobby([])).toBeNull();
    expect(pickIdleLobby([row(1, "Lava Unranked", 7), row(2, "Supreme 8v8", 16)])).toBeNull();
  });
});
