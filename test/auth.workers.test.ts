// Website login end to end inside workerd: the bot's /api/bot/auth/issue
// (behind a MANDATORY Cloudflare Access check for the bot application), the
// page's peek / redeem / me / logout, the session cookie, single use, expiry
// and the bot's revoke. The bot's calls run with ADMIN_OPEN=true (the dev
// opt-in botIdentity honours): the Access JWT check itself is unit-tested in
// access.test.ts. Other calls get an env with neither, like a visitor.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { SESSION_COOKIE, hashToken, newToken } from "../src/auth";
import { lavaReplay } from "./losFixtures";

const BASE = "https://lavabalance.test";
const BOT = { "content-type": "application/json" };
/** The bot's routes as the bot: botIdentity's dev opt-in. */
const AS_BOT = { ADMIN_OPEN: "true" } as Partial<Env>;
/** Bot Access configured, but the request carries no token. */
const BOT_CONFIGURED = { ACCESS_TEAM_DOMAIN: "example", ACCESS_BOT_AUD: "b".repeat(64) } as Partial<Env>;
const JSON_HDR = { "content-type": "application/json" };

async function request(
  path: string,
  init?: RequestInit,
  extraEnv: Partial<Env> = {},
  base = BASE,
) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${base}${path}`, init), { ...env, ...extraEnv }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let nextUserId = 900_000;

/** Issue a link the way the bot does; returns the raw token from its URL. */
async function issue(name = "huk123", userId = nextUserId++): Promise<{ token: string; userId: number }> {
  const res = await request("/api/bot/auth/issue", { method: "POST", headers: BOT, body: JSON.stringify({ name, userId }) }, AS_BOT);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { url: string };
  const url = new URL(body.url);
  expect(url.origin).toBe(BASE);
  expect(url.pathname).toBe("/login");
  return { token: url.searchParams.get("t")!, userId };
}

/** Redeem a link; returns the session cookie pair ("name=value"). */
async function redeem(token: string, expectStatus = 200): Promise<string> {
  const res = await request("/api/auth/redeem", {
    method: "POST",
    headers: { ...JSON_HDR, origin: BASE },
    body: JSON.stringify({ token }),
  });
  expect(res.status).toBe(expectStatus);
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

async function me(cookie?: string) {
  const res = await request("/api/auth/me", { headers: cookie ? { cookie } : {} });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json()) as { user: { userId: number; name: string } | null; bot: string };
}

describe("POST /api/bot/auth/issue (the bot)", () => {
  it("fails closed when the deployment has no bot Access configured", async () => {
    const res = await request(
      "/api/bot/auth/issue",
      { method: "POST", headers: JSON_HDR, body: JSON.stringify({ name: "a", userId: 1 }) },
      { ACCESS_BOT_AUD: "" },
    );
    expect(res.status).toBe(503);
  });

  it("401s without a valid Access token, whatever bearer it carries", async () => {
    const body = JSON.stringify({ name: "a", userId: 1 });
    const cfg = { ...BOT_CONFIGURED, CONTROL_TOKEN: "sekrit" };
    expect((await request("/api/bot/auth/issue", { method: "POST", headers: JSON_HDR, body }, cfg)).status).toBe(401);
    expect(
      (await request("/api/bot/auth/issue", { method: "POST", headers: { ...JSON_HDR, authorization: "Bearer sekrit" }, body }, cfg))
        .status,
    ).toBe(401);
    // The old path is gone.
    expect((await request("/api/auth/issue", { method: "POST", headers: JSON_HDR, body }, AS_BOT)).status).toBe(404);
  });

  it("400s a malformed body", async () => {
    const res = await request("/api/bot/auth/issue", { method: "POST", headers: BOT, body: JSON.stringify({ name: "a" }) }, AS_BOT);
    expect(res.status).toBe(400);
  });
});

describe("logging in with a whispered link", () => {
  it("peeks without using the link, then trades it for a session exactly once", async () => {
    const { token, userId } = await issue("Huk123");

    // The page's "Continue as" lookup, twice: a GET never uses the link up.
    for (let i = 0; i < 2; i++) {
      const res = await request(`/api/auth/link?t=${token}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ user: { userId, name: "Huk123" } });
    }

    const res = await request("/api/auth/redeem", {
      method: "POST",
      headers: { ...JSON_HDR, origin: BASE },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/;`));
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    const cookie = setCookie.split(";")[0]!;

    expect((await me(cookie)).user).toEqual({ userId, name: "Huk123" });

    // Used: neither the peek nor a second redeem accept it any more.
    expect((await request(`/api/auth/link?t=${token}`)).status).toBe(404);
    await redeem(token, 404);
  });

  it("stores only hashes: the raw token is nowhere in the DO", async () => {
    const { token } = await issue();
    const stub = env.LOS.get(env.LOS.idFromName("singleton"));
    expect(await stub.peekLoginLink(token)).toBeNull();
    expect(await stub.peekLoginLink(await hashToken(token))).not.toBeNull();
  });

  it("a newer link voids the older one of the same account", async () => {
    const first = await issue("a", 777_001);
    const second = await issue("a", 777_001);
    await redeem(first.token, 404);
    await redeem(second.token);
  });

  it("an expired link does not work", async () => {
    const { token, userId } = await issue();
    const stub = env.LOS.get(env.LOS.idFromName("singleton"));
    const later = Date.now() + 6 * 60_000;
    expect(await stub.peekLoginLink(await hashToken(token), later)).toBeNull();
    expect(
      await stub.redeemLoginLink(await hashToken(token), await hashToken(newToken()), later + 1000, later),
    ).toBeNull();
    // ...and the failed attempt above also used it up for good.
    await redeem(token, 404);
    expect(userId).toBeGreaterThan(0);
  });

  it("refuses a redeem posted from another site", async () => {
    const { token } = await issue();
    const res = await request("/api/auth/redeem", {
      method: "POST",
      headers: { ...JSON_HDR, origin: "https://evil.example" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(403);
    await redeem(token); // still usable by the real page
  });

  it("400s a garbage token", async () => {
    expect((await request("/api/auth/link?t=nope")).status).toBe(400);
    await redeem("nope", 400);
  });
});

describe("sessions", () => {
  it("/api/auth/me answers no user without a valid cookie, and names the bot", async () => {
    const anon = await me();
    expect(anon.user).toBeNull();
    expect(typeof anon.bot).toBe("string");
    expect((await me(`${SESSION_COOKIE}=${newToken()}`)).user).toBeNull();
  });

  it("logout ends this browser's session and clears the cookie", async () => {
    const cookie = await redeem((await issue()).token);
    const res = await request("/api/auth/logout", { method: "POST", headers: { cookie, origin: BASE } });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await me(cookie)).user).toBeNull();
  });

  it("the bot's revoke ends every session of the account", async () => {
    const userId = 777_100;
    const a = await redeem((await issue("multi", userId)).token);
    const b = await redeem((await issue("multi", userId)).token);
    const other = await redeem((await issue("someoneelse")).token);

    expect((await request("/api/bot/auth/revoke", { method: "POST", headers: JSON_HDR, body: "{}" }, BOT_CONFIGURED)).status).toBe(401);
    const res = await request("/api/bot/auth/revoke", { method: "POST", headers: BOT, body: JSON.stringify({ userId }) }, AS_BOT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ended: 2 });
    expect((await me(a)).user).toBeNull();
    expect((await me(b)).user).toBeNull();
    expect((await me(other)).user?.name).toBe("someoneelse");
  });

  it("/api/reset does not log anybody out", async () => {
    const cookie = await redeem((await issue("survivor")).token);
    expect((await request("/api/reset?confirm=true", { method: "POST" })).status).toBe(200);
    expect((await me(cookie)).user?.name).toBe("survivor");
  });
});

describe("GET /login", () => {
  it("serves the page, uncached", async () => {
    const res = await request("/login?t=whatever");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain('class="loginpage"');
  });
});

describe("the dev-only fake login", () => {
  const LOCAL = "http://localhost:8787";
  const DEV = { DEV_LOGIN: "true" } as Partial<Env>;
  const devLogin = (name: string, extraEnv: Partial<Env> = DEV, base = LOCAL) =>
    request(
      "/api/auth/dev-login",
      { method: "POST", headers: { ...JSON_HDR, origin: base }, body: JSON.stringify({ name }) },
      extraEnv,
      base,
    );

  it("logs in as a rated player, with the real account id, with DEV_LOGIN=true", async () => {
    expect((await request("/api/reset?confirm=true", { method: "POST" })).status).toBe(200);
    const seed = await request("/api/games", {
      method: "POST",
      headers: JSON_HDR,
      body: JSON.stringify([lavaReplay({ id: "dev-login-seed", startTime: new Date(Date.now() - 86_400_000).toISOString() })]),
    });
    expect(seed.status).toBe(200);

    const meRes = await request("/api/auth/me", {}, DEV, LOCAL);
    expect(((await meRes.json()) as { devLogin: boolean }).devLogin).toBe(true);

    const res = await devLogin("PLAYER101");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { userId: number; name: string } };
    expect(body.user.name).toBe("player101");
    expect(body.user.userId).toBe(101);
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    expect((await me(cookie)).user).toEqual({ userId: 101, name: "player101" });

    expect((await devLogin("nobody-at-all")).status).toBe(404);
  });

  it("does not exist without DEV_LOGIN", async () => {
    expect((await devLogin("player101", {})).status).toBe(404);
    expect((await devLogin("player101", { DEV_LOGIN: "false" })).status).toBe(404);
    expect((await me()).user).toBeNull();
    const meRes = await request("/api/auth/me", {}, {}, LOCAL);
    expect(((await meRes.json()) as { devLogin: boolean }).devLogin).toBe(false);
  });

  it("refuses a cross-site post", async () => {
    const res = await request(
      "/api/auth/dev-login",
      { method: "POST", headers: { ...JSON_HDR, origin: "https://evil.example" }, body: '{"name":"player101"}' },
      DEV,
      LOCAL,
    );
    expect(res.status).toBe(403);
  });
});
