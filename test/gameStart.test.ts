// The bot-uploaded game-start roster: payload validation, the freshness rule the
// /api/lobbies/:id substitution runs on, and the tracker→lobby-player mapping.

import { describe, expect, it } from "vitest";
import {
  confirmLaunchRoster,
  GAME_START_GRACE_MS,
  GAME_START_TTL_MS,
  parseGameEndEvent,
  parseGameStartSnapshot,
  snapshotFresh,
  substituteRoster,
  type GameStartSnapshot,
} from "../src/gameStart";
import type { TrackedPlayer } from "../src/tracker";
import type { TeiserverLobbyPlayer } from "../src/teiserver";

const tracked = (over: Partial<TrackedPlayer> = {}): TrackedPlayer => ({
  name: "huk123",
  skill: 27.5,
  rank: 5,
  inGame: true,
  away: false,
  ready: true,
  spectator: false,
  sync: 1,
  ally: 0,
  team: 3,
  boss: false,
  statusKnown: true,
  ...over,
});

const snapshot = (over: Partial<GameStartSnapshot> = {}): GameStartSnapshot => ({
  battleId: 76,
  startedAt: 1_000_000,
  players: [tracked(), tracked({ name: "No_Air", ally: 1 })],
  founder: "HOST",
  title: "Supreme LAVA",
  botBalanced: true,
  predictedFirstWin: 49.8,
  ...over,
});

const livePlayer = (over: Partial<TeiserverLobbyPlayer> = {}): TeiserverLobbyPlayer => ({
  name: "huk123",
  skill: 27.5,
  party: "#62ea6b",
  rank: null,
  inGame: true,
  away: false,
  ready: true,
  spectator: false,
  sync: 0,
  ally: 0,
  team: 0,
  boss: false,
  statusKnown: true,
  ...over,
});

