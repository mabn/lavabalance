// The lobby's SPADS balanceMode → the one rule it changes for our balancer:
// whether parties constrain the split. "clan;skill" keeps them, "skill"/"random"
// balances every player individually; an unseen mode keeps them (BAR's default).

import { describe, expect, it } from "vitest";
import {
  balanceModeInfo,
  honoursParties,
  normalizeBalanceMode,
} from "../src/balance/balanceMode";
import { balanceTeams, type BalancePlayer, type LosState } from "../src/balance/balancer";

const st = (mu: number, sigma = 4, games = 50): LosState => ({ mu, sigma, games });

describe("normalizeBalanceMode", () => {
  it("lowercases and trims, and reports nothing as null", () => {
    expect(normalizeBalanceMode("  Clan;Skill ")).toBe("clan;skill");
    expect(normalizeBalanceMode("")).toBeNull();
    expect(normalizeBalanceMode("   ")).toBeNull();
    expect(normalizeBalanceMode(null)).toBeNull();
    expect(normalizeBalanceMode(undefined)).toBeNull();
  });
});

describe("honoursParties", () => {
  it("keeps parties for every mode naming clan", () => {
    expect(honoursParties("clan;skill")).toBe(true);
    expect(honoursParties("clan")).toBe(true);
    expect(honoursParties("skill;clan")).toBe(true);
    expect(honoursParties("Clan;Skill")).toBe(true); // the raw value, un-normalised
  });

  it("ignores parties for skill and random", () => {
    expect(honoursParties("skill")).toBe(false);
    expect(honoursParties("random")).toBe(false);
  });

  it("keeps parties when the host has not broadcast a mode (BAR's clan;skill default)", () => {
    expect(honoursParties(null)).toBe(true);
    expect(honoursParties(undefined)).toBe(true);
    expect(honoursParties("")).toBe(true);
  });

  it("does not match a mode that merely contains the letters 'clan'", () => {
    expect(honoursParties("clanless")).toBe(false);
  });
});

describe("balanceModeInfo", () => {
  it("labels the modes for the UI and .info", () => {
    expect(balanceModeInfo("Clan;Skill")).toEqual({
      mode: "clan;skill",
      parties: true,
      partyNote: "parties kept together",
      label: "clan;skill — parties kept together",
    });
    expect(balanceModeInfo("skill").label).toBe("skill — parties ignored");
    // "random" is deliberately balanced on skill — the bot does not roll dice.
    expect(balanceModeInfo("random").label).toBe("random (balanced on skill) — parties ignored");
    expect(balanceModeInfo(null).label).toBe("unknown (assuming clan;skill) — parties kept together");
  });
});

describe("the mode applied to a split (what runBalance does with it)", () => {
  // Four players, two of them a party of the two strongest. Keeping the party
  // together forces a lopsided split; ignoring it splits them.
  const lobby: BalancePlayer[] = [
    { name: "strongA", rating: st(40), partyId: "#ff0000" },
    { name: "strongB", rating: st(38), partyId: "#ff0000" },
    { name: "weakA", rating: st(16) },
    { name: "weakB", rating: st(14) },
  ];
  // bot.ts drops the partyId when the mode ignores parties; the same input otherwise.
  const asMode = (mode: string | null) =>
    balanceTeams(lobby.map((p) => ({ ...p, partyId: honoursParties(mode) ? p.partyId : null })));

  const teamOf = (r: ReturnType<typeof balanceTeams>, name: string) =>
    r.teamA.players.some((p) => p.name === name) ? "A" : "B";

  it("keeps the party on one team under clan;skill", () => {
    const r = asMode("clan;skill");
    expect(teamOf(r, "strongA")).toBe(teamOf(r, "strongB"));
    expect(Math.abs(r.winProbA - 0.5)).toBeGreaterThan(0.2); // stacked, and nothing to do about it
  });

  it("splits the party under skill, and gets a fair match out of it", () => {
    const r = asMode("skill");
    expect(teamOf(r, "strongA")).not.toBe(teamOf(r, "strongB"));
    expect(Math.abs(r.winProbA - 0.5)).toBeLessThan(0.05);
  });

  it("treats random like skill", () => {
    const random = asMode("random");
    expect(teamOf(random, "strongA")).not.toBe(teamOf(random, "strongB"));
    expect(random.winProbA).toBeCloseTo(asMode("skill").winProbA, 10);
  });

  it("keeps the party when the mode has not been broadcast yet", () => {
    const r = asMode(null);
    expect(teamOf(r, "strongA")).toBe(teamOf(r, "strongB"));
  });
});
