// The local, party-aware LOS balancer: objective = the OpenSkill predictWin
// closest to 50/50 (sizes first), parties never broken, deterministic.

import { describe, expect, it } from "vitest";
import {
  AVOID_WIN_MAX,
  AVOID_WIN_MIN,
  balanceTeams,
  balanceTeamsWithPartySplit,
  PARTY_SPLIT_MAX_WIN,
  ROOKIE_SPLIT_GAMES,
  ROOKIE_SPLIT_TOLERANCE,
  shownLos,
  teamsWinProb,
  UNRATED_LOS,
  UNRATED_STATE,
  type BalancePlayer,
  type LosState,
} from "../src/balance/balancer";
import { losEffectiveRating, predictWin, rookieHandicap } from "../src/lavaos/lava";
import { MU, SIGMA } from "../src/lavaos/openskill";

const st = (mu: number, sigma = 4, games = 50): LosState => ({ mu, sigma, games });
const player = (name: string, rating: LosState | null, partyId?: string): BalancePlayer => ({
  name,
  rating,
  partyId,
});

/** A spread-out 16-player lobby (μ 12..42, varied σ). */
const LOBBY: BalancePlayer[] = Array.from({ length: 16 }, (_, i) =>
  player("p" + i, st(12 + i * 2, 3 + (i % 4), 20 + i)),
);

const names = (t: { players: BalancePlayer[] }) => t.players.map((p) => p.name).sort();

/** predictWin for two explicit member lists, rookie handicap applied — the oracle. */
function oracleWinProb(a: BalancePlayer[], b: BalancePlayer[]): number {
  const eff = (p: BalancePlayer) => {
    const s = p.rating ?? UNRATED_STATE;
    return losEffectiveRating(s, s.games);
  };
  return predictWin([a.map(eff), b.map(eff)])[0];
}

describe("balanceTeams — LOS predictWin objective", () => {
  it("returns the GLOBAL optimum 8v8 (ties the exhaustive predictWin search)", () => {
    const r = balanceTeams(LOBBY);
    expect(r.teamA.players).toHaveLength(8);
    expect(r.teamB.players).toHaveLength(8);
    expect(r.sizeCompromised).toBe(false);

    // Brute-force every 8v8 split (pin player 0) and find the best |p − ½|.
    let best = Infinity;
    for (let mask = 0; mask < 1 << 16; mask++) {
      if ((mask & 1) === 0) continue;
      const a: BalancePlayer[] = [];
      const b: BalancePlayer[] = [];
      for (let i = 0; i < 16; i++) (mask & (1 << i) ? a : b).push(LOBBY[i]);
      if (a.length !== 8) continue;
      best = Math.min(best, Math.abs(oracleWinProb(a, b) - 0.5));
    }
    expect(Math.abs(r.winProbA - 0.5)).toBeCloseTo(best, 9);
  });

  it("reports winProbA consistent with the oracle and complements to 1", () => {
    const r = balanceTeams(LOBBY);
    const p = oracleWinProb(r.teamA.players, r.teamB.players);
    expect(r.winProbA).toBeCloseTo(p, 9);
    expect(oracleWinProb(r.teamB.players, r.teamA.players)).toBeCloseTo(1 - p, 6);
  });

  it("is deterministic and order-independent in outcome quality", () => {
    const a = balanceTeams(LOBBY);
    const b = balanceTeams([...LOBBY].reverse());
    expect(Math.abs(a.winProbA - 0.5)).toBeCloseTo(Math.abs(b.winProbA - 0.5), 9);
    expect(balanceTeams(LOBBY).teamA.players.map((p) => p.name)).toEqual(
      a.teamA.players.map((p) => p.name),
    );
  });

  it("team avg is the mean SHOWN LOS, with unrated counted as UNRATED_LOS", () => {
    const roster = [
      player("a", st(30, 5)),
      player("b", st(20, 5)),
      player("c", null),
      player("d", st(26, 5)),
    ];
    const r = balanceTeams(roster);
    for (const team of [r.teamA, r.teamB]) {
      const mean =
        team.players.reduce((s, p) => s + (p.rating ? shownLos(p.rating) : UNRATED_LOS), 0) /
        team.players.length;
      expect(team.avg).toBeCloseTo(mean, 9);
    }
    expect(r.unrated).toEqual(["c"]);
  });
});

