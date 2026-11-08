// Unit tests for the LOS pure logic (src/los/losGames.ts): upload
// classification and the rating fold, pinned against the shared
// src/lavaos rating primitives it must mirror.

import { describe, expect, it } from "vitest";
import {
  rookieHandicap,
  losEffectiveRating,
  startMetalReason,
  unrateableReason,
} from "../src/lavaos/lava";
import { MU, SIGMA, rate } from "../src/lavaos/openskill";
import {
  applyRatedGame,
  classifyReplay,
  losOf,
  predictTeams,
  type PlayerState,
} from "../src/los/losGames";
import { lavaReplay } from "./losFixtures";

const T = "2026-08-15T18:00:00.000Z";

describe("classifyReplay", () => {
  it("rejects a non-lava game", () => {
    const r = classifyReplay(lavaReplay({ id: "g1", startTime: T, gameSettings: {} }));
    expect(r).toEqual({ kind: "rejected" });
  });

  it("skips lava games that fail eligibility, with the reason", () => {
    expect(classifyReplay(lavaReplay({ id: "g1", startTime: T, winner: null }))).toEqual({
      kind: "skipped",
      reason: "no winning team",
    });
    expect(classifyReplay(lavaReplay({ id: "g2", startTime: T, hasBots: true }))).toEqual({
      kind: "skipped",
      reason: "has bots",
    });
    expect(classifyReplay(lavaReplay({ id: "g3", startTime: T, durationMs: 60_000 }))).toEqual({
      kind: "skipped",
      reason: "too short",
    });
    // The map-independent rules apply off-map too: a malformed game is
    // skipped whatever it ran on.
    expect(
      classifyReplay(lavaReplay({ id: "g5", startTime: T, mapName: "Hellas Basin v1.4", winner: null })),
    ).toEqual({ kind: "skipped", reason: "no winning team" });
  });

  it("keeps an off-map lava game, marked unrateable", () => {
    const r = classifyReplay(lavaReplay({ id: "g4", startTime: T, mapName: "Hellas Basin v1.4" }));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.rateable).toBe(false);
    expect(r.game.map).toBe("Hellas Basin v1.4");
    expect(r.game.players).toHaveLength(16);
  });

  it("extracts a rateable game with the ally-team-level team convention", () => {
    const r = classifyReplay(lavaReplay({ id: "g1", startTime: T, winner: 1, skills: { 101: "[30.9]" } }));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.rateable).toBe(true);
    expect(r.game.id).toBe("g1");
    expect(r.game.winnerTeam).toBe(1);
    expect(r.game.players).toHaveLength(16);
    const p101 = r.game.players.find((p) => p.userId === 101)!;
    // team from the ALLY-TEAM-level allyTeamId (0), not the player-level row id (5000000)
    expect(p101.team).toBe(0);
    expect(p101.won).toBe(false);
    expect(p101.barSkill).toBe(30.9);
    expect(r.game.players.filter((p) => p.won)).toHaveLength(8);
  });

  // The chevron is the only BAR-wide experience reading a replay carries, and
  // it is stamped per game — so it must survive extraction exactly, including
  // level 0, which is a real level (an account with under five hours) and not
  // a stand-in for the API's own null.
  it("extracts the per-game chevron, keeping 0 distinct from unstated", () => {
    const r = classifyReplay(
      lavaReplay({ id: "g1", startTime: T, ranks: { 101: 5, 102: 0, 104: 99, 105: 1.5 as number } }),
    );
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    const rankOf = (userId: number) => r.game.players.find((p) => p.userId === userId)!.barRank;
    expect(rankOf(101)).toBe(5);
    expect(rankOf(102)).toBe(0);
    expect(rankOf(103)).toBeNull(); // the fixture's default: the API stated none
    expect(rankOf(104)).toBeNull(); // out of range
    expect(rankOf(105)).toBeNull(); // not a level
  });
});

