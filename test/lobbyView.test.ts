import { describe, expect, it } from "vitest";
import {
  UNRATED_LOS,
  finalizeLobby,
  shapeScores,
  teamStats,
  type LosPlayer,
} from "../src/lobbyView";
import type { LosRatings } from "../src/losRatings";
import { rookieHandicap } from "../src/lavaos/lava";
import { MU, SIGMA } from "../src/lavaos/openskill";

const player = (over: Partial<LosPlayer> & { name: string }): LosPlayer => ({
  spectator: false,
  ally: 0,
  ...over,
});

const rating = (userId: number, mu: number, sigma: number, games: number, privateProfile = false) => ({
  userId,
  los: Math.max(mu - sigma, 0),
  mu,
  sigma,
  games,
  wins: 0,
  privateProfile,
});

const RATINGS: LosRatings = {
  // keyed by LOWERCASED name — lookups must be case-insensitive.
  huk123: rating(357541, 40, 5, 120),
  songi: rating(61, 30, 6, 80),
  weakling: rating(7, 15, 7, 30),
};

const ROSTER: LosPlayer[] = [
  player({ name: "huk123", ally: 0 }),
  player({ name: "Songi", ally: 0 }), // real-case roster name vs lowercased key
  player({ name: "weakling", ally: 1 }),
  player({ name: "Nobody", ally: 1 }), // never rated → assumed UNRATED_LOS
  player({ name: "watcher", spectator: true, ally: 0 }),
];

describe("UNRATED_LOS", () => {
  it("is a debutant's effective LOS (mu minus the game-0 handicap, minus sigma)", () => {
    expect(UNRATED_LOS).toBeCloseTo(MU - rookieHandicap(0) - SIGMA, 6);
    expect(UNRATED_LOS).toBeCloseTo(3.67, 2);
  });
});

describe("teamStats", () => {
  it("averages each ally team's LOS, excluding spectators, counting unrated as UNRATED_LOS", () => {
    const stats = teamStats(ROSTER, RATINGS);
    expect(stats).toHaveLength(2);
    expect(stats[0]).toMatchObject({
      ally: 0,
      players: 2,
      avg: (35 + 24) / 2,
      assumed: 0,
    });
    expect(stats[1]).toMatchObject({
      ally: 1,
      players: 2,
      avg: (8 - rookieHandicap(30) + UNRATED_LOS) / 2, // weakling: 30 games, still handicapped
      assumed: 1,
    });
  });

  it("attaches complementary win probabilities for a two-team lobby, favoring the stronger side", () => {
    const [a, b] = teamStats(ROSTER, RATINGS);
    expect(a.winProb).not.toBeNull();
    expect(b.winProb).not.toBeNull();
    expect(a.winProb! + b.winProb!).toBeCloseTo(1, 6);
    expect(a.winProb!).toBeGreaterThan(0.5); // team 0 is far stronger
  });

  it("computes no win probability for a lobby that isn't two teams", () => {
    const oneTeam = ROSTER.filter((p) => p.ally === 0);
    expect(teamStats(oneTeam, RATINGS)[0]!.winProb).toBeNull();
    const ffa = [
      player({ name: "a", ally: 0 }),
      player({ name: "b", ally: 1 }),
      player({ name: "c", ally: 2 }),
    ];
    for (const s of teamStats(ffa, {})) expect(s.winProb).toBeNull();
  });

  it("returns nothing for a roster of spectators only", () => {
    expect(teamStats([player({ name: "watcher", spectator: true })], {})).toEqual([]);
  });
});

