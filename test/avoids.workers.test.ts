// Avoid lists end to end inside workerd: the LosDO's `avoids` storage, the
// /api/avoids routes (list / add / remove / pairs) with their refusals, and
// the admin-only `avoids` field on the lobby detail view — served through
// src=proxy over the captured lobby session, with the bot's game-start roster
// standing in for the live one so the roster carries ranked names.

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { fetchAs } from "./adminFetch";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import sessionLog from "./fixtures/lobby-session.log?raw";
import { lavaReplay } from "./losFixtures";
import type { Dispatcher } from "../src/dispatcher";
import type { LosDO } from "../src/los/losDO";
import { MAX_AVOIDS_PER_PLAYER } from "../src/avoids";
import type { TrackedPlayer } from "../src/tracker";

/** Admin routes as a superadmin (./adminFetch), everything else as a visitor. */
const call = fetchAs((url, init) => SELF.fetch(url, init));

const BASE = "https://lavabalance.test";
const BATTLE = 7294;

const losStub = () => env.LOS.get(env.LOS.idFromName("singleton"));

async function postJson(path: string, body: unknown, expectStatus = 200): Promise<any> {
  const res = await call(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(expectStatus);
  return res.json();
}

async function getJson(path: string, expectStatus = 200): Promise<any> {
  const res = await call(`${BASE}${path}`);
  expect(res.status).toBe(expectStatus);
  return res.json();
}

const add = (player: string, avoid: string, status = 200) =>
  postJson("/api/avoids/add", { player, avoid }, status);
const remove = (player: string, avoid: string) =>
  postJson("/api/avoids/remove", { player, avoid });
const list = (player: string) => getJson(`/api/avoids/list?player=${encodeURIComponent(player)}`);

/** One rated lava game, so the ranking knows player101… / player201… . */
beforeEach(async () => {
  expect((await call(`${BASE}/api/reset?confirm=true`, { method: "POST" })).status).toBe(200);
  // The LOS reset deliberately leaves the avoid lists alone, so clear them here.
  expect(
    (await call(`${BASE}/api/avoids/reset?confirm=true`, { method: "POST" })).status,
  ).toBe(200);
  await postJson("/api/games", [
    lavaReplay({ id: "avoid-seed", startTime: new Date(Date.now() - 86_400_000).toISOString() }),
  ]);
});

describe("POST /api/avoids/add", () => {
  it("adds a ranked player and lists them back", async () => {
    const r = await add("player101", "player201");
    expect(r).toMatchObject({ ok: true, count: 1 });
    expect(r.entry).toMatchObject({ owner: "player101", avoid: "player201" });
    expect(typeof r.entry.avoidUserId).toBe("number");

    const l = await list("PLAYER101"); // the owner is matched case-insensitively
    expect(l.limit).toBe(MAX_AVOIDS_PER_PLAYER);
    expect(l.entries.map((e: { avoid: string }) => e.avoid)).toEqual(["player201"]);
  });

  it("refuses a name the ranking has never rated, with near misses", async () => {
    // A typo'd name the store can still recognise part of: the near misses are
    // what turns "no such player" into something the asker can act on.
    const near = await add("player101", "player20", 404);
    expect(near).toMatchObject({ ok: false, reason: "unknown-player" });
    expect(near.suggestions.length).toBeGreaterThan(0);
    expect(near.suggestions.every((n: string) => n.startsWith("player20"))).toBe(true);

    // A name with nothing to suggest is still a clean refusal.
    const nothing = await add("player101", "zzzz", 404);
    expect(nothing).toEqual({ ok: false, reason: "unknown-player", suggestions: [] });
    expect(await list("player101")).toMatchObject({ entries: [] });
  });

  it("refuses avoiding yourself, whatever the spelling", async () => {
    expect(await add("player101", "PLAYER101", 409)).toMatchObject({ ok: false, reason: "self" });
  });

  it("refuses a duplicate", async () => {
    await add("player101", "player201");
    const r = await add("player101", "PLAYER201", 409);
    expect(r).toMatchObject({ ok: false, reason: "duplicate" });
    expect(r.entry).toMatchObject({ avoid: "player201" });
    expect((await list("player101")).entries).toHaveLength(1);
  });

  it("caps a list at ten", async () => {
    const targets = [102, 103, 104, 105, 106, 107, 108, 201, 202, 203].map((n) => `player${n}`);
    for (const [i, t] of targets.entries()) {
      expect(await add("player101", t)).toMatchObject({ ok: true, count: i + 1 });
    }
    const r = await add("player101", "player204", 409);
    expect(r).toMatchObject({ ok: false, reason: "limit", limit: MAX_AVOIDS_PER_PLAYER, count: 10 });
    expect((await list("player101")).entries).toHaveLength(MAX_AVOIDS_PER_PLAYER);
  });

  it("rejects a malformed body", async () => {
    await postJson("/api/avoids/add", { player: "player101" }, 400);
    await postJson("/api/avoids/add", { player: "a b", avoid: "player201" }, 400);
  });
});

describe("POST /api/avoids/remove", () => {
  it("removes an entry and is idempotent", async () => {
    await add("player101", "player201");
    expect(await remove("player101", "PLAYER201")).toMatchObject({
      ok: true,
      removed: true,
      name: "player201",
      count: 0,
    });
    expect(await remove("player101", "player201")).toMatchObject({ ok: true, removed: false });
    expect((await list("player101")).entries).toEqual([]);
  });
});

describe("GET /api/avoids/pairs", () => {
  it("returns only the pairs both of whose people are in the roster", async () => {
    await add("player101", "player201");
    await add("player102", "player202");

    const both = await getJson("/api/avoids/pairs?names=player101,player201,player102");
    expect(both.pairs).toEqual([{ a: "player101", b: "player201" }]);
    // The entry naming someone outside the roster still comes back as an entry…
    expect(both.entries).toHaveLength(2);
    // …but constrains nothing.
    const none = await getJson("/api/avoids/pairs?names=player101,player102");
    expect(none.pairs).toEqual([]);
  });

  it("needs names, and caps how many", async () => {
    await getJson("/api/avoids/pairs", 400);
    const many = Array.from({ length: 65 }, (_, i) => `p${i}`).join(",");
    await getJson(`/api/avoids/pairs?names=${many}`, 400);
  });
});

describe("POST /api/avoids/reset", () => {
  it("wipes every list, and only on ?confirm=true", async () => {
    await add("player101", "player201");
    await postJson("/api/avoids/reset", null, 400);
    expect((await list("player101")).entries).toHaveLength(1);

    const res = await call(`${BASE}/api/avoids/reset?confirm=true`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: 1 });
    expect((await list("player101")).entries).toEqual([]);
  });

  it("survives the LOS reset — no upload could put a list back", async () => {
    await add("player101", "player201");
    expect((await call(`${BASE}/api/reset?confirm=true`, { method: "POST" })).status).toBe(200);
    expect((await list("player101")).entries).toHaveLength(1);
  });
});

