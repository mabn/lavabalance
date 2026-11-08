// Stress test: replay a LARGE synthetic command log through the Dispatcher DO.
//
// A real 50k-line session was reported to time out when streamed through
// the Dispatcher's `ingest` RPC. This test generates an even bigger log in the same shape (one busy
// lava lobby with constant battle-status / client-status / skill churn, plus background
// battles) and streams it through the live DO, measuring throughput, to find out whether
// the replay path scales — and to guard against a regression that reintroduces a stall.
//
// Runs inside workerd via @cloudflare/vitest-pool-workers (see the sibling
// dispatcher.replay.workers.test.ts for the basic end-to-end test).

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Dispatcher } from "../src/dispatcher";

interface Envelope {
  src: "client" | "server";
  msg: string;
}

const BOT = "huk123"; // pinned for the tests in vitest.config.ts (miniflare.bindings)
const LAVA_BATTLE = 9000;

/**
 * Generate a large, realistic command log: the bot joins one lava lobby that then sees
 * continuous churn (players cycling battle-status, ready flags, skills, global status),
 * interleaved with a few background battles the bot never joins. Returns at least
 * `minLines` envelopes.
 */
function generateLog(minLines: number): Envelope[] {
  const out: Envelope[] = [];
  const S = (msg: string) => out.push({ src: "server", msg });
  const C = (msg: string) => out.push({ src: "client", msg });

  // --- session prologue -------------------------------------------------------
  S("TASSERVER 0.38-33-ga5f3b28 * 8201 0");
  C(`LOGIN ${BOT} <redacted> 0 * lavabalance\t1234567890 0123456789abcdef\tb sp`);
  S(`ACCEPTED ${BOT}`);

  // --- a handful of background battles (tracked but never lava) ---------------
  for (let i = 0; i < 5; i++) {
    const id = 8000 + i;
    S(
      `BATTLEOPENED ${id} 0 0 Host[BG${i}] 10.0.0.${i} 53200 16 0 0 -590370561 spring` +
        `\t2025.06.24\tQuicksilver ${i}\tBackground Battle ${i}\tBeyond All Reason test-30495-8e5184b`,
    );
    S(`JOINEDBATTLE ${id} bgplayer${i}`);
  }

  // --- the lava lobby the bot joins -------------------------------------------
  S(
    `BATTLEOPENED ${LAVA_BATTLE} 0 0 Host[LAVA] 188.244.117.147 53220 16 0 0 -590370561 spring` +
      `\t2025.06.24\tSupreme Isthmus v2.1\tLAVA SUPREME - T3 ECO | 8v8 | Unranked` +
      `\tBeyond All Reason test-30495-8e5184b`,
  );
  S(`UPDATEBATTLEINFO ${LAVA_BATTLE} 1 0 -590370561 Supreme Isthmus v2.1`);
  C(`JOINBATTLE ${LAVA_BATTLE} 0 scriptpw`);
  S(`JOINEDBATTLE ${LAVA_BATTLE} ${BOT} 120974236`);

  // 32 players (a 16v16), all members of the lava lobby.
  const players: string[] = [];
  for (let i = 0; i < 32; i++) players.push(`player${String(i).padStart(2, "0")}`);
  for (const p of players) S(`JOINEDBATTLE ${LAVA_BATTLE} ${p}`);

  // --- churn rounds until we exceed minLines ----------------------------------
  // Each round re-emits every player's CLIENTBATTLESTATUS (team/ally/ready toggling),
  // their global CLIENTSTATUS, and a batched SETSCRIPTTAGS skill line — exactly the
  // high-frequency traffic a live lobby produces while people ready up and shuffle.
  let round = 0;
  while (out.length < minLines) {
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      const team = i;
      const ally = i % 2;
      const ready = (round + i) % 2; // toggles each round
      // Encode a plausible battle-status: team low nibble, ally low nibble, player bit,
      // sync=1, ready bit, plus team/ally high nibbles for the 16+ team numbers.
      let bs = 0;
      if (ready) bs |= 1 << 1;
      bs |= (team & 0xf) << 2;
      bs |= (ally & 0xf) << 6;
      bs |= 1 << 10; // player (not spectator)
      bs |= ((team >>> 4) & 0xf) << 18;
      bs |= 1 << 22; // sync = synced
      bs |= ((ally >>> 4) & 0xf) << 28;
      bs >>>= 0;
      S(`CLIENTBATTLESTATUS ${p} ${bs} ${1000000 + i}`);
      // Global status: rank cycles, in-game off in lobby.
      const status = ((i % 8) << 2) | (round % 2 === 0 ? 0 : 0);
      S(`CLIENTSTATUS ${p} ${status}`);
    }
    // One SETSCRIPTTAGS carrying every player's skill (as the host re-sends on changes).
    const skillPairs = players
      .map((p, i) => `game/players/${p}/skill=[${(10 + ((round + i) % 40)).toFixed(2)}]`)
      .join("\t");
    S(`SETSCRIPTTAGS ${skillPairs}\tgame/modoptions/allowpausegameplay=1`);
    // An announce line every round (boss roster, plain chat).
    S(
      `SAIDBATTLEEX Host[LAVA] * BarManager|{"BattleStateChanged": {"boss": "${players[round % players.length]}"}}`,
    );
    if (round % 10 === 0) {
      S(`s.battle.update_lobby_title ${LAVA_BATTLE}\tSupreme LAVA | 8v8 | Unranked r${round}`);
    }
    S("PING");
    round++;
  }
  return out;
}

