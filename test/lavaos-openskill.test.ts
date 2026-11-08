// Pins src/lavaos/openskill.ts to beyond-all-reason/openskill.ex (the library
// Teiserver runs in production), using the expected values from that repo's
// own test suite (test/openskill_test.exs). Both runtimes are IEEE-754
// doubles running the same operations, so rate() must match to rounding
// noise; predictWin's normal CDF is an erfc approximation good to ~1.2e-7,
// hence its looser tolerance.

import { describe, expect, test } from "vitest";
import { predictWin, predictWinFromSums } from "../src/lavaos/lava";
import { BETA, ordinal, phiMajor, predictWinLib, rate, ratingValue, type Rating } from "../src/lavaos/openskill";

const a1: Rating = { mu: 29.182, sigma: 4.782 };
const b1: Rating = { mu: 27.174, sigma: 4.922 };
const c1: Rating = { mu: 16.672, sigma: 6.217 };
const d1: Rating = { mu: 25, sigma: 25 / 3 };

function expectTeams(actual: Rating[][], expected: [number, number][][]) {
  actual.forEach((team, i) =>
    team.forEach((r, j) => {
      expect(r.mu).toBeCloseTo(expected[i][j][0], 9);
      expect(r.sigma).toBeCloseTo(expected[i][j][1], 9);
    }),
  );
}

describe("rate matches openskill.ex reference vectors", () => {
  test("plackett-luce, singles, tau 0", () => {
    expectTeams(rate([[a1], [b1], [c1], [d1]], { tau: 0 }), [
      [[30.209971908310553, 4.764898977359521]],
      [[27.64460833689499, 4.882789305097372]],
      [[17.403586731283518, 6.100723440599442]],
      [[19.214790707434826, 7.8542613981643985]],
    ]);
  });

  test("singles, tau 0.01", () => {
    expectTeams(rate([[a1], [b1], [c1], [d1]], { tau: 0.01, preventSigmaIncrease: false }), [
      [[30.20997558824299, 4.764909330988368]],
      [[27.64461002009721, 4.882799245921361]],
      [[17.403587237635527, 6.100731158882956]],
      [[19.21478808745494, 7.854267281042293]],
    ]);
  });

  test("singles, tau 0.01 + prevent_sigma_increase", () => {
    expectTeams(
      rate([[{ mu: 6.672, sigma: 0.0001 }], [a1]], { tau: 0.01, preventSigmaIncrease: true }),
      [[[6.672012533190158, 0.0001]], [[26.316243774876106, 4.7540633621019]]],
    );
  });

  test("teams, tau 0", () => {
    expectTeams(
      rate(
        [
          [a1, b1],
          [c1, d1],
        ],
        { tau: 0 },
      ),
      [
        [
          [29.607218266047376, 4.754597315295896],
          [27.624480490655575, 4.89211428863373],
        ],
        [
          [15.953288649990139, 6.125357588584119],
          [23.708690706816785, 8.111298027437888],
        ],
      ],
    );
  });

  test("teams, tau 0.01", () => {
    expectTeams(
      rate(
        [
          [a1, b1],
          [c1, d1],
        ],
        { tau: 0.01, preventSigmaIncrease: false },
      ),
      [
        [
          [29.60722003260825, 4.754607604502581],
          [27.624482251695827, 4.892124276331747],
        ],
        [
          [15.953286947567106, 6.1253654293947335],
          [23.708689129525133, 8.111303923213725],
        ],
      ],
    );
  });

  test("teams, tau 0.01 + prevent_sigma_increase", () => {
    expectTeams(
      rate(
        [
          [{ mu: 9.182, sigma: 0.0001 }, b1],
          [c1, d1],
        ],
        { tau: 0.01, preventSigmaIncrease: true },
      ),
      [
        [
          [9.182004653636957, 0.0001],
          [28.301285923165363, 4.889318394468611],
        ],
        [
          [14.87349383521136, 6.076727029758966],
          [21.768626152890867, 7.992333183226455],
        ],
      ],
    );
  });
});

describe("display values (balance_lib.ex)", () => {
  test("ordinal is mu - 3 sigma", () => {
    expect(ordinal({ mu: 30, sigma: 5 })).toBe(15);
    expect(ordinal(d1)).toBeCloseTo(0, 9);
  });

  test("ratingValue is max(mu - sigma, 0)", () => {
    expect(ratingValue({ mu: 30, sigma: 5 })).toBe(25);
    expect(ratingValue({ mu: 3, sigma: 5 })).toBe(0);
  });
});

describe("predictWinLib (Openskill.predict_win, library-exact)", () => {
  test("equal team mu sums -> 50/50", () => {
    const [pa, pb] = predictWinLib([
      [
        { mu: 25, sigma: 8.333 },
        { mu: 30, sigma: 6.666 },
      ],
      [
        { mu: 27, sigma: 7.0 },
        { mu: 28, sigma: 5.5 },
      ],
    ]);
    expect(pa).toBeCloseTo(0.5, 6);
    expect(pa + pb).toBeCloseTo(1, 6);
  });

  test("stronger team is favored", () => {
    expect(predictWinLib([[{ mu: 30, sigma: 8.333 }], [d1]])[0]).toBeGreaterThan(0.5);
  });
});

describe("predictWin (LOS predictor: per-player beta term)", () => {
  const team = (mu: number, sigma: number, n: number): Rating[] =>
    Array.from({ length: n }, () => ({ mu, sigma }));

  test("equal teams -> 50/50, sums to 1", () => {
    const [pa, pb] = predictWin([team(25, 8.333, 8), team(25, 8.333, 8)]);
    expect(pa).toBeCloseTo(0.5, 6);
    expect(pa + pb).toBeCloseTo(1, 6);
  });

  test("is phi(dmu / sqrt(16 beta^2 + var_a + var_b)) for an 8v8", () => {
    const a = team(30, 5, 8);
    const b = team(28, 6, 8);
    const dmu = 8 * 30 - 8 * 28;
    const denom = Math.sqrt(16 * BETA * BETA + 8 * 25 + 8 * 36);
    expect(predictWin([a, b])[0]).toBeCloseTo(phiMajor(dmu / denom), 9);
  });

  test("is less confident than the library's per-team term", () => {
    const a = team(30, 5, 8);
    const b = team(25, 5, 8);
    const lib = predictWinLib([a, b])[0];
    const los = predictWin([a, b])[0];
    expect(lib).toBeGreaterThan(0.5);
    expect(los).toBeGreaterThan(0.5);
    expect(los).toBeLessThan(lib);
  });

  test("the sums form agrees with the member form", () => {
    const a = team(30, 5, 8);
    const b = team(28, 6, 7);
    const sums = (t: Rating[]) => ({
      mu: t.reduce((s, r) => s + r.mu, 0),
      variance: t.reduce((s, r) => s + r.sigma * r.sigma, 0),
      players: t.length,
    });
    expect(predictWinFromSums(sums(a), sums(b))).toBeCloseTo(predictWin([a, b])[0], 12);
  });
});
