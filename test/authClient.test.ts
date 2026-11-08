// The bot's website-login client (src/bot/authClient.ts), against an injected
// fetch: both calls, the Access service-token headers, and failures throwing.

import { describe, expect, it, vi } from "vitest";
import { createAuthClient } from "../src/bot/authClient";

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

describe("createAuthClient", () => {
  it("asks for a link with the Access service token and returns it", async () => {
    const fetchImpl = stub((url, init) => {
      expect(url).toBe("https://worker.test/api/bot/auth/issue");
      expect(init.method).toBe("POST");
      const h = init.headers as Record<string, string>;
      expect(h["CF-Access-Client-Id"]).toBe("id.access");
      expect(h["CF-Access-Client-Secret"]).toBe("sekrit");
      expect(h.authorization).toBeUndefined();
      expect(JSON.parse(String(init.body))).toEqual({ name: "huk123", userId: 357541 });
      return { body: { url: "https://worker.test/login?t=abc", expiresAt: 5, name: "huk123" } };
    });
    const link = await createAuthClient(BASE, { accessClientId: "id.access", accessClientSecret: "sekrit", fetchImpl }).issue("huk123", 357541);
    expect(link).toEqual({ url: "https://worker.test/login?t=abc", expiresAt: 5 });
  });

  it("revokes and reports how many sessions ended", async () => {
    const fetchImpl = stub((url, init) => {
      expect(url).toBe("https://worker.test/api/bot/auth/revoke");
      expect((init.headers as Record<string, string>)["CF-Access-Client-Id"]).toBeUndefined();
      expect(JSON.parse(String(init.body))).toEqual({ userId: 7 });
      return { body: { ended: 2 } };
    });
    expect(await createAuthClient(BASE, { fetchImpl }).revoke(7)).toBe(2);
  });

  it("says Access refused the bot instead of failing to parse its login page", async () => {
    const redirect = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/login" } }),
    ) as unknown as typeof fetch;
    await expect(createAuthClient(BASE, { fetchImpl: redirect }).issue("a", 1)).rejects.toThrow(
      /Cloudflare Access did not let the bot through \(HTTP 302 to https:\/\/team\.cloudflareaccess\.com\/login\)/,
    );
    const html = vi.fn(async () =>
      new Response("<!DOCTYPE html><html>", { status: 200, headers: { "content-type": "text/html" } }),
    ) as unknown as typeof fetch;
    await expect(createAuthClient(BASE, { fetchImpl: html }).issue("a", 1)).rejects.toThrow(/not JSON/);
  });

  it("throws on any non-2xx, and on an answer with no link", async () => {
    const denied = stub(() => ({ status: 401, body: { error: "unauthorized" } }));
    await expect(createAuthClient(BASE, { fetchImpl: denied }).issue("a", 1)).rejects.toThrow(/401/);
    const empty = stub(() => ({ body: {} }));
    await expect(createAuthClient(BASE, { fetchImpl: empty }).issue("a", 1)).rejects.toThrow(/no link/);
  });
});
