// The bot-uploaded game-start roster, end to end inside workerd:
//   • the LosDO's lobby_states storage (put / get / clear / overwrite / TTL reap),
//   • the open POST /api/gamestart + /api/gameend routes,
//   • the /api/lobbies/:id substitution — served through the src=proxy source,
//     the one testable without a live Teiserver: the Dispatcher's tracker is
//     seeded through its ingest() RPC with the captured lobby-session fixture
//     (battle 7294, whose founder's CLIENTSTATUS carries the in-game bit, so
//     the proxy view reports it inProgress).

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import sessionLog from "./fixtures/lobby-session.log?raw";
import type { Dispatcher } from "../src/dispatcher";
import type { LosDO } from "../src/los/losDO";
import { GAME_START_TTL_MS, type GameStartSnapshot } from "../src/gameStart";
import type { TrackedPlayer } from "../src/tracker";

const BASE = "https://lavabalance.test";
const BATTLE = 7294;

const losStub = () => env.LOS.get(env.LOS.idFromName("singleton"));

const player = (name: string, ally: number, over: Partial<TrackedPlayer> = {}): TrackedPlayer => ({
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
  ...over,
});

const snapshot = (over: Partial<GameStartSnapshot> = {}): GameStartSnapshot => ({
  battleId: BATTLE,
  startedAt: Date.now(),
  players: [
    player("Alpha", 0, { skill: 30 }),
    player("Bravo", 1, { skill: 20 }),
    player("Watcher", 0, { spectator: true, skill: null }),
  ],
  founder: "Host[EU8][020]",
  title: "Supreme LAVA | 8v8 | Unranked",
  botBalanced: true,
  predictedFirstWin: 52.5,
  ...over,
});

