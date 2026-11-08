// The bot's scouting client (src/bot/scoutClient.ts), against an injected fetch.

import { describe, expect, it, vi } from "vitest";
import { createScoutClient } from "../src/bot/scoutClient";

function stub(handler: (url: string) => { status?: number; body: unknown }) {
  return vi.fn(async (input: string | URL | Request) => {
    const { status = 200, body } = handler(String(input));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("createScoutClient", () => {
  it("asks the public bulk route and picks the asked name's card", async () => {
    const fetchImpl = stub((url) => {
      expect(url).toBe("https://w.test/api/scout?names=So%20ngi");
      return { body: { cards: [{ userId: 2, name: "Other" }, { userId: 1, name: "so ngi" }] } };
    });
    const c = await createScoutClient("https://w.test/", { fetchImpl }).card(" So ngi ");
    expect(c?.userId).toBe(1);
  });

  it("answers null for no card and for an empty name, throws on a failure", async () => {
    const empty = createScoutClient("https://w.test", { fetchImpl: stub(() => ({ body: { cards: [] } })) });
    expect(await empty.card("x")).toBeNull();
    expect(await empty.card("  ")).toBeNull();
    const down = createScoutClient("https://w.test", { fetchImpl: stub(() => ({ status: 502, body: {} })) });
    await expect(down.card("x")).rejects.toThrow(/returned 502/);
  });
});
