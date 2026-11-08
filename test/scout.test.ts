// Scouting (src/scout.ts): the push validator, the lane forecast's assignment,
// the team summaries, the boards and the bot's one-liner.

import { describe, expect, it } from "vitest";
import {
  BOARD_MIN_GAMES,
  filterBoards,
  laneForecast,
  lanesApply,
  MAX_SCOUT_BATCH,
  parseScoutCard,
  parseScoutUpload,
  scoutBoards,
  scoutLine,
  scoutLobby,
  teamScouting,
  type ScoutCard,
} from "../src/scout";

/** A card with sensible defaults; lanes as [name, share, games, winRate]. */
function card(
  userId: number,
  name: string,
  lanes: [string, number, number, number | null][] = [],
  extra: Partial<ScoutCard> = {},
): ScoutCard {
  return parseScoutCard({
    userId,
    name,
    games: 100,
    winRate: 0.5,
    archetypes: ["Generalist"],
    badges: [],
    lanes: lanes.map(([n, share, games, winRate]) => ({ name: n, share, games, winRate })),
    traits: { aggression: 0.1, ecoFocus: 0.4 },
    commander: {},
    danger: 1,
    ...extra,
  })!;
}

describe("parseScoutUpload", () => {
  it("rejects a body that is not an object of arrays", () => {
    expect(() => parseScoutUpload(null)).toThrow();
    expect(() => parseScoutUpload([])).toThrow();
    expect(() => parseScoutUpload({ profiles: "x" })).toThrow(/profiles/);
    expect(() => parseScoutUpload({ remove: {} })).toThrow(/remove/);
  });

  it("caps the batch size", () => {
    const profiles = Array.from({ length: MAX_SCOUT_BATCH + 1 }, (_, i) => ({ userId: i + 1, name: "p" + i }));
    expect(() => parseScoutUpload({ profiles })).toThrow(/at most/);
  });

  it("skips cards without an id or a name instead of failing the batch", () => {
    const out = parseScoutUpload({
      profiles: [{ userId: 1, name: "ok" }, { name: "no id" }, { userId: -3, name: "bad id" }, { userId: 4 }],
    });
    expect(out.profiles.map((p) => p.userId)).toEqual([1]);
    expect(out.skipped).toBe(3);
  });

  it("clamps numbers, caps strings, drops spot ids and duplicate lanes, orders lanes by share", () => {
    const c = parseScoutCard({
      userId: 7,
      name: "x".repeat(200),
      games: -5,
      winRate: 3,
      archetypes: ["A", "A", 5, "B"],
      badges: [{ id: "comm_bomber", icon: "💥", label: "Comm bomber", caption: "c" }, { id: "comm_bomber", label: "dup" }],
      lanes: [
        { name: "P13", share: 0.9, games: 50 },
        { name: "Geo", share: 0.2, games: 10, winRate: 0.6 },
        { name: "Front Suicide", share: 0.5, games: 30, winRate: 0.7 },
        { name: "Geo", share: 0.9, games: 99 },
      ],
      traits: { aggression: "high", ecoFocus: 0.333333 },
    })!;
    expect(c.name.length).toBe(64);
    expect(c.games).toBe(0);
    expect(c.winRate).toBe(1);
    expect(c.archetypes).toEqual(["A", "B"]);
    expect(c.badges).toHaveLength(1);
    expect(c.lanes.map((l) => l.name)).toEqual(["Front Suicide", "Geo"]);
    expect(c.traits.aggression).toBeNull();
    expect(c.traits.ecoFocus).toBe(0.333);
  });

  it("keeps the later of two cards for one id and never removes an id it also upserts", () => {
    const out = parseScoutUpload({
      profiles: [{ userId: 1, name: "old" }, { userId: 1, name: "new" }],
      remove: [1, 2, 2, "x", 0],
    });
    expect(out.profiles.map((p) => p.name)).toEqual(["new"]);
    expect(out.remove).toEqual([2]);
  });
});

