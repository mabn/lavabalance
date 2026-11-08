// The superadmin gate end to end (src/access.ts, src/index.ts): what a visitor
// gets from the pages and the admin routes, what an admin gets, and the
// /admin/login + /admin/logout pair the Access application fronts. The Access
// JWT check itself is unit-tested in access.test.ts; an admin here is the
// control token or ADMIN_OPEN, which go through the same adminIdentity.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const BASE = "https://lavabalance.test";
const TOKEN = "test-control-token";

async function request(path: string, init?: RequestInit, extraEnv: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), { ...env, ...extraEnv }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const ADMIN = { ADMIN_OPEN: "true" } as Partial<Env>;

describe("admin mode on the pages", () => {
  it("is off for a visitor, whatever ?admin=true says", async () => {
    for (const path of ["/ranking", "/ranking?admin=true", "/sql", "/bot", "/login"]) {
      const res = await request(path);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain("const ADMIN_MODE = /*ADMIN_MODE*/false;");
      expect(res.headers.get("cache-control") ?? "", path).not.toContain("private");
    }
  });

  it("is on for an admin, and that copy is never stored", async () => {
    const res = await request("/ranking", undefined, ADMIN);
    const html = await res.text();
    expect(html).toContain("const ADMIN_MODE = true;");
    expect(html).not.toContain("/*ADMIN_MODE*/");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toContain("Cookie");
  });

  it("offers the admin login only in the sidebar, for huk123 or in admin mode", async () => {
    const html = await (await request("/login")).text();
    expect(html).not.toContain('class="adminlogin"');
    expect(html).toContain('const SUPERADMIN_NAME = "huk123";');
    expect(html).toContain("if (!nav || !(owner || ADMIN_MODE)) return;");
    expect(html).toContain('a.href = "/admin/login?next="');
  });
});

describe("the admin routes", () => {
  it("refuse a visitor with 401 and the login path", async () => {
    const res = await request("/api/sqlstats");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ login: "/admin/login" });
    for (const [path, body] of [
      ["/api/games/g1/rebase", {}],
      ["/api/games/g1/ignored", { ignored: true }],
      ["/api/players/1/private", { private: true }],
      ["/api/rank-history/rebuild", {}],
    ] as const) {
      const r = await request(path, { method: "POST", body: JSON.stringify(body) });
      expect(r.status, path).toBe(401);
    }
  });

  it("let an admin through", async () => {
    expect((await request("/api/sqlstats", undefined, ADMIN)).status).toBe(200);
    const bearer = { headers: { authorization: `Bearer ${TOKEN}` } };
    expect((await request("/api/sqlstats", bearer, { CONTROL_TOKEN: TOKEN })).status).toBe(200);
  });

  it("serve a visitor's ?includePrivate=true the public view, uncached", async () => {
    const res = await request("/api/ranking?includePrivate=true");
    expect(res.status).toBe(200);
    expect((await res.json()) as { includePrivate: boolean }).toMatchObject({ includePrivate: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const admin = await request("/api/ranking?includePrivate=true", undefined, ADMIN);
    expect((await admin.json()) as { includePrivate: boolean }).toMatchObject({ includePrivate: true });
  });

  it("let a signed-in admin drive the bot page's control plane without the bearer", async () => {
    const cfg = { CONTROL_TOKEN: TOKEN };
    expect((await request("/admin/config", undefined, cfg)).status).toBe(401);
    expect((await request("/admin/config", undefined, { ...cfg, ...ADMIN })).status).toBe(200);
  });
});

describe("/admin/login and /admin/logout", () => {
  it("login sends the browser back on-site, needing no control token", async () => {
    const cfg = { CONTROL_TOKEN: TOKEN };
    const res = await request("/admin/login?next=%2Franking%3Fpage%3D2", { redirect: "manual" }, cfg);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ranking?page=2");
    const evil = await request("/admin/login?next=https%3A%2F%2Fevil.example%2F", { redirect: "manual" }, cfg);
    expect(evil.headers.get("location")).toBe("/");
  });

  it("logout expires the Access cookie and goes home", async () => {
    const res = await request("/admin/logout", { redirect: "manual" }, { CONTROL_TOKEN: TOKEN });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toContain("CF_Authorization=;");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("cross-site writes", () => {
  it("refuse an admin route posted from a foreign Origin, even for an admin", async () => {
    const init = { method: "POST", body: "{}", headers: { origin: "https://evil.example" } };
    expect((await request("/api/rank-history/rebuild", init, ADMIN)).status).toBe(401);
    expect((await request("/bot/stop", init, { ...ADMIN, CONTROL_TOKEN: TOKEN })).status).toBe(401);
  });
});
