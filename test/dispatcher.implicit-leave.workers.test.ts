// Regression test for the missing-LEFTBATTLE battle-switch bug.
//
// Observed in the wild: the bot joins a battle, then issues a direct JOINBATTLE for the
// next one WITHOUT leaving first, and the server never sends a LEFTBATTLE for the old
// battle. Two things used to go wrong as a result:
//   1. the old battle id leaked into lava_lobbies forever (a phantom lobby), and
//   2. because that stale id stayed "lava", a stranger's JOINEDBATTLE to it could hijack
//      `currentBattle`, so untagged CLIENTBATTLESTATUS lines got attributed to the wrong
//      battle — a player who was only ever in the old battle showed up in the new one.
//
// The fix treats the bot's own JOINEDBATTLE as an implicit leave of the battle it was in
// (dropping the old id from lava_lobbies), and gates `currentBattle` adoption on the
// joiner being the bot. This streams the scenario through the live Dispatcher DO and
// asserts the leak is gone and rosters stay separate. Runs in workerd via
// @cloudflare/vitest-pool-workers (BOT_USERNAME=huk123 pinned in vitest.config.ts).

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Dispatcher } from "../src/dispatcher";

interface Envelope {
  src: "client" | "server";
  msg: string;
}

/**
 * Feed the envelopes to the Dispatcher through its `ingest` RPC (the WebSocket tap
 * is gone), in order; resolves with the accepted count once every line is applied.
 */
async function replay(envelopes: Envelope[]): Promise<void> {
  const ts = 1_700_000_000_000;
  const stub = env.DISPATCHER.get(env.DISPATCHER.idFromName("singleton"));
  await runInDurableObject(stub, (i: Dispatcher) =>
    i.ingest(envelopes.map((e) => ({ ts, src: e.src, msg: e.msg }))),
  );
}

async function getJson(path: string): Promise<any> {
  const res = await SELF.fetch(`https://lavabalance.test${path}`);
  expect(res.ok, `${path} -> ${res.status}`).toBe(true);
  return res.json();
}

// CLIENTBATTLESTATUS bitfield that decodes to an active player (team 1, ally 1, ready).
const PLAYER_STATUS = 4195398;

// The bug scenario: bot joins 9308, then jumps to 7950 with no LEFTBATTLE for 9308.
const SCENARIO: Envelope[] = [
  // A stranger is already in battle 9308.
  { src: "server", msg: "JOINEDBATTLE 9308 [HGD]Artyxerxes" },
  // The bot joins 9308 → it becomes a lava lobby and the current battle.
  { src: "client", msg: "JOINBATTLE 9308 empty 1" },
  { src: "server", msg: "JOINBATTLE 9308 111" },
  { src: "server", msg: "JOINEDBATTLE 9308 huk123 1" },
  // While in 9308 the bot receives the stranger's battle status → added to 9308's roster.
  { src: "server", msg: `CLIENTBATTLESTATUS [HGD]Artyxerxes ${PLAYER_STATUS} 0` },
  // BUG TRIGGER: the bot jumps straight to 7950 — no LEFTBATTLE for 9308 is ever sent.
  { src: "client", msg: "JOINBATTLE 7950 empty 2" },
  { src: "server", msg: "JOINBATTLE 7950 222" },
  { src: "server", msg: "JOINEDBATTLE 7950 huk123 2" },
  // A genuine member of 7950 reports its status → must land in 7950, not contaminate it.
  { src: "server", msg: `CLIENTBATTLESTATUS realmember ${PLAYER_STATUS} 0` },
];

describe("Dispatcher: bot switches battle without a LEFTBATTLE", () => {
  beforeAll(async () => {
    await replay(SCENARIO);
  });

  it("drops the abandoned battle from lava_lobbies (no phantom lobby leak)", async () => {
    const id = env.DISPATCHER.idFromName("singleton");
    const stub = env.DISPATCHER.get(id);
    await runInDurableObject(stub, async (_instance: Dispatcher, state) => {
      const cfg = await state.storage.get<{ lava_lobbies: number[] }>("config");
      // The bot's own join to 7950 implicitly left 9308, so only 7950 remains.
      expect(cfg?.lava_lobbies).toContain(7950);
      expect(cfg?.lava_lobbies).not.toContain(9308);
    });
  });

  it("surfaces only the battle the bot is actually in", async () => {
    const lobbies = await getJson("/api/lobbies?src=proxy");
    expect(lobbies.map((l: any) => l.battleId)).toEqual([7950]);
  });

  it("does not attribute the old battle's player to the new battle", async () => {
    const lobbies = await getJson("/api/lobbies?src=proxy");
    const lobby = lobbies.find((l: any) => l.battleId === 7950);
    const names = lobby.players.map((p: any) => p.name);
    // The 7950 member is tracked here; the player who was only ever in 9308 is NOT.
    expect(names).toContain("realmember");
    expect(names).not.toContain("[HGD]Artyxerxes");
  });
});
