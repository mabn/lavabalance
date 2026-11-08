// The bot admin page (GET /bot) vs the token-authed bot control plane (/bot/*).
//
// Hono's "/bot/*" middleware pattern matches the bare "/bot" too, so the page
// route MUST be registered before the requireControlToken middleware in
// src/index.ts — otherwise setting CONTROL_TOKEN would 401 the page itself and
// nobody could reach the form that takes the token. These tests pin that
// ordering by calling the worker with an env that has CONTROL_TOKEN set (the
// pooled test env leaves it unset, so auth is exercised per-request here).

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const BASE = "https://lavabalance.test";
const TOKEN = "test-control-token";

async function request(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${BASE}${path}`, init),
    { ...env, CONTROL_TOKEN: TOKEN },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("GET /bot (the admin page)", () => {
  it("serves the page without a token even when CONTROL_TOKEN is set", async () => {
    const res = await request("/bot");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Bot container");
    expect(html).toContain('id="root" class="botpage"');
  });
});

describe("the /bot/* control plane stays token-authed", () => {
  it("401s GET /bot/status without (or with a wrong) bearer token", async () => {
    expect((await request("/bot/status")).status).toBe(401);
    expect(
      (await request("/bot/status", { headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
  });

  it("401s POST /bot/start, /bot/restart, /bot/stop and /bot/join without the token", async () => {
    expect((await request("/bot/start", { method: "POST" })).status).toBe(401);
    expect((await request("/bot/restart", { method: "POST" })).status).toBe(401);
    expect((await request("/bot/stop", { method: "POST" })).status).toBe(401);
    expect((await request("/bot/join", { method: "POST" })).status).toBe(401);
  });
});

describe("POST /bot/join input validation", () => {
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  it("400s a non-integer or negative battle id (before touching the container)", async () => {
    for (const body of ['{"battle":"abc"}', '{"battle":1.5}', '{"battle":-1}', "not json"]) {
      const res = await request("/bot/join", { method: "POST", headers: auth, body });
      expect(res.status).toBe(400);
    }
  });
});
