// Polls end to end inside workerd: the public read, voting behind the website
// login, one vote per account (changing it replaces it), the tally by rank
// tier, the admin-only voter list, and that
// /api/reset leaves votes alone. Sessions are made the way the bot's login
// does (issue with ADMIN_OPEN, then redeem), as in auth.workers.test.ts.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { POLLS } from "../src/polls";

const BASE = "https://lavabalance.test";
const JSON_HDR = { "content-type": "application/json" };
const AS_ADMIN = { ADMIN_OPEN: "true" } as Partial<Env>;
const SLUG = POLLS[0].slug;

async function request(path: string, init?: RequestInit, extraEnv: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), { ...env, ...extraEnv }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let nextUserId = 700_000;

/** A logged-in browser's cookie for a fresh account. */
async function login(name: string): Promise<{ cookie: string; userId: number }> {
  const userId = nextUserId++;
  const issued = await request(
    "/api/bot/auth/issue",
    { method: "POST", headers: JSON_HDR, body: JSON.stringify({ name, userId }) },
    AS_ADMIN,
  );
  expect(issued.status).toBe(200);
  const token = new URL(((await issued.json()) as { url: string }).url).searchParams.get("t");
  const res = await request("/api/auth/redeem", {
    method: "POST",
    headers: { ...JSON_HDR, origin: BASE },
    body: JSON.stringify({ token }),
  });
  expect(res.status).toBe(200);
  return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]!, userId };
}

interface PollBody {
  poll: { slug: string; open: boolean; options: { key: string }[] };
  results: {
    total: number;
    counts: Record<string, number>;
    byTier: { tier: string; total: number; counts: Record<string, number> | null }[];
  };
  myVote: { choice: string; changes: number } | null;
  user: { userId: number; name: string } | null;
  voters?: { name: string; choice: string; changes: number }[];
  previous?: string | null;
}

async function read(cookie?: string, extraEnv: Partial<Env> = {}): Promise<PollBody> {
  const res = await request(`/api/polls/${SLUG}`, { headers: cookie ? { cookie } : {} }, extraEnv);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json()) as PollBody;
}

async function vote(choice: unknown, cookie?: string, origin = BASE) {
  return request(`/api/polls/${SLUG}/vote`, {
    method: "POST",
    headers: { ...JSON_HDR, origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ choice }),
  });
}

describe("polls", () => {
  it("lists the polls and serves the pages", async () => {
    const list = (await (await request("/api/polls")).json()) as { polls: { slug: string; open: boolean }[] };
    expect(list.polls[0]).toMatchObject({ slug: SLUG, open: true });
    const bare = await request("/polls");
    expect(bare.status).toBe(302);
    expect(bare.headers.get("location")).toBe(`/polls/${SLUG}`);
    const page = await request(`/polls/${SLUG}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('id="root" class="pollpage"');
    // Link previews (Discord): the poll's title, question and image, absolute URLs.
    expect(html).toContain(`<meta property="og:title" content="🗳️ Poll: ${POLLS[0].title}" />`);
    expect(html).toMatch(/<meta property="og:description" content="Should we hide LOS values[^"]*Vote with your BAR account\." \/>/);
    expect(html).toContain(`<meta property="og:image" content="${BASE}${POLLS[0].ogImage}" />`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect((await request("/api/polls/nope")).status).toBe(404);
  });

  it("refuses a vote without a login, pointing at /login", async () => {
    const res = await vote("hidden");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ login: "/login" });
  });

  it("refuses a cross-site vote and an unknown choice", async () => {
    const { cookie } = await login("PollPicky");
    expect((await vote("hidden", cookie, "https://evil.test")).status).toBe(403);
    expect((await vote("maybe", cookie)).status).toBe(400);
    expect((await read(cookie)).myVote).toBeNull();
  });

  it("counts one vote per account and lets it change", async () => {
    const before = (await read()).results;
    const a = await login("PollAlice");
    const b = await login("PollBob");

    const r1 = await vote("hidden", a.cookie);
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as PollBody;
    expect(b1.previous).toBeNull();
    expect(b1.myVote).toMatchObject({ choice: "hidden", changes: 0 });
    expect(b1.user).toMatchObject({ name: "PollAlice" });

    // Voting the same again is a no-op; changing replaces the vote.
    expect(((await (await vote("hidden", a.cookie)).json()) as PollBody).previous).toBe("hidden");
    const changed = (await (await vote("visible", a.cookie)).json()) as PollBody;
    expect(changed.previous).toBe("hidden");
    expect(changed.myVote).toMatchObject({ choice: "visible", changes: 1 });

    await vote("hidden", b.cookie);
    const after = (await read(a.cookie)).results;
    expect(after.total).toBe(before.total + 2);
    expect((after.counts.visible ?? 0) - (before.counts.visible ?? 0)).toBe(1);
    expect((after.counts.hidden ?? 0) - (before.counts.hidden ?? 0)).toBe(1);

    // A visitor sees the tally but no "your vote".
    const anon = await read();
    expect(anon.myVote).toBeNull();
    expect(anon.user).toBeNull();
    expect(anon.voters).toBeUndefined();
  });

  it("splits the votes by rank tier for everyone, and lists the voters for an admin", async () => {
    const body = await read();
    // The test accounts have no LOS rows: they all land in "unrated".
    const unrated = body.results.byTier.find((b) => b.tier === "unrated")!;
    expect(unrated.total).toBe(body.results.total);
    expect(Object.values(unrated.counts!).reduce((a, b) => a + b, 0)).toBe(unrated.total);
    expect(body.voters).toBeUndefined();

    const admin = await read(undefined, AS_ADMIN);
    expect(admin.voters!.some((v) => v.name === "PollAlice" && v.choice === "visible" && v.changes === 1)).toBe(true);
  });

  it("keeps votes through /api/reset", async () => {
    const total = (await read()).results.total;
    expect(total).toBeGreaterThan(0);
    expect((await request("/api/reset?confirm=true", { method: "POST" })).status).toBe(200);
    expect((await read()).results.total).toBe(total);
  });
});