describe("balanceTeams — parties", () => {
  it("never splits a party", () => {
    const roster = LOBBY.map((p, i) => ({ ...p, partyId: i < 3 ? "red" : i < 5 ? "blue" : null }));
    const r = balanceTeams(roster);
    for (const partyId of ["red", "blue"]) {
      const inA = r.teamA.players.filter((p) => p.partyId === partyId).length;
      const inB = r.teamB.players.filter((p) => p.partyId === partyId).length;
      expect(inA === 0 || inB === 0).toBe(true);
    }
    expect(r.teamA.players).toHaveLength(8);
    expect(r.sizeCompromised).toBe(false);
  });

  it("flags sizeCompromised when parties make an even split impossible", () => {
    const roster = [
      player("a", st(30), "big"),
      player("b", st(28), "big"),
      player("c", st(26), "big"),
      player("d", st(24)),
    ];
    const r = balanceTeams(roster);
    expect(names(r.teamA)).toEqual(["a", "b", "c"]);
    expect(names(r.teamB)).toEqual(["d"]);
    expect(r.sizeCompromised).toBe(true);
  });

  it("a lobby that is entirely one party is one team, sizeCompromised", () => {
    const roster = [player("a", st(30), "x"), player("b", st(20), "x")];
    const r = balanceTeams(roster);
    expect(names(r.teamA)).toEqual(["a", "b"]);
    expect(r.teamB.players).toHaveLength(0);
    expect(r.sizeCompromised).toBe(true);
  });
});

describe("balanceTeamsWithPartySplit — party splitting", () => {
  // The two strongest players stacked in one party: no party-constrained 2v2
  // can get either side's win chance under PARTY_SPLIT_MAX_WIN.
  const stacked = [
    player("a", st(40, 3), "top"),
    player("b", st(38, 3), "top"),
    player("c", st(12, 3)),
    player("d", st(14, 3)),
  ];

  it("splits a too-strong party and flags partiesIgnored", () => {
    const constrained = balanceTeams(stacked);
    expect(constrained.partiesIgnored).toBe(false); // balanceTeams never splits
    expect(Math.max(constrained.winProbA, 1 - constrained.winProbA)).toBeGreaterThan(
      PARTY_SPLIT_MAX_WIN,
    );

    const r = balanceTeamsWithPartySplit(stacked);
    expect(r.partiesIgnored).toBe(true);
    // The party is broken up: one strong player per side, and a fair matchup.
    // (The returned players carry partyId null — the re-run ignored parties.)
    const strongInA = r.teamA.players.filter((p) => p.name === "a" || p.name === "b").length;
    expect(strongInA).toBe(1);
    expect(r.teamA.players.every((p) => p.partyId === null)).toBe(true);
    expect(Math.max(r.winProbA, 1 - r.winProbA)).toBeLessThan(PARTY_SPLIT_MAX_WIN);
  });

  it("keeps parties together when the constrained split is fair enough", () => {
    const roster = [
      player("a", st(25, 3), "duo"),
      player("b", st(24, 3), "duo"),
      player("c", st(26, 3)),
      player("d", st(23, 3)),
    ];
    const r = balanceTeamsWithPartySplit(roster);
    expect(r.partiesIgnored).toBe(false);
    const inA = r.teamA.players.filter((p) => p.partyId === "duo").length;
    const inB = r.teamB.players.filter((p) => p.partyId === "duo").length;
    expect(inA === 0 || inB === 0).toBe(true);
    expect(Math.max(r.winProbA, 1 - r.winProbA)).toBeLessThanOrEqual(PARTY_SPLIT_MAX_WIN);
  });

  it("is exactly balanceTeams when there are no parties", () => {
    const roster = [
      player("a", st(40, 3)),
      player("b", st(38, 3)),
      player("c", st(12, 3)),
      player("d", st(14, 3)),
    ];
    expect(balanceTeamsWithPartySplit(roster)).toEqual(balanceTeams(roster));
  });
});