describe("laneForecast", () => {
  it("is null when nobody has a lane", () => {
    expect(laneForecast([[{ name: "a", card: card(1, "a") }], [{ name: "b", card: null }]])).toBeNull();
  });

  it("gives a contested lane to the stronger habit and moves the other player to their next lane", () => {
    const team = [
      { name: "a", card: card(1, "a", [["Front Suicide", 0.5, 40, 0.6], ["Pond", 0.3, 20, 0.5]]) },
      { name: "b", card: card(2, "b", [["Front Suicide", 0.8, 60, 0.55]]) },
    ];
    const f = laneForecast([team, []])!;
    const byLane = Object.fromEntries(f.lanes.map((r) => [r.lane, r.picks[0]?.name ?? null]));
    expect(byLane["Front Suicide"]).toBe("b");
    expect(byLane["Pond"]).toBe("a");
    expect(f.flex[0]).toEqual([]);
  });

  it("maximises the TEAM's total, not greedily the biggest share", () => {
    // Greedy would seat a on Geo (0.6) and leave b nowhere; the optimum is a→Eco, b→Geo.
    const team = [
      { name: "a", card: card(1, "a", [["Geo", 0.6, 30, null], ["Eco", 0.4, 20, null]]) },
      { name: "b", card: card(2, "b", [["Geo", 0.55, 30, null]]) },
    ];
    const f = laneForecast([team])!;
    const byLane = Object.fromEntries(f.lanes.map((r) => [r.lane, r.picks[0]?.name]));
    expect(byLane).toEqual({ Geo: "b", Eco: "a" });
  });

  it("orders lanes front to back, then by name, and lists a player left without a lane as flex", () => {
    const team = [
      { name: "a", card: card(1, "a", [["Air", 0.9, 30, null]]) },
      { name: "b", card: card(2, "b", [["Air", 0.5, 30, null]]) },
      { name: "c", card: card(3, "c", [["Zebra Lane", 0.5, 30, null]]) },
      { name: "d", card: card(4, "d", [["Front Second", 0.4, 30, null]]) },
    ];
    const f = laneForecast([team])!;
    expect(f.lanes.map((r) => r.lane)).toEqual(["Front Second", "Air", "Zebra Lane"]);
    expect(f.flex[0]).toEqual(["b"]);
  });

  it("trusts a share from many games over the same share from one", () => {
    const team = [
      { name: "rare", card: card(1, "rare", [["Pond", 0.9, 1, null]]) },
      { name: "main", card: card(2, "main", [["Pond", 0.7, 40, null]]) },
    ];
    expect(laneForecast([team])!.lanes[0].picks[0]!.name).toBe("main");
  });
});

