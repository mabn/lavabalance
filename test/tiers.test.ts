import { describe, expect, it } from "vitest";
import { DEMOTE_MARGIN, nextTierIndex, stripLos, TIER_KEYS, tierIndexOf, tierOf } from "../src/los/tiers";

describe("rank tiers", () => {
  it("places by fixed shown-LOS cutoffs, after 5 games", () => {
    expect(tierOf(40, 4)).toBe("placing");
    expect(tierOf(40, 5)).toBe("diamond");
    expect([11.9, 12, 16, 21, 28].map((l) => tierOf(l, 50))).toEqual(["bronze", "silver", "gold", "platinum", "diamond"]);
    expect(tierOf(null, 50)).toBeNull();
    expect(tierIndexOf(20, NaN)).toBe(0);
  });

  it("promotes at the cutoff and demotes only past the margin", () => {
    const gold = TIER_KEYS.indexOf("gold");
    expect(nextTierIndex(gold - 1, 16, 50)).toBe(gold); // reached → up
    expect(nextTierIndex(gold, 15, 50)).toBe(gold); // just under → stays
    expect(nextTierIndex(gold, 16 - DEMOTE_MARGIN - 0.01, 50)).toBe(gold - 1); // past the margin → down
    expect(nextTierIndex(TIER_KEYS.indexOf("diamond"), 13, 50)).toBe(TIER_KEYS.indexOf("silver")); // a big drop lands where it lands
    expect(nextTierIndex(null, 15, 50)).toBe(TIER_KEYS.indexOf("silver"));
  });

  it("nulls every LOS figure, however deep, and keeps the rest", () => {
    const body = {
      players: [{ name: "a", los: 3, mu: 25, tier: "gold", games: 9, teams: [[{ losBefore: 1, losDelta: 2, won: true }]] }],
      teamStats: [{ avg: 12, winProb: 0.5 }],
    };
    expect(stripLos(body)).toEqual({
      players: [{ name: "a", los: null, mu: null, tier: "gold", games: 9, teams: [[{ losBefore: null, losDelta: null, won: true }]] }],
      teamStats: [{ avg: null, winProb: 0.5 }],
    });
    expect(body.players[0].los).toBe(3); // a copy, not in place
  });
});