async function post(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getLobby(q = ""): Promise<any> {
  const res = await SELF.fetch(`${BASE}/api/lobbies/${BATTLE}?src=proxy${q}`);
  expect(res.status).toBe(200);
  return res.json();
}

beforeAll(async () => {
  // Seed the Dispatcher's proxy view with the captured session (same fixture and
  // path as dispatcher.replay.workers.test.ts — the ingest() RPC).
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

describe("LosDO lobby_states storage", () => {
  it("round-trips a snapshot and clears it", async () => {
    const snap = snapshot();
    await runInDurableObject(losStub(), async (instance) => {
      const i = instance as unknown as LosDO;
      await i.putGameStart(snap);
      expect(await i.getGameStart(BATTLE)).toEqual(snap);
      await i.clearGameStart(BATTLE);
      expect(await i.getGameStart(BATTLE)).toBeNull();
      // Clearing a missing row is idempotent.
      await i.clearGameStart(BATTLE);
    });
  });

  it("overwrites on a second upload for the same battle (back-to-back games)", async () => {
    const first = snapshot({ startedAt: Date.now() - 60_000 });
    const second = snapshot({ players: [player("NewGuy", 0)] });
    await runInDurableObject(losStub(), async (instance) => {
      const i = instance as unknown as LosDO;
      await i.putGameStart(first);
      await i.putGameStart(second);
      const stored = await i.getGameStart(BATTLE);
      expect(stored?.players.map((p) => p.name)).toEqual(["NewGuy"]);
      await i.clearGameStart(BATTLE);
    });
  });

  it("reaps a row past the TTL on read", async () => {
    const stale = snapshot({ startedAt: Date.now() - GAME_START_TTL_MS - 1 });
    await runInDurableObject(losStub(), async (instance) => {
      const i = instance as unknown as LosDO;
      await i.putGameStart(stale);
      expect(await i.getGameStart(BATTLE)).toBeNull();
      // The reap deleted the row, not just filtered it.
      expect(await i.getGameStart(BATTLE, 0)).toBeNull();
    });
  });

  it("rejects garbage in putGameStart", async () => {
    await runInDurableObject(losStub(), async (instance) => {
      const i = instance as unknown as LosDO;
      await expect(i.putGameStart({ battleId: "x" })).rejects.toThrow(
        /invalid game-start payload/,
      );
    });
  });
});

describe("POST /api/gamestart and /api/gameend", () => {
  it("stores a valid snapshot and clears it via gameend", async () => {
    const res = await post("/api/gamestart", snapshot());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, battleId: BATTLE });

    const end = await post("/api/gameend", {
      battleId: BATTLE,
      endedAt: Date.now(),
      reason: "result",
    });
    expect(end.status).toBe(200);
    expect(await end.json()).toEqual({ ok: true });
    await runInDurableObject(losStub(), async (instance) => {
      const i = instance as unknown as LosDO;
      expect(await i.getGameStart(BATTLE)).toBeNull();
    });
  });

  it("400s garbage bodies with the validator's message", async () => {
    const res = await post("/api/gamestart", { battleId: BATTLE, players: "nope" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid game-start payload");

    expect((await post("/api/gameend", { battleId: BATTLE, reason: "oops" })).status).toBe(400);
    const raw = await SELF.fetch(`${BASE}/api/gamestart`, { method: "POST", body: "{{{" });
    expect(raw.status).toBe(400);
  });
});

describe("/api/lobbies/:id roster substitution", () => {
  it("serves the live roster with no snapshot stored", async () => {
    const lobby = await getLobby();
    expect(lobby).not.toBeNull();
    expect(lobby.rosterSource).toBe("live");
    expect(lobby.botRoster).toBeNull();
    expect(lobby.players.map((p: any) => p.name)).toContain("PlayerA");
  });

  it("serves the uploaded roster by default while the game runs", async () => {
    const snap = snapshot();
    expect((await post("/api/gamestart", snap)).status).toBe(200);

    const lobby = await getLobby();
    expect(lobby.rosterSource).toBe("bot");
    expect(lobby.botRoster).toEqual({ gameStartAt: snap.startedAt, botBalanced: true });
    expect(lobby.players.map((p: any) => p.name)).toEqual(["Alpha", "Bravo", "Watcher"]);
    // The lobby-level facts stay live (the fixture's battle, not the snapshot).
    expect(lobby.battleId).toBe(BATTLE);
    expect(lobby.inProgress).toBe(true);
    // finalizeLobby ran over the SUBSTITUTED roster: LOS fields attached and the
    // two-team stats computed from it (a 1v1 here — spectators excluded).
    expect(lobby.players[0].los ?? null).toBeDefined();
    expect(lobby.teamStats).toHaveLength(2);
    expect(lobby.teamStats[0].players).toBe(1);
    expect(lobby.teamStats[0].winProb).not.toBeNull();
  });

  it("?roster=live returns the live roster and keeps the toggle metadata", async () => {
    const lobby = await getLobby("&roster=live");
    expect(lobby.rosterSource).toBe("live");
    expect(lobby.botRoster).not.toBeNull();
    const names = lobby.players.map((p: any) => p.name);
    expect(names).toContain("PlayerA");
    expect(names).not.toContain("Alpha");
  });

  it("falls back to live once the snapshot is stale, and clears via gameend", async () => {
    // TTL-expired snapshot: the view ignores (and the DO reaps) it.
    expect(
      (
        await post("/api/gamestart", snapshot({ startedAt: Date.now() - GAME_START_TTL_MS - 1 }))
      ).status,
    ).toBe(200);
    let lobby = await getLobby();
    expect(lobby.rosterSource).toBe("live");
    expect(lobby.botRoster).toBeNull();

    // A fresh one shows again; the bot's game-end puts the live roster back.
    expect((await post("/api/gamestart", snapshot())).status).toBe(200);
    lobby = await getLobby();
    expect(lobby.rosterSource).toBe("bot");
    expect(
      (await post("/api/gameend", { battleId: BATTLE, endedAt: Date.now(), reason: "ingame-clear" }))
        .status,
    ).toBe(200);
    lobby = await getLobby();
    expect(lobby.rosterSource).toBe("live");
    expect(lobby.botRoster).toBeNull();
  });
});
