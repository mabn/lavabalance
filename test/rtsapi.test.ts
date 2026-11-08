import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchBattles,
  mapBattlesToLobbies,
  parseSkill,
  type RtsApiLobby,
} from "../src/rtsapi";

// A trimmed slice of a real api.bar-rts.com/battles response (battle 7950 = a configured
// lava lobby, plus an unrelated battle that must be filtered out). Shapes match the live
// API: bracketed `skill` strings, per-player `teamId` (null for spectators), raw 0-7
// `status.rank`, `lobbyReady` as "Yes"/"No".
const SAMPLE = [
  {
    battleId: 7950,
    founder: { username: "Host[EU7][054]", status: { ingame: false, rank: 0, bot: true } },
    title: "EU7 - 054",
    map: "Quicksilver Remake 1.2",
    game: "Beyond All Reason test-30505-12db645",
    maxPlayers: 16,
    passworded: false,
    locked: false,
    spectators: 3,
    players: [
      // Spectator: no slot (teamId null), even though a stale gameStatus may say otherwise.
      { username: "jimbobzayy", status: { ingame: false, away: false, rank: 4 }, skill: "[8.9 ???]", teamId: null },
      // Player with a slot and a higher OS — should sort to the top.
      { username: "Teradactylman", status: { ingame: false, away: false, rank: 3 }, skill: "[36.06 ??]", teamId: 4, lobbyReady: "Yes" },
      { username: "[HMRD]xkvega", status: { ingame: false, away: false, rank: 4 }, skill: "[16.6 ???]", teamId: 10, lobbyReady: "No" },
      // Missing/garbage skill → null, sorts last.
      { username: "NoSkill", status: { ingame: true, away: true, rank: 7 }, teamId: 2, lobbyReady: "Yes" },
    ],
  },
  {
    battleId: 8771,
    founder: { username: "Host[EU7][011]", status: { ingame: false, rank: 0, bot: true } },
    title: "EU7 - 011",
    map: "All That Glitters v2.2.3",
    game: "Beyond All Reason test-30505-12db645",
    maxPlayers: 16,
    passworded: false,
    locked: false,
    spectators: 0,
    players: [{ username: "Zoomies500", status: { rank: 3 }, skill: "[18.2 ???]", teamId: 9, lobbyReady: "Yes" }],
  },
];


describe("parseSkill", () => {
  it("extracts the leading OS number from a bracketed skill string", () => {
    expect(parseSkill("[18.2 ???]")).toBe(18.2);
    expect(parseSkill("[36.06 ??]")).toBe(36.06);
    expect(parseSkill("[5.7]")).toBe(5.7);
  });

  it("returns null for missing or numberless input", () => {
    expect(parseSkill(undefined)).toBeNull();
    expect(parseSkill("[??]")).toBeNull();
    expect(parseSkill("")).toBeNull();
  });
});

describe("mapBattlesToLobbies", () => {
  it("keeps only the configured lava lobbies", () => {
    const lobbies = mapBattlesToLobbies(SAMPLE, [7950]);
    expect(lobbies.map((l) => l.battleId)).toEqual([7950]);
  });

  it("returns every battle when all=true, ignoring the lava filter", () => {
    const lobbies = mapBattlesToLobbies(SAMPLE, [7950], true);
    expect(lobbies.map((l) => l.battleId)).toEqual(SAMPLE.map((b) => b.battleId));
    // Even an empty lava list yields all battles.
    expect(mapBattlesToLobbies(SAMPLE, [], true).length).toBe(SAMPLE.length);
  });

  it("maps battle-level fields and reports the unavailable ones as empty", () => {
    const [l] = mapBattlesToLobbies(SAMPLE, [7950]) as [RtsApiLobby];
    expect(l.founder).toBe("Host[EU7][054]");
    expect(l.title).toBe("EU7 - 054");
    expect(l.gameName).toBe("Beyond All Reason test-30505-12db645");
    expect(l.map).toBe("Quicksilver Remake 1.2");
    expect(l.spectatorCount).toBe(3);
    expect(l.playerCount).toBe(4); // includes the spectator
    // Not carried by the public API:
    expect(l.engineVersion).toBe("");
    expect(l.bosses).toEqual([]);
  });

  it("derives per-player fields and sorts by skill high→low (unknown last)", () => {
    const [l] = mapBattlesToLobbies(SAMPLE, [7950]);
    expect(l.players.map((p) => p.name)).toEqual([
      "Teradactylman", // 36.06
      "[HMRD]xkvega", // 16.6
      "jimbobzayy", // 8.9
      "NoSkill", // null → last
    ]);

    const terad = l.players.find((p) => p.name === "Teradactylman")!;
    expect(terad.skill).toBe(36.06);
    expect(terad.rank).toBe(4); // raw 3 → 1-8 display level 4
    expect(terad.ready).toBe(true);
    expect(terad.spectator).toBe(false);
    expect(terad.team).toBe(4);
    expect(terad.ally).toBe(0); // no allyteam in the source

    const spec = l.players.find((p) => p.name === "jimbobzayy")!;
    expect(spec.spectator).toBe(true); // teamId null
    expect(spec.team).toBe(0);
    expect(spec.ready).toBe(false);

    const ng = l.players.find((p) => p.name === "NoSkill")!;
    expect(ng.skill).toBeNull();
    expect(ng.inGame).toBe(true);
    expect(ng.away).toBe(true);
    expect(ng.rank).toBe(8); // raw 7 → clamped display level 8
  });

});

// Observability: the error from a failed upstream fetch must name the request and
// distinguish a timeout from a non-2xx response (so the resulting 502 is actionable,
// not a bare "The operation was aborted").
describe("fetchBattles error reporting", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("names the URL and status on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503, statusText: "Service Unavailable" })),
    );
    await expect(fetchBattles()).rejects.toThrow(
      /bar-rts GET https:\/\/api\.bar-rts\.com\/battles responded 503 Service Unavailable/,
    );
  });

  it("reports a timeout as a timeout (not the opaque abort error)", async () => {
    // A fetch that never resolves until aborted by the deadline.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("The operation was aborted")),
            );
          }),
      ),
    );
    await expect(fetchBattles(5)).rejects.toThrow(/battles timed out after 5ms/);
  });
});

describe("ranksFromRtsApi", () => {
  it("maps one battle's players to display ranks by lowercased name, fetching once per 30 s", async () => {
    const { ranksFromRtsApi } = await import("../src/rtsapi");
    const { vi } = await import("vitest");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([
        { battleId: 7, players: [{ username: "OneTrickPony", status: { rank: 5 } }, { username: "NoStatus" }] },
        { battleId: 8, players: [{ username: "Other", status: { rank: 2 } }] },
      ])),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const t = 1_000_000_000;
      const ranks = await ranksFromRtsApi(7, t);
      expect([...ranks]).toEqual([["onetrickpony", 6]]);
      await ranksFromRtsApi(8, t + 1000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await ranksFromRtsApi(8, t + 31_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