describe("teamScouting / scoutLobby", () => {
  const bomber = card(10, "Bomber", [["Front Suicide", 0.6, 60, 0.62]], {
    badges: [{ id: "comm_bomber", icon: "💥", label: "Comm bomber", caption: "" }],
    archetypes: ["Aggressor", "Comm bomber"],
  });
  const eco = card(11, "Eco", [["Eco", 0.7, 70, 0.58]], { archetypes: ["Economist"] });
  const other = card(12, "Other", [["Front Suicide", 0.5, 50, 0.4]], { archetypes: ["Aggressor"] });

  it("counts threats and styles per team", () => {
    const t = teamScouting([
      { name: "Bomber", card: bomber },
      { name: "Eco", card: eco },
      { name: "nobody", card: null },
    ]);
    expect(t).toMatchObject({ scouted: 2, players: 3 });
    expect(t.threats).toEqual([{ id: "comm_bomber", icon: "💥", label: "Comm bomber", names: ["Bomber"] }]);
    expect(t.styles[0]).toEqual({ archetype: "Aggressor", count: 1 });
  });

  it("matches cards by account id, then by name, skips spectators, and forecasts only on Supreme Isthmus", () => {
    const players = [
      { name: "renamed", ally: 0, spectator: false, losUserId: 10 }, // the id finds Bomber
      { name: "ECO", ally: 0, spectator: false, losUserId: null }, // the name finds Eco
      { name: "Other", ally: 1, spectator: false, losUserId: null },
      { name: "Eco", ally: 1, spectator: true, losUserId: 11 }, // a spectator gets nothing
    ];
    const out = scoutLobby(players, [bomber, eco, other], "Supreme Isthmus v2.1");
    expect(out.players.map((p) => p.scout?.games ?? null)).toEqual([100, 100, 100, null]);
    expect(out.players[0].scout!.badges[0].id).toBe("comm_bomber");
    const s = out.scouting!;
    expect(s.teams.map((t) => [t.ally, t.scouted, t.players])).toEqual([
      [0, 2, 2],
      [1, 1, 1],
    ]);
    const front = s.lanes!.lanes.find((r) => r.lane === "Front Suicide")!;
    expect(front.picks.map((p) => p?.name)).toEqual(["renamed", "Other"]);

    expect(scoutLobby(players, [bomber], "Hellas Basin").scouting!.lanes).toBeNull();
    expect(scoutLobby(players, [], "Supreme Isthmus").scouting).toBeNull();
  });

  it("recognises the map however it is spelled", () => {
    expect(lanesApply("Supreme Isthmus v2.1")).toBe(true);
    expect(lanesApply("supreme_isthmus")).toBe(false);
    expect(lanesApply("SupremeIsthmus")).toBe(true);
    expect(lanesApply(null)).toBe(false);
  });
});

describe("boards", () => {
  const regular = (id: number, danger: number, lanes: [string, number, number, number | null][] = []) =>
    card(id, "p" + id, lanes, { danger, games: BOARD_MIN_GAMES });

  it("ranks the watch list by danger and leaves out the occasional player", () => {
    const b = scoutBoards([regular(1, 2), regular(2, 5), { ...regular(3, 9), games: BOARD_MIN_GAMES - 1 }, regular(4, 0)]);
    expect(b.watchlist.map((w) => w.userId)).toEqual([2, 1]);
  });

  it("crowns lane kings from enough games on the lane, best record first, and filters private players", () => {
    const b = scoutBoards([
      regular(1, 1, [["Geo", 0.5, 30, 0.6]]),
      regular(2, 1, [["Geo", 0.5, 30, 0.7]]),
      regular(3, 1, [["Geo", 0.5, 5, 0.99]]), // too few games there
    ]);
    expect(b.laneKings).toEqual([
      {
        lane: "Geo",
        kings: [
          { userId: 2, name: "p2", games: 30, winRate: 0.7 },
          { userId: 1, name: "p1", games: 30, winRate: 0.6 },
        ],
      },
    ]);
    const f = filterBoards(b, new Set([2]), 10);
    expect(f.laneKings[0].kings.map((k) => k.userId)).toEqual([1]);
    expect(f.watchlist.map((w) => w.userId)).toEqual([1, 3]);
  });
});

describe("scoutLine", () => {
  it("says it all in one line", () => {
    const c = card(1, "Songi", [["Eco", 0.62, 700, 0.71], ["Geo", 0.2, 200, 0.5]], {
      games: 1140,
      winRate: 0.72,
      archetypes: ["Economist", "Backline / tech"],
      badges: [{ id: "comm_bomber", icon: "💥", label: "Comm bomber", caption: "x" }],
    });
    expect(scoutLine(c)).toBe(
      "Songi (1140 games, won 72%) · Economist, Backline / tech · plays Eco 62% (won 71%), Geo 20% · 💥 Comm bomber",
    );
  });

  it("stays a single chat line however much the card holds", () => {
    const c = card(1, "x", [], { archetypes: Array.from({ length: 8 }, () => "a".repeat(40)).map((a, i) => a + i) });
    const line = scoutLine(c);
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line).not.toContain("\n");
  });
});