describe("teamsWinProb / shownLos", () => {
  it("favors the stronger side and treats null as a debutant", () => {
    const strong = [st(35, 4), st(33, 4)];
    const weak = [null, null]; // two debutants
    const p = teamsWinProb(strong, weak);
    expect(p).toBeGreaterThan(0.9);
    expect(teamsWinProb(weak, strong)).toBeCloseTo(1 - p, 6);
  });

  it("shownLos is max(mu − sigma, 0), or the unrated assumption", () => {
    expect(shownLos(st(30, 5))).toBe(25);
    expect(shownLos(null)).toBeCloseTo(UNRATED_LOS, 9);
    expect(UNRATED_LOS).toBeCloseTo(MU - rookieHandicap(0) - SIGMA, 6);
  });
});

describe("avoid lists", () => {
  // Four equals: every 2v2 is a 50/50, so honouring an avoid costs nothing.
  const equals: BalancePlayer[] = ["p0", "p1", "p2", "p3"].map((n) => player(n, st(25)));

  it("leaves the split alone when nobody asked", () => {
    const r = balanceTeams(equals);
    expect(r.avoid).toEqual({
      requested: [],
      honoured: [],
      violated: [],
      applied: false,
      skippedForBalance: false,
    });
  });

  it("separates an avoid pair the pure-balance split had together", () => {
    const plain = balanceTeams(equals);
    expect(names(plain.teamA)).toEqual(["p0", "p1"]); // the pair, together

    const r = balanceTeams(equals, { avoid: [{ a: "p0", b: "p1" }] });
    const teamOf = (n: string) => (names(r.teamA).includes(n) ? "A" : "B");
    expect(teamOf("p0")).not.toBe(teamOf("p1"));
    expect(r.avoid.applied).toBe(true);
    expect(r.avoid.honoured).toEqual([{ a: "p0", b: "p1" }]);
    expect(r.avoid.violated).toEqual([]);
    expect(r.avoid.skippedForBalance).toBe(false);
    // Not at the cost of the sizes, and still a coin flip.
    expect(r.teamA.players).toHaveLength(2);
    expect(Math.abs(r.winProbA - 0.5)).toBeLessThan(0.001);
  });

  it("matches names case-insensitively and ignores people not in the lobby", () => {
    const r = balanceTeams(equals, { avoid: [{ a: "P0", b: "P1" }, { a: "p0", b: "ghost" }] });
    expect(r.avoid.requested).toEqual([{ a: "p0", b: "p1" }]);
    expect(r.avoid.honoured).toEqual([{ a: "p0", b: "p1" }]);
  });

  it("drops the request when honouring it would skew the match past the band", () => {
    // A(40) + B(10) against C(25) + D(25) is the only 50/50 here: splitting A
    // from B puts both strong-ish players on one side.
    const stacked = [player("A", st(40)), player("B", st(10)), player("C", st(25)), player("D", st(25))];
    const plain = balanceTeams(stacked);
    expect(names(plain.teamA)).toEqual(["A", "B"]);

    const r = balanceTeams(stacked, { avoid: [{ a: "a", b: "b" }] });
    expect(names(r.teamA)).toEqual(["A", "B"]); // unchanged: balance wins
    expect(r.avoid.applied).toBe(false);
    expect(r.avoid.skippedForBalance).toBe(true);
    expect(r.avoid.violated).toEqual([{ a: "a", b: "b" }]);
    expect(r.winProbA).toBeGreaterThanOrEqual(AVOID_WIN_MIN);
    expect(r.winProbA).toBeLessThanOrEqual(AVOID_WIN_MAX);
  });

  it("honours as many as it can and reports the rest, sizes intact", () => {
    // p0 asked to avoid everyone — in a 2v2 one of them is always a teammate.
    const r = balanceTeams(equals, {
      avoid: [
        { a: "p0", b: "p1" },
        { a: "p0", b: "p2" },
        { a: "p0", b: "p3" },
      ],
    });
    expect(r.teamA.players).toHaveLength(2);
    expect(r.avoid.honoured).toHaveLength(2);
    expect(r.avoid.violated).toHaveLength(1);
    // Nothing better exists, so this is not the band standing in the way.
    expect(r.avoid.skippedForBalance).toBe(false);
  });

  it("counts a pair inside one party as unhonourable rather than breaking the party", () => {
    const partied = [
      player("p0", st(25), "red"),
      player("p1", st(25), "red"),
      player("p2", st(25)),
      player("p3", st(25)),
    ];
    const r = balanceTeams(partied, { avoid: [{ a: "p0", b: "p1" }] });
    const teamOf = (n: string) => (names(r.teamA).includes(n) ? "A" : "B");
    expect(teamOf("p0")).toBe(teamOf("p1")); // the party held
    expect(r.avoid.violated).toEqual([{ a: "p0", b: "p1" }]);
    expect(r.avoid.applied).toBe(false);
  });

  it("carries the avoids through the party-split re-run", () => {
    // Two strong players partied together: the constrained split is past
    // PARTY_SPLIT_MAX_WIN, so the parties are dropped — and the avoid pair the
    // re-run inherits is still honoured.
    const lobby = [
      player("s0", st(40), "red"),
      player("s1", st(40), "red"),
      player("w0", st(10)),
      player("w1", st(10)),
    ];
    const r = balanceTeamsWithPartySplit(lobby, { avoid: [{ a: "w0", b: "w1" }] });
    expect(r.partiesIgnored).toBe(true);
    const teamOf = (n: string) => (names(r.teamA).includes(n) ? "A" : "B");
    expect(teamOf("w0")).not.toBe(teamOf("w1"));
    expect(r.avoid.honoured).toEqual([{ a: "w0", b: "w1" }]);
  });
});

