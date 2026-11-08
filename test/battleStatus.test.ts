import { describe, expect, it } from "vitest";
import {
  decodeBattleStatus,
  encodeBattleStatus,
  SPECTATOR_STATUS,
  SYNC_SYNCED,
  SYNC_UNKNOWN,
  SYNC_UNSYNCED,
  type BattleStatus,
} from "../src/protocol/battleStatus";

describe("battle-status bitfield (verified vs Chobby ParseBattleStatus)", () => {
  it("decodes a real CLIENTBATTLESTATUS integer", () => {
    // the_serious_boi's status from a live 8v8: bits {3,4,5,10,22,24} set.
    const d = decodeBattleStatus(20972600);
    expect(d.ready).toBe(false);
    expect(d.player).toBe(true); // bit 10
    expect(d.team).toBe(14); // bits 2-5
    expect(d.ally).toBe(0);
    expect(d.sync).toBe(SYNC_SYNCED); // bits 22-23 = 1
    expect(d.side).toBe(1); // bits 24-27 = 1
  });

  it("treats mode bit 10 as 1=player, 0=spectator", () => {
    expect(decodeBattleStatus(1 << 10).player).toBe(true);
    expect(decodeBattleStatus(0).player).toBe(false);
  });

  it("round-trips every field", () => {
    const s: BattleStatus = {
      ready: true,
      team: 7,
      ally: 3,
      player: true,
      handicap: 0,
      sync: SYNC_SYNCED,
      side: 2,
    };
    expect(decodeBattleStatus(encodeBattleStatus(s))).toEqual(s);
  });

  it("reassembles 8-bit team/ally numbers (high nibble in the upper 16 bits)", () => {
    // Chobby stores team across bits 2-5 (low) + 18-21 (high) and ally across
    // bits 6-9 (low) + 28-31 (high); a 16v16 game uses numbers > 15.
    const raw = (4 << 2) | (2 << 6) | (1 << 10) | (1 << 18) | (1 << 28);
    const d = decodeBattleStatus(raw >>> 0);
    expect(d.team).toBe(20); // 0x14: low nibble 4 + high nibble 1
    expect(d.ally).toBe(18); // 0x12: low nibble 2 + high nibble 1
    expect(d.player).toBe(true);

    // And it round-trips through the encoder.
    for (const team of [0, 15, 16, 31, 100, 255]) {
      for (const ally of [0, 15, 16, 200, 255]) {
        const s = { ...SPECTATOR_STATUS, player: true, team, ally };
        const back = decodeBattleStatus(encodeBattleStatus(s));
        expect(back.team).toBe(team);
        expect(back.ally).toBe(ally);
      }
    }
  });

  it("keeps the encoded value unsigned even when the ally high nibble hits bit 31", () => {
    // ally >= 128 sets bit 31; the encoder must still return a positive uint32.
    const bs = encodeBattleStatus({ ...SPECTATOR_STATUS, player: true, ally: 200 });
    expect(bs).toBeGreaterThan(0);
    expect(decodeBattleStatus(bs).ally).toBe(200);
  });

  it("decodes the sync field — synced, unsynced (downloading), unknown", () => {
    expect(decodeBattleStatus(SYNC_SYNCED << 22).sync).toBe(SYNC_SYNCED);
    expect(decodeBattleStatus(SYNC_UNSYNCED << 22).sync).toBe(SYNC_UNSYNCED);
    expect(decodeBattleStatus(SYNC_UNKNOWN << 22).sync).toBe(SYNC_UNKNOWN);

    // A player downloading the map reports player=true, sync=2 (unsynced).
    const downloading = encodeBattleStatus({
      ...SPECTATOR_STATUS,
      player: true,
      sync: SYNC_UNSYNCED,
    });
    expect(decodeBattleStatus(downloading).sync).toBe(SYNC_UNSYNCED);
  });

  it("SPECTATOR_STATUS encodes a synced spectator (mode bit clear)", () => {
    const d = decodeBattleStatus(encodeBattleStatus(SPECTATOR_STATUS));
    expect(d.player).toBe(false);
    expect(d.sync).toBe(SYNC_SYNCED);
  });
});