describe("finalizeLobby", () => {
  it("attaches per-player LOS fields and the team stats", () => {
    const out = finalizeLobby({ players: ROSTER }, RATINGS);
    expect(out.teamStats).toEqual(teamStats(ROSTER, RATINGS));
    expect(out.players.find((p) => p.name === "Songi")).toMatchObject({
      los: 24,
      losGames: 80,
      losUserId: 61,
      losHandicap: 0, // established player — no rookie discount
    });
    // A never-rated player carries nulls (the UI shows no pill; the averages
    // already counted them as UNRATED_LOS).
    expect(out.players.find((p) => p.name === "Nobody")).toMatchObject({
      los: null,
      losGames: null,
      losUserId: null,
      losHandicap: null,
    });
  });

  it("numbers each player's place by displayed LOS, a withheld rating last", () => {
    const ratings: LosRatings = { ...RATINGS, hidden: rating(9, 50, 3, 200, true) };
    const roster = [...ROSTER, player({ name: "hidden", ally: 1 })];
    const out = finalizeLobby({ players: roster }, ratings);
    // The array keeps its own order; losOrder is what a visitor's page sorts by.
    expect(out.players.map((p) => p.name)).toEqual(roster.map((p) => p.name));
    const byOrder = [...out.players].sort((a, b) => a.losOrder - b.losOrder).map((p) => p.name);
    expect(byOrder).toEqual(["huk123", "Songi", "weakling", "Nobody", "watcher", "hidden"]);
  });

  it("attaches the rookie mu handicap for players in their first 35 rated games", () => {
    const ratings: LosRatings = {
      fresh: rating(1, 25, 8, 0),
      once: rating(2, 25, 8, 1),
      twice: rating(3, 25, 8, 2),
      tenth: rating(4, 25, 8, 10),
      twentieth: rating(5, 25, 8, 20),
      settled: rating(6, 25, 8, 35),
    };
    const out = finalizeLobby(
      { players: ["fresh", "once", "twice", "tenth", "twentieth", "settled"].map((name) => player({ name })) },
      ratings,
    );
    const handicapOf = (name: string) => out.players.find((p) => p.name === name)!.losHandicap;
    expect(handicapOf("fresh")).toBeCloseTo(13, 6);
    expect(handicapOf("once")).toBeCloseTo(13 * Math.exp(-1 / 25), 6);
    expect(handicapOf("twice")).toBeCloseTo(13 * Math.exp(-2 / 25), 6);
    expect(handicapOf("tenth")).toBeCloseTo(13 * Math.exp(-10 / 25), 6);
    expect(handicapOf("twentieth")).toBeCloseTo(13 * Math.exp(-20 / 25), 6);
    expect(handicapOf("settled")).toBe(0);
  });

  it("rounds the wire LOS to two decimals", () => {
    const ratings: LosRatings = { x: rating(1, 25.123456, 8.001234, 5) };
    const out = finalizeLobby({ players: [player({ name: "x" })] }, ratings);
    expect(out.players[0]!.los).toBe(Math.round((25.123456 - rookieHandicap(5) - 8.001234) * 100) / 100);
    expect(out.players[0]!.losRaw).toBe(Math.round((25.123456 - 8.001234) * 100) / 100);
  });
});

describe("shapeScores", () => {
  const stored = {
    huk123: { playerId: 542, rating: 3571, ratingHidden: 3567, wins: 162, losses: 128, games: 290, winRate: 0.56 },
    godofwar09: { playerId: 0, rating: null, ratingHidden: 4022, wins: 0, losses: 0, games: 0, winRate: 0 },
  };

  it("serves the public record; a hidden-only player is the bare flag", () => {
    const out = shapeScores(stored);
    expect(out["huk123"]).toEqual({
      playerId: 542, rating: 3571, wins: 162, losses: 128, games: 290, winRate: 0.56,
    });
    expect(out["godofwar09"]).toEqual({ hidden: true });
    expect(JSON.stringify(out)).not.toContain("4022");
  });

  it("attaches the hidden elo when show_hidden_score is set", () => {
    expect(shapeScores(stored, true)["godofwar09"]).toEqual({ hidden: true, rating: 4022 });
  });
});

describe("private profiles", () => {
  const roster = [
    player({ name: "huk123", ally: 0 }),
    player({ name: "Songi", ally: 1 }),
    player({ name: "weakling", ally: 1 }),
  ];
  // Songi is hidden; the rating map still carries their REAL numbers, because
  // that is what the bot balances on.
  const ratings: LosRatings = {
    huk123: rating(357541, 40, 5, 120),
    songi: rating(61, 30, 6, 80, true),
    weakling: rating(7, 15, 7, 30),
  };

  it("withholds the rating but not the identity, the games or the team numbers", () => {
    const open = finalizeLobby({ players: roster }, ratings);
    const hidden = open.players.find((p) => p.name === "Songi")!;
    expect(hidden.los).toBeNull();
    expect(hidden.losHandicap).toBeNull();
    expect(hidden.losPrivate).toBe(true);
    // Kept: who they are (so the name still links) and their game count, which
    // the public games list already tells anyone.
    expect(hidden.losUserId).toBe(61);
    expect(hidden.losGames).toBe(80);
    // Everyone else is untouched.
    const other = open.players.find((p) => p.name === "weakling")!;
    expect(other.los).toBeCloseTo(8 - rookieHandicap(30), 2);
    expect(other.losPrivate).toBe(false);

    // The team numbers are the MATCH's, identical to what an admin sees: a mean
    // taken from the visible values would count the hidden player as a debutant
    // and both move the number and leak their rating by the difference.
    const admin = finalizeLobby({ players: roster }, ratings, { includePrivate: true });
    expect(open.teamStats).toEqual(admin.teamStats);
    expect(admin.players.find((p) => p.name === "Songi")!.los).toBeCloseTo(24, 9);
    expect(admin.players.find((p) => p.name === "Songi")!.losPrivate).toBe(false);
    // …and really did count them, rather than dropping them from the average.
    const theirTeam = open.teamStats.find((t) => t.ally === 1)!;
    expect(theirTeam.players).toBe(2);
    expect(theirTeam.assumed).toBe(0);
    expect(theirTeam.avg).toBeCloseTo((24 + 8 - rookieHandicap(30)) / 2, 9);
  });
});
