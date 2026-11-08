// Replay a captured lobby session through the Dispatcher Durable Object.
//
// This is the end-to-end test of the Dispatcher: it takes a real-shaped command log
// (the same `c <line>` / `S <line>` format the proxy writes and `tools/dev.ts`
// replays — see test/fixtures/lobby-session.log) and streams it through the live DO
// over the very WebSocket the proxy uses (`/dispatcher/ws`), one `{ts, src, msg}`
// frame per line. It then reads the rebuilt state back through the control plane and
// the DO's RPC surface and asserts the battle, roster, skills and ranks the stream
// should have produced.
//
// Runs inside the real workerd runtime via @cloudflare/vitest-plugin, which
// loads cloudflare.config.ts so the DISPATCHER binding and DO exports match
// production (vars pinned in vitest.config.ts: BOT_USERNAME=huk123). See https://developers.cloudflare.com/durable-objects/
// examples/testing-with-durable-objects/.

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import sessionLog from "./fixtures/lobby-session.log?raw";
import type { Dispatcher } from "../src/dispatcher";

/** The proxy/dev envelope: one raw protocol line plus which side sent it. */
interface Envelope {
  src: "client" | "server";
  msg: string;
}

/**
 * Parse a command-log file (`c <line>` / `S <line>`) into proxy-style envelopes —
 * the format the old proxy/uplink wrote (`c <line>` / `S <line>`).
 */
function loadEnvelopes(text: string): Envelope[] {
  const out: Envelope[] = [];
  for (const line of text.split("\n")) {
    if (line.length < 2 || line[1] !== " ") continue;
    const tag = line[0];
    if (tag !== "c" && tag !== "S") continue;
    out.push({ src: tag === "c" ? "client" : "server", msg: line.slice(2).replace(/\r$/, "") });
  }
  return out;
}

/**
 * Feed the envelopes to the Dispatcher through its `ingest` RPC (the WebSocket tap
 * is gone), in order; resolves with the accepted count once every line is applied.
 */
async function replay(envelopes: Envelope[]): Promise<number> {
  const ts = 1_700_000_000_000;
  const stub = env.DISPATCHER.get(env.DISPATCHER.idFromName("singleton"));
  return runInDurableObject(stub, (i: Dispatcher) =>
    i.ingest(envelopes.map((e) => ({ ts, src: e.src, msg: e.msg }))),
  );
}

/** GET a JSON control-plane endpoint off the Worker. */
async function getJson(path: string): Promise<any> {
  const res = await SELF.fetch(`https://lavabalance.test${path}`);
  expect(res.ok, `${path} -> ${res.status}`).toBe(true);
  return res.json();
}

const envelopes = loadEnvelopes(sessionLog);

