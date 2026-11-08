// The host PMs that mean our `!fb` was thrown away.
//
// The literal strings come from the 2026-09-07 lobby log: after Wherewolf ran
// SPADS's own `!balance`, the host answered every `!fb` the bot sent with the
// autoBlockBalance refusal — which the bot did not recognize, so it announced its
// 50/50 matchup for teams the lobby never got, twice, while the lobby played
// SPADS's split ("garbage balance", said the lobby).

import { describe, expect, it } from "vitest";
import { classifyForceRejection } from "../src/bot/forceRejection";

describe("classifyForceRejection", () => {
  it("recognizes the autoBlockBalance refusal that followed a player's !balance", () => {
    const r = classifyForceRejection(
      "Cannot force id/team, teams have been balanced and autoBlockBalance is enabled",
    );
    expect(r?.kind).toBe("balanceLock");
  });

  it("recognizes the autoBalance refusal", () => {
    const r = classifyForceRejection("Cannot force id/team, autoBalance is enabled");
    expect(r?.kind).toBe("autoBalance");
  });

  it("reads an unfamiliar refusal as transient, never as the autoBalance latch", () => {
    const r = classifyForceRejection("Cannot force id/team, some future reason");
    expect(r?.kind).toBe("other");
    expect(r?.reason).toContain("some future reason");
  });

  it("ignores anything that is not a force refusal", () => {
    expect(classifyForceRejection("autoBalance is enabled")).toBeNull();
    expect(classifyForceRejection("* Balancing according to current balance mode: skill")).toBeNull();
    expect(classifyForceRejection(".balance")).toBeNull();
  });
});
