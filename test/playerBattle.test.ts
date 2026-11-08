import { describe, expect, it } from "vitest";
import { findPlayerBattle } from "../src/bot/playerBattle";

const battles = [
  { battleId: 10, founder: { username: "Host[EU1]" }, players: [{ username: "Alice" }, { username: "Bob" }] },
  { battleId: 20, founder: { username: "Host[EU2]" }, players: [{ username: "huk123" }] },
];
const stub = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("findPlayerBattle", () => {
  it("finds a member case-insensitively", async () => {
    expect(await findPlayerBattle("HUK123", { fetchImpl: stub(battles) })).toBe(20);
    expect(await findPlayerBattle("bob", { fetchImpl: stub(battles) })).toBe(10);
  });
  it("finds a founder", async () => {
    expect(await findPlayerBattle("Host[EU2]", { fetchImpl: stub(battles) })).toBe(20);
  });
  it("returns null when the player is in no battle", async () => {
    expect(await findPlayerBattle("nobody", { fetchImpl: stub(battles) })).toBeNull();
  });
  it("throws on an upstream error", async () => {
    await expect(findPlayerBattle("bob", { fetchImpl: stub({}, 503) })).rejects.toThrow(/503/);
  });
});