/** Feed envelopes through the DO's `ingest` RPC in batches; resolve with the accepted count. */
async function replay(envelopes: Envelope[], timeoutMs: number): Promise<number> {
  const ts = 1_700_000_000_000;
  const stub = env.DISPATCHER.get(env.DISPATCHER.idFromName("singleton"));
  const deadline = Date.now() + timeoutMs;
  const BATCH = 1000;
  let accepted = 0;
  for (let i = 0; i < envelopes.length; i += BATCH) {
    if (Date.now() > deadline) throw new Error(`replay timed out after ${timeoutMs}ms`);
    const batch = envelopes.slice(i, i + BATCH).map((e) => ({ ts, src: e.src, msg: e.msg }));
    accepted += await runInDurableObject(stub, (d: Dispatcher) => d.ingest(batch));
  }
  return accepted;
}

describe("Dispatcher large-log replay (stress)", () => {
  const TARGET_LINES = 60_000;
  const REPLAY_TIMEOUT_MS = 60_000;

  it(
    "replays a 60k-line log without stalling and rebuilds correct state",
    async () => {
      const log = generateLog(TARGET_LINES);
      expect(log.length).toBeGreaterThanOrEqual(TARGET_LINES);

      const started = Date.now();
      const replayed = await replay(log, REPLAY_TIMEOUT_MS);
      const elapsed = Date.now() - started;
      const rate = Math.round((replayed / elapsed) * 1000);
      console.log(
        `[stress] replayed ${replayed} lines in ${elapsed}ms (${rate} lines/s)`,
      );

      expect(replayed).toBe(log.length);

      // State is intact after the deluge: the lava battle is tracked with its 33 members
      // (bot is not added as a player), and the title reflects the last rename.
      const id = env.DISPATCHER.idFromName("singleton");
      const stub = env.DISPATCHER.get(id);
      await runInDurableObject(stub, async (instance: Dispatcher) => {
        const status = instance.status(String(LAVA_BATTLE));
        expect(status.battleState).not.toBeNull();
        // 32 players (each sent a CLIENTBATTLESTATUS) + the founder added by BATTLEOPENED;
        // the bot itself joins but is not added as a player.
        expect(status.battleState!.playerCount).toBe(33);
        expect(status.battleState!.title).toContain("Supreme LAVA");
        expect(status.trackedBattles).toBeGreaterThanOrEqual(6);
      });
    },
    REPLAY_TIMEOUT_MS + 10_000,
  );
});