describe("Dispatcher replay of a captured lobby session", () => {
  let replayed = 0;

  beforeAll(async () => {
    replayed = await replay(envelopes);
  });

  it("parses the c/S command log into envelopes", () => {
    // The fixture has both sides; the bot's LOGIN and MYBATTLESTATUS are `c`, the rest `S`.
    expect(envelopes.length).toBeGreaterThan(10);
    expect(envelopes.some((e) => e.src === "client")).toBe(true);
    expect(envelopes.some((e) => e.src === "server")).toBe(true);
    // Every line is a non-empty raw protocol line (prefix + space already stripped).
    expect(envelopes.every((e) => e.msg.length > 0)).toBe(true);
  });

  it("acks the replay with the streamed count", () => {
    expect(replayed).toBe(envelopes.length);
  });

  it("tracks the battle the bot joined, with its lobby state", async () => {
    const status = await getJson("/battles/7294/status");
    expect(status.battleState).not.toBeNull();
    expect(status.battleState.battleId).toBe(7294);
    expect(status.battleState.founder).toBe("Host[EU8][020]");
    // Title started as the BATTLEOPENED value and was renamed by s.battle.update_lobby_title.
    expect(status.battleState.title).toBe("Supreme LAVA | 8v8 | Unranked");
    expect(status.battleState.map).toBe("Supreme Isthmus v2.1");
    // CLIENTSTATUS / LOGIN / TASSERVER etc. aren't battle-scoped → unrouted buffer.
    expect(status.unrouted).toBeGreaterThan(0);
    // Both battles in the log are tracked, even though only 7294 is a lava lobby.
    expect(status.trackedBattles).toBeGreaterThanOrEqual(2);
  });

  it("auto-added the joined battle to the persisted lava_lobbies", async () => {
    const id = env.DISPATCHER.idFromName("singleton");
    const stub = env.DISPATCHER.get(id);
    await runInDurableObject(stub, async (_instance: Dispatcher, state) => {
      const cfg = await state.storage.get<{ lava_lobbies: number[] }>("config");
      expect(cfg?.lava_lobbies).toContain(7294);
    });
  });

  it("builds the roster with battle-status, skills and ranks attached", async () => {
    const lobbies = await getJson("/api/lobbies?src=proxy");
    // Only the lava lobby (7294) is surfaced, not the tracked-but-unjoined 7322.
    expect(lobbies).toHaveLength(1);
    const lobby = lobbies[0];
    expect(lobby.battleId).toBe(7294);

    // Founder + the three players who sent a CLIENTBATTLESTATUS. PlayerD left, so 4 remain.
    expect(lobby.playerCount).toBe(4);
    const byName = new Map<string, any>(lobby.players.map((p: any) => [p.name, p]));
    expect([...byName.keys()].sort()).toEqual(
      ["Host[EU8][020]", "PlayerA", "PlayerB", "PlayerC"].sort(),
    );
    expect(byName.has("PlayerD")).toBe(false);

    // Players are ordered by skill (OS), high → low; the skill-less founder sorts last.
    expect(lobby.players.map((p: any) => p.name)).toEqual([
      "PlayerA",
      "PlayerB",
      "PlayerC",
      "Host[EU8][020]",
    ]);

    // PlayerA: CLIENTBATTLESTATUS 4195398 (team 1, ally 1, ready, player), CLIENTSTATUS
    // 13 (rank 4, in-game), skill tag [30.1].
    const playera = byName.get("PlayerA");
    expect(playera.skill).toBe(30.1);
    expect(playera.rank).toBe(4);
    expect(playera.inGame).toBe(true);
    expect(playera.spectator).toBe(false);
    expect(playera.ready).toBe(true);
    expect(playera.team).toBe(1);
    expect(playera.ally).toBe(1);
    expect(playera.statusKnown).toBe(true);

    // PlayerC: CLIENTBATTLESTATUS 20972562 (team 4, ally 0), skill [18.7], and the
    // boss named in the BarManager BattleStateChanged announce.
    const jim = byName.get("PlayerC");
    expect(jim.skill).toBe(18.7);
    expect(jim.rank).toBe(3);
    expect(jim.team).toBe(4);
    expect(jim.ally).toBe(0);
    expect(jim.boss).toBe(true);

    // The founder never sent a CLIENTBATTLESTATUS, so its battle-status is unknown and
    // it has no skill; its global CLIENTSTATUS (65 → bot, rank 1) still attaches.
    const host = byName.get("Host[EU8][020]");
    expect(host.statusKnown).toBe(false);
    expect(host.skill).toBeNull();
    expect(host.rank).toBe(1);
    expect(host.boss).toBe(false);
  });

  it("records the routed lines on the battle's own log", async () => {
    const log = await getJson("/battles/7294/log");
    expect(log.battle).toBe("7294");
    expect(log.total).toBeGreaterThan(0);
    expect(log.entries.length).toBeGreaterThan(0);
    // Newest-first: the last line routed to 7294 was the title rename.
    expect(log.entries[0].msg).toContain("s.battle.update_lobby_title 7294");
  });
});