describe("parseGameStartSnapshot", () => {
  it("round-trips a full snapshot", () => {
    const snap = snapshot();
    expect(parseGameStartSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
  });

  it("keeps spectators in the roster", () => {
    const snap = snapshot({ players: [tracked(), tracked({ name: "spec", spectator: true })] });
    const parsed = parseGameStartSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(parsed.players.map((p) => p.spectator)).toEqual([false, true]);
  });

  it("defaults optional per-player fields and null skill", () => {
    const parsed = parseGameStartSnapshot({
      battleId: 1,
      startedAt: 5,
      players: [{ name: "a", skill: null }],
    });
    expect(parsed.players[0]).toEqual(tracked({
      name: "a",
      skill: null,
      rank: null,
      inGame: false,
      ready: false,
      sync: 0,
      ally: 0,
      team: 0,
      statusKnown: false,
    }));
    expect(parsed.founder).toBe("");
    expect(parsed.botBalanced).toBeNull();
    expect(parsed.predictedFirstWin).toBeNull();
  });

  it.each([
    ["not an object", "nope"],
    ["missing battleId", { startedAt: 5, players: [] }],
    ["non-integer battleId", { battleId: 1.5, startedAt: 5, players: [] }],
    ["negative battleId", { battleId: -1, startedAt: 5, players: [] }],
    ["missing startedAt", { battleId: 1, players: [] }],
    ["players not an array", { battleId: 1, startedAt: 5, players: "x" }],
    ["player without a name", { battleId: 1, startedAt: 5, players: [{ skill: 1 }] }],
    ["blank player name", { battleId: 1, startedAt: 5, players: [{ name: "  " }] }],
    ["string skill", { battleId: 1, startedAt: 5, players: [{ name: "a", skill: "27" }] }],
    ["NaN startedAt", { battleId: 1, startedAt: NaN, players: [] }],
  ])("rejects %s", (_what, body) => {
    expect(() => parseGameStartSnapshot(body)).toThrow(/invalid game-start payload/);
  });
});

describe("parseGameEndEvent", () => {
  it("parses both reasons", () => {
    expect(parseGameEndEvent({ battleId: 76, endedAt: 9, reason: "result" })).toEqual({
      battleId: 76,
      endedAt: 9,
      reason: "result",
    });
    expect(parseGameEndEvent({ battleId: 76, reason: "ingame-clear" }).reason).toBe(
      "ingame-clear",
    );
  });

  it("rejects an unknown reason and a bad battle id", () => {
    expect(() => parseGameEndEvent({ battleId: 76, reason: "oops" })).toThrow();
    expect(() => parseGameEndEvent({ battleId: 0, reason: "result" })).toThrow();
  });
});

describe("snapshotFresh", () => {
  const t0 = 1_000_000;
  const snap = snapshot({ startedAt: t0 });

  it("is fresh while the live lobby says in progress", () => {
    expect(snapshotFresh(snap, true, t0 + 60 * 60_000)).toBe(true);
  });

  it("is fresh within the grace even while the live lobby lags behind", () => {
    expect(snapshotFresh(snap, false, t0 + GAME_START_GRACE_MS - 1)).toBe(true);
  });

  it("goes stale after the grace once the live lobby says not in progress", () => {
    expect(snapshotFresh(snap, false, t0 + GAME_START_GRACE_MS)).toBe(false);
  });

  it("expires at the TTL whatever the live lobby says", () => {
    expect(snapshotFresh(snap, true, t0 + GAME_START_TTL_MS)).toBe(false);
    expect(snapshotFresh(snap, true, t0 + GAME_START_TTL_MS - 1)).toBe(true);
  });

  it("rejects a snapshot from the future", () => {
    expect(snapshotFresh(snap, true, t0 - 1)).toBe(false);
  });
});

describe("substituteRoster", () => {
  it("maps every tracked field and merges party from the live roster by name", () => {
    const snap = snapshot();
    const out = substituteRoster(snap, [livePlayer({ name: "HUK123", party: "#ff0000" })]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      name: "huk123",
      skill: 27.5,
      party: "#ff0000", // merged case-insensitively from the live roster
      rank: 5,
      inGame: true,
      away: false,
      ready: true,
      spectator: false,
      sync: 1,
      ally: 0,
      team: 3,
      boss: false,
      statusKnown: true,
    });
    // No_Air is gone from the live lobby: everything launch-time kept, party null.
    expect(out[1].name).toBe("No_Air");
    expect(out[1].ally).toBe(1);
    expect(out[1].party).toBeNull();
  });

  it("keeps snapshot spectators and ignores extra live players", () => {
    const snap = snapshot({
      players: [tracked(), tracked({ name: "watcher", spectator: true, ally: 0 })],
    });
    const out = substituteRoster(snap, [
      livePlayer(),
      livePlayer({ name: "latecomer", party: "#00ff00" }),
    ]);
    expect(out.map((p) => p.name)).toEqual(["huk123", "watcher"]);
    expect(out[1].spectator).toBe(true);
  });
});

describe("confirmLaunchRoster", () => {
  // Battle 5775 (2026-11-01): a ghost — left the lobby unseen, unready, sharing a
  // team slot with a real player — made the launch roster read 8v9.
  const real = [tracked({ name: "a", ally: 0, team: 0 }), tracked({ name: "b", ally: 1, team: 1 })];
  const ghost = tracked({ name: "Karakar", ally: 0, team: 1, ready: false });
  const spec = tracked({ name: "watcher", spectator: true });
  const inGame = (names: string[]) => (n: string) => names.includes(n);

  it("drops players whose in-game bit never went up, keeps spectators", () => {
    const out = confirmLaunchRoster([...real, ghost, spec], inGame(["a", "b"]));
    expect(out?.map((p) => p.name)).toEqual(["a", "b", "watcher"]);
  });

  it("returns null when every player went in game", () => {
    expect(confirmLaunchRoster([...real, spec], inGame(["a", "b"]))).toBeNull();
  });

  it("returns null (keeps the roster) when no player's in-game bit was seen", () => {
    expect(confirmLaunchRoster([...real, ghost], inGame([]))).toBeNull();
  });
});
