// The avoid-list wire module (src/avoids.ts): name normalisation, the
// add/remove payload validator, and the pair reduction the balancer consumes.

import { describe, expect, it } from "vitest";
import {
  avoidKey,
  avoidName,
  avoidPairsOf,
  MAX_AVOIDS_PER_PLAYER,
  parseAvoidRequest,
  validAvoidName,
  type AvoidEntry,
} from "../src/avoids";

const entry = (owner: string, avoid: string): AvoidEntry => ({
  owner,
  avoid,
  avoidUserId: 1,
  createdAt: "2026-09-21T00:00:00.000Z",
});

describe("name handling", () => {
  it("keys case-insensitively and keeps the display spelling", () => {
    expect(avoidKey("  HuK123 ")).toBe("huk123");
    expect(avoidName("  HuK123 ")).toBe("HuK123");
  });

  it("accepts a lobby account name and refuses what cannot be one", () => {
    expect(validAvoidName("huk123")).toBe(true);
    expect(validAvoidName("")).toBe(false);
    expect(validAvoidName("   ")).toBe(false);
    expect(validAvoidName("two words")).toBe(false);
    expect(validAvoidName("x".repeat(65))).toBe(false);
  });
});

describe("parseAvoidRequest", () => {
  it("returns the trimmed pair", () => {
    expect(parseAvoidRequest({ player: " Alice ", avoid: "Bob" })).toEqual({
      player: "Alice",
      avoid: "Bob",
    });
  });

  it("rejects anything that is not two account names", () => {
    for (const body of [null, "x", {}, { player: "Alice" }, { player: "Alice", avoid: "a b" }]) {
      expect(() => parseAvoidRequest(body)).toThrow(/invalid avoid payload/);
    }
  });
});

describe("avoidPairsOf", () => {
  const roster = ["Alice", "Bob", "Carol"];

  it("keeps only the entries whose BOTH people are in the lobby", () => {
    const pairs = avoidPairsOf([entry("Alice", "Bob"), entry("Alice", "Dave")], roster);
    expect(pairs).toEqual([{ a: "alice", b: "bob" }]);
  });

  it("collapses the two directions of the same pair into one", () => {
    const pairs = avoidPairsOf([entry("Alice", "Bob"), entry("Bob", "alice")], roster);
    expect(pairs).toEqual([{ a: "alice", b: "bob" }]);
  });

  it("drops a self-entry and is case-insensitive about the roster", () => {
    const pairs = avoidPairsOf([entry("Alice", "alice"), entry("CAROL", "bob")], roster);
    expect(pairs).toEqual([{ a: "bob", b: "carol" }]);
  });

  it("caps at ten per player by policy", () => {
    expect(MAX_AVOIDS_PER_PLAYER).toBe(10);
  });
});
