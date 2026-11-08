// The bot's avoid-list HTTP client (src/bot/avoidClient.ts), against an
// injected fetch: the four calls, the control-token header, and which
// non-2xx statuses are refusals (a value) rather than failures (a throw).

import { describe, expect, it, vi } from "vitest";
import { createAvoidClient } from "../src/bot/avoidClient";

const BASE = "https://worker.test/";

function stub(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  return vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const { status = 200, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("createAvoidClient", () => {
  it("lists a player's entries", async () => {
    const fetchImpl = stub((url) => {
      expect(url).toBe("https://worker.test/api/avoids/list?player=Hu%20k");
      return { body: { owner: "Hu k", entries: [{ avoid: "Bob" }], limit: 10 } };
    });
    const list = await createAvoidClient(BASE, { fetchImpl }).list("Hu k");
    expect(list).toEqual({ owner: "Hu k", entries: [{ avoid: "Bob" }], limit: 10 });
  });

  it("sends the control token and the JSON body on a write", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = stub((url, init) => {
      expect(url).toBe("https://worker.test/api/avoids/add");
      seen.push(init);
      return { body: { ok: true, entry: { owner: "A", avoid: "B" }, count: 1 } };
    });
    const r = await createAvoidClient(BASE, { fetchImpl, token: " s3cret " }).add("A", "B");
    expect(r).toMatchObject({ ok: true, count: 1 });
    const headers = seen[0].headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer s3cret");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(seen[0].body))).toEqual({ player: "A", avoid: "B" });
  });

  it("sends no auth header when no token is configured", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = stub((_url, init) => {
      seen.push(init);
      return { body: { ok: true, removed: true, name: "B", count: 0 } };
    });
    await createAvoidClient(BASE, { fetchImpl }).remove("A", "B");
    expect((seen[0].headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("returns the add route's refusals (404/409) as values", async () => {
    const unknown = createAvoidClient(BASE, {
      fetchImpl: stub(() => ({ status: 404, body: { ok: false, reason: "unknown-player", suggestions: ["Bobby"] } })),
    });
    expect(await unknown.add("A", "Bobb")).toEqual({
      ok: false,
      reason: "unknown-player",
      suggestions: ["Bobby"],
    });

    const dupe = createAvoidClient(BASE, {
      fetchImpl: stub(() => ({ status: 409, body: { ok: false, reason: "duplicate" } })),
    });
    expect(await dupe.add("A", "B")).toMatchObject({ ok: false, reason: "duplicate" });
  });

  it("throws on a real failure (a wrong token, the service down)", async () => {
    const client = createAvoidClient(BASE, {
      fetchImpl: stub(() => ({ status: 401, body: { error: "unauthorized" } })),
    });
    await expect(client.add("A", "B")).rejects.toThrow(/responded 401/);
  });

  it("de-duplicates the roster and skips the request for an empty one", async () => {
    const urls: string[] = [];
    const fetchImpl = stub((url) => {
      urls.push(url);
      return { body: { entries: [], pairs: [{ a: "a", b: "b" }] } };
    });
    const client = createAvoidClient(BASE, { fetchImpl });
    expect(await client.pairs(["A", "B", "A", " "])).toEqual([{ a: "a", b: "b" }]);
    expect(urls).toEqual(["https://worker.test/api/avoids/pairs?names=A%2CB"]);
    expect(await client.pairs([])).toEqual([]);
    expect(urls).toHaveLength(1);
  });
});