describe("balanceTeams — rookie tie-break", () => {
  /** Deterministic pseudo-random lobby: `rookies` players under ROOKIE_SPLIT_GAMES games. */
  function lobby(seed: number, rookies: number): BalancePlayer[] {
    let x = seed;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
    return Array.from({ length: 16 }, (_, i) =>
      player(
        "r" + i,
        i < rookies
          ? st(18 + rnd() * 20, 7 + rnd(), Math.floor(rnd() * ROOKIE_SPLIT_GAMES))
          : st(15 + rnd() * 25, 3 + rnd() * 3, 40 + Math.floor(rnd() * 300)),
      ),
    );
  }

  /** Brute force: the best |p − ½| and the fewest-rookie-gap split within the tolerance of it. */
  function oracle(ps: BalancePlayer[]) {
    const splits: { imbalance: number; gap: number }[] = [];
    for (let mask = 0; mask < 1 << 16; mask++) {
      if ((mask & 1) === 0) continue;
      const a: BalancePlayer[] = [];
      const b: BalancePlayer[] = [];
      for (let i = 0; i < 16; i++) (mask & (1 << i) ? a : b).push(ps[i]);
      if (a.length !== 8) continue;
      const rk = (t: BalancePlayer[]) => t.filter((p) => p.rating!.games < ROOKIE_SPLIT_GAMES).length;
      splits.push({ imbalance: Math.abs(oracleWinProb(a, b) - 0.5), gap: Math.abs(rk(a) - rk(b)) });
    }
    const best = splits.reduce((m, s) => (s.imbalance < m.imbalance ? s : m));
    const gap = Math.min(
      ...splits.filter((s) => s.imbalance <= best.imbalance + ROOKIE_SPLIT_TOLERANCE).map((s) => s.gap),
    );
    return { best, gap };
  }

  it("spreads the rookies as evenly as a split within 2 pp of the best allows", () => {
    expect(ROOKIE_SPLIT_TOLERANCE).toBe(0.02);
    let triggered = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const ps = lobby(seed, 6);
      const r = balanceTeams(ps);
      const o = oracle(ps);
      expect(r.rookies.count).toBe(6);
      expect(r.rookies.gap).toBe(o.gap);
      expect(Math.abs(r.winProbA - 0.5)).toBeLessThanOrEqual(o.best.imbalance + ROOKIE_SPLIT_TOLERANCE + 1e-12);
      expect(r.rookies.tieBreak).toBe(o.best.gap > o.gap);
      if (r.rookies.tieBreak) triggered++;
    }
    expect(triggered).toBeGreaterThan(0);
  });

  it("leaves a lobby without rookies at the pure-balance optimum", () => {
    const r = balanceTeams(LOBBY);
    expect(r.rookies).toEqual({ count: 0, gap: 0, tieBreak: false });
  });

  it("does not count rookies who are in a party", () => {
    const ps = lobby(7, 4).map((p, i) => (i < 2 ? { ...p, partyId: "duo" } : p));
    const r = balanceTeams(ps);
    expect(r.rookies.count).toBe(2);
    const sameTeam = [r.teamA, r.teamB].some((t) => t.players.filter((p) => p.partyId === "duo").length === 2);
    expect(sameTeam).toBe(true);
  });
});
