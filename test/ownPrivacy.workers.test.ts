// A player making their OWN profile private or public (/api/me/privacy): the
// session decides whose profile it is, making it public starts a one-day wait
// before it can be made private again, and an admin is never held by it.
// Logged in through the dev-only fake login (DEV_LOGIN=true on localhost).

import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { PRIVATE_AGAIN_COOLDOWN_MS } from "../src/los/losDO";
import { lavaReplay } from "./losFixtures";

const BASE = "http://localhost:8787";
const JSON_HDR = { "content-type": "application/json" };
const DEV = { DEV_LOGIN: "true" } as Partial<Env>;

async function request(path: string, init?: RequestInit, extraEnv: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), { ...env, ...extraEnv }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let fresh = 0;
const getJson = async (path: string, extraEnv: Partial<Env> = {}) =>
  (await request(`${path}${path.includes("?") ? "&" : "?"}fresh=${++fresh}`, {}, extraEnv)).json() as Promise<any>;

async function login(name: string): Promise<string> {
  const res = await request(
    "/api/auth/dev-login",
    { method: "POST", headers: { ...JSON_HDR, origin: BASE }, body: JSON.stringify({ name }) },
    DEV,
  );
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

const setOwn = (cookie: string, isPrivate: boolean, origin = BASE) =>
  request("/api/me/privacy", {
    method: "POST",
    headers: { ...JSON_HDR, origin, cookie },
    body: JSON.stringify({ private: isPrivate }),
  });

/** Ranked count the page is served from, checked against the admin's full list. */
async function expectRankedCount(n: number) {
  const pub = await getJson("/api/ranking?sort=rank&perPage=100");
  expect(pub.rankedTotal).toBe(n);
  const admin = await getJson("/api/ranking?sort=rank&perPage=100&includePrivate=true", { ADMIN_OPEN: "true" } as Partial<Env>);
  const shown = admin.players.filter((p: any) => !p.privateProfile && !p.inactive);
  expect(shown).toHaveLength(n);
  // The public ranks stay gapless and in leaderboard order after a toggle
  // (moved one by one, without the full rank walk).
  const head = pub.players.slice(0, n);
  expect(head.map((p: any) => p.rank)).toEqual(head.map((_: any, i: number) => i + 1));
  expect(head.map((p: any) => p.userId)).toEqual(shown.map((p: any) => p.userId));
  for (const p of head.slice(0, 3)) expect((await getJson(`/api/players/${p.userId}`)).rank).toBe(p.rank);
}

describe("own profile privacy", () => {
  let cookie: string;
  beforeEach(async () => {
    expect((await request("/api/reset?confirm=true", { method: "POST" })).status).toBe(200);
    const day = (h: number) => new Date(Date.now() - 86_400_000 + h * 3_600_000).toISOString();
    const seed = await request("/api/games", {
      method: "POST",
      headers: JSON_HDR,
      body: JSON.stringify([lavaReplay({ id: "own-1", startTime: day(1) }), lavaReplay({ id: "own-2", startTime: day(2) })]),
    });
    expect(seed.status).toBe(200);
    // A previous test's cooldown must not carry over (reset keeps that table).
    await runInDurableObject(env.LOS.get(env.LOS.idFromName("singleton")), async (_o, state) => {
      state.storage.sql.exec(`DELETE FROM privacy_changes`);
    });
    cookie = await login("player101");
  });

  it("needs a login", async () => {
    expect((await request("/api/me/privacy")).status).toBe(401);
    expect((await setOwn("", true)).status).toBe(401);
  });

  it("refuses a cross-site post", async () => {
    expect((await setOwn(cookie, true, "https://evil.example")).status).toBe(403);
  });

  it("hides and shows the logged-in player's own profile, with a day's wait before hiding again", async () => {
    const state = await (await request("/api/me/privacy", { headers: { cookie } })).json();
    expect(state).toEqual({ userId: 101, name: "player101", privateProfile: false, privateLockedUntil: null });
    await expectRankedCount(16);

    const hidden = await setOwn(cookie, true);
    expect(hidden.status).toBe(200);
    expect(await hidden.json()).toMatchObject({ userId: 101, privateProfile: true, changed: true, privateLockedUntil: null });
    expect((await getJson("/api/players/101")).privateProfile).toBe(true);
    await expectRankedCount(15);

    const before = Date.now();
    const shown = await setOwn(cookie, false);
    expect(shown.status).toBe(200);
    const shownBody = (await shown.json()) as any;
    expect(shownBody).toMatchObject({ privateProfile: false, changed: true });
    expect(shownBody.privateLockedUntil).toBeGreaterThanOrEqual(before + PRIVATE_AGAIN_COOLDOWN_MS);
    await expectRankedCount(16);

    // Within the day: refused, and still public.
    const again = await setOwn(cookie, true);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ refused: "cooldown", privateProfile: false, changed: false });
    expect((await getJson("/api/players/101")).privateProfile).toBe(false);
    await expectRankedCount(16);

    // A day later it goes through.
    await runInDurableObject(env.LOS.get(env.LOS.idFromName("singleton")), async (_o, st) => {
      st.storage.sql.exec(
        `UPDATE privacy_changes SET made_public_at = ? WHERE user_id = 101`,
        Date.now() - PRIVATE_AGAIN_COOLDOWN_MS - 1000,
      );
    });
    const later = await setOwn(cookie, true);
    expect(later.status).toBe(200);
    expect((await getJson("/api/players/101")).privateProfile).toBe(true);
    await expectRankedCount(15);
  });

  it("never holds an admin, and an admin's change starts no wait", async () => {
    expect((await setOwn(cookie, true)).status).toBe(200);
    expect((await setOwn(cookie, false)).status).toBe(200);
    // The player is waiting; the admin is not.
    const adminPost = (isPrivate: boolean) =>
      request(
        "/api/players/101/private",
        { method: "POST", headers: { ...JSON_HDR, origin: BASE }, body: JSON.stringify({ private: isPrivate }) },
        { ADMIN_OPEN: "true" } as Partial<Env>,
      );
    expect((await adminPost(true)).status).toBe(200);
    expect((await getJson("/api/players/101")).privateProfile).toBe(true);
    await expectRankedCount(15);
  });

  it("does not touch another player's profile", async () => {
    expect((await setOwn(cookie, true)).status).toBe(200);
    expect((await getJson("/api/players/102")).privateProfile).toBe(false);
  });
});