// From 2026-10-01 00:00 UTC only games started with 4000 metal storage are
// rated; before it every value counts. A game under the rule with some other
// value is a real 8v8, stored unranked like an off-map one; one whose replay
// carries no value at all cannot be judged and is skipped.
describe("start metal storage rule", () => {
  const BEFORE = "2026-09-30T23:59:59.000Z";
  const AT = "2026-10-01T00:00:00.000Z";
  const game = (startTime: string, startMetalStorage: string | null, mapName?: string) =>
    classifyReplay(lavaReplay({ id: "g", startTime, startMetalStorage, mapName }));

  it("rates any storage before the cutoff, only 4000 from it", () => {
    for (const v of ["4000", "3000", "10000", null]) {
      const r = game(BEFORE, v);
      expect(r.kind === "ok" && r.rateable, `before, ${v}`).toBe(true);
    }
    const ok = game(AT, "4000");
    expect(ok.kind === "ok" && ok.rateable).toBe(true);
    if (ok.kind === "ok") expect(ok.game.startMetalStorage).toBe(4000);
    for (const v of ["3000", "4001", "1000"]) {
      const r = game(AT, v);
      expect(r.kind).toBe("ok");
      if (r.kind !== "ok") continue;
      expect([r.rateable, r.unranked, r.game.startMetalStorage]).toEqual([false, "start metal storage", Number(v)]);
    }
  });

  it("skips a game under the rule whose replay has no value", () => {
    expect(game(AT, null)).toEqual({ kind: "skipped", reason: "no start metal storage" });
    expect(game(AT, "")).toEqual({ kind: "skipped", reason: "no start metal storage" });
  });

  it("labels an off-map game off-map even when its storage is wrong too", () => {
    const r = game(AT, "3000", "Hellas Basin v1.4");
    expect(r.kind === "ok" && r.unranked).toBe("off-map");
  });

  it("is the same rule the offline oracle and the rebase judge by", () => {
    expect(unrateableReason(lavaReplay({ id: "g", startTime: AT, startMetalStorage: "3000" }))).toBe(
      "start metal storage",
    );
    expect(unrateableReason(lavaReplay({ id: "g", startTime: AT }))).toBeNull();
    expect(startMetalReason(BEFORE, 3000)).toBeNull();
    expect(startMetalReason(AT, 4000)).toBeNull();
    expect(startMetalReason(AT, 3000)).toBe("start metal storage");
    expect(startMetalReason(AT, null)).toBe("no start metal storage");
  });
});

describe("applyRatedGame", () => {
  const okGame = (id: string, winner: 0 | 1 = 0) => {
    const c = classifyReplay(lavaReplay({ id, startTime: T, winner }));
    if (c.kind !== "ok") throw new Error("fixture not rateable");
    return c.game;
  };

  it("creates debutants at the default rating and moves winners up, losers down", () => {
    const { transitions, states } = applyRatedGame(okGame("g1"), () => undefined);
    expect(states).toHaveLength(16);
    expect(transitions).toHaveLength(16);
    for (const t of transitions) {
      expect(t.gameNumber).toBe(1);
      expect(t.muBefore).toBe(MU);
      expect(t.sigmaBefore).toBe(SIGMA);
    }
    for (const s of states) {
      expect(s.games).toBe(1);
      const won = s.userId < 200;
      expect(s.wins).toBe(won ? 1 : 0);
      expect(won ? s.mu > MU : s.mu < MU).toBe(true);
      expect(s.sigma).toBeLessThanOrEqual(SIGMA); // prevent_sigma_increase
    }
  });

  it("matches a direct rate() call with the rookie handicap applied and added back", () => {
    // Seed: everyone has 1 prior game (handicap 13·e^(−1/25) ≈ 12.49 at prior=1).
    const seeded = new Map<number, PlayerState>();
    const first = applyRatedGame(okGame("g1"), () => undefined);
    for (const s of first.states) seeded.set(s.userId, s);

    const game = okGame("g2", 1);
    const { transitions } = applyRatedGame(game, (id) => seeded.get(id));

    // Reference: the exact CLI computation for the same game.
    const teams = [game.players.filter((p) => p.won), game.players.filter((p) => !p.won)];
    const ref = rate(
      teams.map((t) => t.map((p) => losEffectiveRating(seeded.get(p.userId)!, 1))),
    );
    teams.forEach((team, i) =>
      team.forEach((p, j) => {
        const t = transitions.find((x) => x.userId === p.userId)!;
        expect(t.muAfter).toBeCloseTo(ref[i][j].mu + rookieHandicap(1), 12);
        expect(t.sigmaAfter).toBeCloseTo(ref[i][j].sigma, 12);
        expect(t.gameNumber).toBe(2);
      }),
    );
  });

  it("does not mutate the states handed to it", () => {
    const first = applyRatedGame(okGame("g1"), () => undefined);
    const before = structuredClone(first.states);
    const map = new Map(first.states.map((s) => [s.userId, s]));
    applyRatedGame(okGame("g2"), (id) => map.get(id));
    expect(first.states).toEqual(before);
  });
});

describe("predictTeams / losOf", () => {
  it("predicts ~50/50 for equal debutant teams and sums to 1", () => {
    const teams = [0, 1].map(() =>
      Array.from({ length: 8 }, () => ({ muBefore: MU, sigmaBefore: SIGMA, gameNumber: 1 })),
    );
    const [a, b] = predictTeams(teams);
    // predictWin's erfc approximation is good to ~1e-6, not machine precision.
    expect(a + b).toBeCloseTo(1, 6);
    expect(a).toBeCloseTo(0.5, 6);
  });

  it("losOf clamps at zero", () => {
    expect(losOf(25, 25 / 3)).toBeCloseTo(16.6667, 3);
    expect(losOf(1, 5)).toBe(0);
  });
});