describe("LosDO.avoidsFor", () => {
  it("finds an entry from either end", async () => {
    await add("player101", "player201");
    await runInDurableObject(losStub(), async (instance) => {
      const i = instance as unknown as LosDO;
      expect((await i.avoidsFor(["player201"])).entries).toHaveLength(1);
      expect((await i.avoidsFor(["PLAYER101"])).entries).toHaveLength(1);
      expect((await i.avoidsFor(["nobody"])).entries).toEqual([]);
    });
  });
});

describe("the lobby view's admin-only avoids", () => {
  const trackedPlayer = (name: string, ally: number): TrackedPlayer => ({
    name,
    skill: 25,
    rank: 4,
    inGame: true,
    away: false,
    ready: true,
    spectator: false,
    sync: 1,
    ally,
    team: 0,
    boss: false,
    statusKnown: true,
  });

  beforeAll(async () => {
    // Seed the Dispatcher's proxy view with the captured session (same fixture
    // and path as dispatcher.replay.workers.test.ts — the ingest() RPC).
    const envelopes = sessionLog
      .split("\n")
      .filter((l) => l.length > 2 && (l[0] === "c" || l[0] === "S") && l[1] === " ")
      .map((l) => ({
        ts: 1_700_000_000_000,
        src: l[0] === "c" ? ("client" as const) : ("server" as const),
        msg: l.slice(2).replace(/\r$/, ""),
      }));
    const stub = env.DISPATCHER.get(env.DISPATCHER.idFromName("singleton"));
    await runInDurableObject(stub, (i: Dispatcher) => i.ingest(envelopes));
  });

  it("serves the roster's entries to an admin and nothing at all to a visitor", async () => {
    await add("player101", "player201");
    // The bot's launch roster stands in for the live one, so the lobby carries
    // the two ranked names the avoid entry is about.
    await postJson("/api/gamestart", {
      battleId: BATTLE,
      startedAt: Date.now(),
      players: [trackedPlayer("player101", 0), trackedPlayer("player201", 1)],
      founder: "Host",
      title: "Supreme LAVA",
      botBalanced: true,
      predictedFirstWin: 50,
    });

    const admin = await getJson(`/api/lobbies/${BATTLE}?src=proxy&includePrivate=true`);
    expect(admin.avoids).toHaveLength(1);
    expect(admin.avoids[0]).toMatchObject({ owner: "player101", avoid: "player201" });

    const visitor = await getJson(`/api/lobbies/${BATTLE}?src=proxy`);
    expect(visitor.avoids).toEqual([]);
  });
});
