// Scouting end to end inside workerd: OneTrickLava's push into the LosDO
// (auth, diff-only writes, removals, the boards rebuilt), the public reads
// (bulk, one card, boards) with private LOS profiles filtered for a visitor,
// and the lobby view's per-player badges + scouting report — served through
// src=proxy over the captured lobby session (a Supreme Isthmus lobby), with
// the bot's game-start roster standing in for the live one.

import { SELF, createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { adminFetch, fetchAs } from "./adminFetch";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import sessionLog from "./fixtures/lobby-session.log?raw";
import { lavaReplay } from "./losFixtures";
import type { Dispatcher } from "../src/dispatcher";
import type { TrackedPlayer } from "../src/tracker";

const call = fetchAs((url, init) => SELF.fetch(url, init));
const BASE = "https://lavabalance.test";
const BATTLE = 7294;

async function getJson(path: string, expectStatus = 200): Promise<any> {
  const res = await call(`${BASE}${path}`);
  expect(res.status).toBe(expectStatus);
  return res.json();
}

/** A push as an admin (the pooled env has no scout Access application; the JWT path is test/access.test.ts). */
async function push(body: unknown, expectStatus = 200): Promise<any> {
  const res = await adminFetch(`${BASE}/api/scout/profiles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(expectStatus);
  return res.json();
}

function card(userId: number, lanes: [string, number, number, number][], extra: Record<string, unknown> = {}) {
  return {
    userId,
    name: `player${userId}`,
    games: 120,
    winRate: 0.55,
    archetypes: ["Frontliner"],
    badges: [],
    lanes: lanes.map(([name, share, games, winRate]) => ({ name, share, games, winRate })),
    traits: { aggression: 0.1, ecoFocus: 0.3 },
    commander: { bombRate: 0.1 },
    danger: 2,
    ...extra,
  };
}

const BOMBER = { id: "comm_bomber", icon: "💥", label: "Comm bomber", caption: "D-guns early" };

beforeEach(async () => {
  expect((await adminFetch(`${BASE}/api/scout/reset?confirm=true`, { method: "POST" })).status).toBe(200);
  expect((await call(`${BASE}/api/reset?confirm=true`, { method: "POST" })).status).toBe(200);
  // One rated game, so LOS knows player101… / player201… (and can make one private).
  const res = await call(`${BASE}/api/games`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([lavaReplay({ id: "scout-seed", startTime: new Date(Date.now() - 86_400_000).toISOString() })]),
  });
  expect(res.status).toBe(200);
});

describe("POST /api/scout/profiles", () => {
  it("refuses a bad Access token, and fails closed without the Access application", async () => {
    const body = JSON.stringify({ profiles: [card(101, [])] });
    const headers = { "content-type": "application/json" };
    const post = async (extra: Record<string, string>, over: Record<string, string> = {}) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`${BASE}/api/scout/profiles`, { method: "POST", headers: { ...headers, ...extra }, body }),
        { ...env, ...over },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res.status;
    };
    // Configured (cloudflare.config.ts carries ACCESS_SCOUT_AUD): no assertion — e.g. a
    // request that skipped Access on workers.dev — or one that is not a valid token
    // for the scout application is a 401.
    expect(await post({})).toBe(401);
    expect(await post({ "cf-access-jwt-assertion": "not-a-jwt" })).toBe(401);
    expect(await post({ authorization: "Bearer anything" })).toBe(401);
    // Without the audience nobody but an admin may push, and the refusal names it.
    expect(await post({}, { ACCESS_SCOUT_AUD: "" })).toBe(503);
    expect((await getJson("/api/scout/boards")).profiles).toBe(0);
  });

  it("stores, skips identical resends, removes, and rejects garbage", async () => {
    expect(await push({ profiles: [card(101, []), card(102, [])] })).toMatchObject({
      stored: 2,
      unchanged: 0,
      removed: 0,
      total: 2,
    });
    expect(await push({ profiles: [card(101, []), card(102, [], { games: 121 })] })).toMatchObject({
      stored: 1,
      unchanged: 1,
      total: 2,
    });
    expect(await push({ remove: [101, 999] })).toMatchObject({ removed: 1, total: 1 });
    await getJson("/api/scout/101", 404);
    expect((await getJson("/api/scout/102")).card.games).toBe(121);
    await push({ profiles: "nope" }, 400);
  });

  it("builds the boards from the regulars", async () => {
    await push({
      profiles: [
        card(101, [["Geo", 0.5, 40, 0.7]], { danger: 9, badges: [BOMBER] }),
        card(102, [["Geo", 0.5, 40, 0.6]], { danger: 3 }),
        card(103, [["Geo", 0.5, 40, 0.9]], { danger: 50, games: 10 }), // too few games for a board
      ],
      generatedAt: "2026-10-10T12:00:00Z",
    });
    const b = await getJson("/api/scout/boards");
    expect(b.profiles).toBe(3);
    expect(b.generatedAt).toBe("2026-10-10T12:00:00Z");
    expect(b.watchlist.map((w: any) => w.userId)).toEqual([101, 102]);
    expect(b.laneKings[0].kings.map((k: any) => k.userId)).toEqual([101, 102]);
  });
});

describe("reads and private profiles", () => {
  it("hides a private LOS profile's card from a visitor, not from an admin", async () => {
    await push({ profiles: [card(101, [["Geo", 0.5, 40, 0.7]], { danger: 9 }), card(102, [])] });
    expect((await adminFetch(`${BASE}/api/players/101/private`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ private: true }),
    })).status).toBe(200);

    expect(await getJson("/api/scout/101")).toEqual({ private: true });
    expect((await getJson("/api/scout/101?includePrivate=true")).card.userId).toBe(101);
    const bulk = await getJson("/api/scout?names=player101,PLAYER102");
    expect(bulk.cards.map((c: any) => c.userId)).toEqual([102]);
    const boards = await getJson("/api/scout/boards");
    expect(boards.watchlist.map((w: any) => w.userId)).not.toContain(101);
    expect((await getJson("/api/scout/boards?includePrivate=true")).watchlist[0].userId).toBe(101);
  });

  it("validates the bulk read", async () => {
    await getJson("/api/scout", 400);
    await getJson("/api/scout?ids=abc", 400);
    await getJson("/api/scout/notanid", 400);
  });
});

describe("the lobby view", () => {
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

  it("carries each player's badges and the lobby's lane forecast", async () => {
    await push({
      profiles: [
        card(101, [["Front Suicide", 0.6, 70, 0.62]], { badges: [BOMBER] }),
        card(102, [["Front Suicide", 0.4, 40, 0.5], ["Eco", 0.3, 30, 0.6]]),
        card(201, [["Front Suicide", 0.5, 50, 0.45]]),
      ],
    });
    const res = await call(`${BASE}/api/gamestart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        battleId: BATTLE,
        startedAt: Date.now(),
        players: [
          trackedPlayer("player101", 0),
          trackedPlayer("player102", 0),
          trackedPlayer("player201", 1),
          trackedPlayer("newcomer", 1),
        ],
        founder: "Host",
        title: "Supreme LAVA",
        botBalanced: true,
        predictedFirstWin: 50,
      }),
    });
    expect(res.status).toBe(200);

    const lobby = await getJson(`/api/lobbies/${BATTLE}?src=proxy`);
    const by = Object.fromEntries(lobby.players.map((p: any) => [p.name, p]));
    expect(by.player101.scout.badges[0].id).toBe("comm_bomber");
    expect(by.newcomer.scout).toBeNull();
    expect(lobby.scouting.teams.map((t: any) => [t.scouted, t.players])).toEqual([
      [2, 2],
      [1, 2],
    ]);
    expect(lobby.scouting.teams[0].threats[0].names).toEqual(["player101"]);
    const lanes = Object.fromEntries(lobby.scouting.lanes.lanes.map((r: any) => [r.lane, r.picks.map((p: any) => p?.name ?? null)]));
    // player101 holds Front Suicide, so player102 is forecast on their next lane.
    expect(lanes).toEqual({ "Front Suicide": ["player101", "player201"], Eco: ["player102", null] });
  });
});
