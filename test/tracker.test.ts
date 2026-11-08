// SessionTracker — the ONE session pipeline shared by the Worker's Dispatcher and
// the Node bot. These tests drive it exactly like either consumer does: a stream of
// {ts, src, msg} envelopes, both directions.

import { describe, expect, it } from "vitest";
import { SessionTracker } from "../src/tracker";

let seq = 0;
function obs(msg: string, src: "client" | "server" = "server") {
  return { ts: ++seq, src, msg };
}

async function feed(t: SessionTracker, lines: [string, ("client" | "server")?][]) {
  for (const [msg, src] of lines) await t.observe(obs(msg, src));
}

describe("SessionTracker", () => {
  it("tracks the joined lobby's roster, merging user-directory facts", async () => {
    const t = new SessionTracker("configuredname");
    await feed(t, [
      // Session account learned from the stream's own LOGIN (beats the configured name).
      ["LOGIN lavabalance *** 0 * bot\t0\tb sp", "client"],
      ["ACCEPTED lavabalance"],
      // Global user facts arrive before the battle exists — must still stick.
      ["CLIENTSTATUS huk123 17"], // bit0 in-game + rank bits
      ["JOINEDBATTLE 1242 lavabalance"],
      ["CLIENTBATTLESTATUS huk123 4195354 3323998"], // player, team 6
      ["CLIENTBATTLESTATUS KingBlakey 4194348 8686400"], // spectator
      ["SETSCRIPTTAGS game/players/huk123/skill=[31.2]\tgame/players/kingblakey/skill=[9.9]"],
    ]);

    expect(t.currentBattleId()).toBe(1242);
    const roster = t.roster()!;
    expect(roster.map((p) => p.name)).toEqual(["huk123", "KingBlakey"]); // skill desc
    const huk = roster[0];
    expect(huk).toMatchObject({ spectator: false, ally: 0, team: 6, skill: 31.2, inGame: true });
    expect(roster[1]).toMatchObject({ spectator: true, skill: 9.9, inGame: false });
  });

  it("self re-join implicitly leaves the previous battle; self LEFTBATTLE clears state", async () => {
    const t = new SessionTracker("lavabalance");
    await feed(t, [
      ["JOINEDBATTLE 100 lavabalance"],
      ["CLIENTBATTLESTATUS someone 4195400 1"],
      // Direct re-join without a LEFTBATTLE for battle 100 (observed in the wild).
      ["JOINEDBATTLE 200 lavabalance"],
      ["CLIENTBATTLESTATUS other 4195400 1"],
    ]);
    expect(t.currentBattleId()).toBe(200);
    expect(t.roster()!.map((p) => p.name)).toEqual(["other"]);

    await feed(t, [["LEFTBATTLE 200 lavabalance"]]);
    expect(t.currentBattleId()).toBeNull();
    expect(t.roster()).toBeNull();
  });

  it("fires the lava hooks instead of self-managing when provided", async () => {
    const added: number[] = [];
    const removed: number[] = [];
    const t = new SessionTracker("lavabalance", {
      addLavaLobby: (id) => {
        added.push(id);
        t.setLavaLobbies(added.filter((x) => !removed.includes(x)));
      },
      removeLavaLobby: (id) => {
        removed.push(id);
        t.setLavaLobbies(added.filter((x) => !removed.includes(x)));
      },
    });
    await feed(t, [
      ["JOINEDBATTLE 100 lavabalance"],
      ["JOINEDBATTLE 200 lavabalance"],
      ["LEFTBATTLE 200 lavabalance"],
    ]);
    expect(added).toEqual([100, 200]);
    expect(removed).toEqual([100, 200]);
  });

  it("applies the leave signals (REMOVESCRIPTTAGS / REMOVEUSER) to the roster", async () => {
    const t = new SessionTracker("lavabalance");
    await feed(t, [
      ["JOINEDBATTLE 1242 lavabalance"],
      ["CLIENTBATTLESTATUS [BRP]WAFFLEMAKER 20972582 1"],
      ["CLIENTBATTLESTATUS Kerinas 4195400 2"],
      ["CLIENTBATTLESTATUS huk123 4195354 3"],
      ["REMOVESCRIPTTAGS game/players/[brp]wafflemaker/skill game/players/[brp]wafflemaker/skilluncertainty"],
      ["REMOVEUSER Kerinas"],
    ]);
    expect(t.roster()!.map((p) => p.name)).toEqual(["huk123"]);
  });
});
