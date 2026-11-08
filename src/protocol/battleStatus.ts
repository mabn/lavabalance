// Encode/decode the Spring lobby protocol "battle status" 32-bit integer used by
// MYBATTLESTATUS (outbound) and CLIENTBATTLESTATUS (inbound).
//
// Bit layout (verified against Chobby liblobby EncodeBattleStatus/ParseBattleStatus):
//   bit  1      ready (1 = ready)
//   bits 2-5    team number — low nibble  (full value is 8-bit, see below)
//   bits 6-9    ally team no — low nibble  (full value is 8-bit, see below)
//   bit  10     mode          (1 = player, 0 = spectator)
//   bits 11-17  handicap      (0-100; Chobby no longer reads this, kept for parity)
//   bits 18-21  team number — high nibble
//   bits 22-23  sync status   (0 = unknown, 1 = synced, 2 = unsynced)
//   bits 24-27  side / faction (0-15)
//   bits 28-31  ally team no — high nibble
//
// Team and ally are 8-bit (0-255): Chobby splits each across a low nibble in the
// lower 16 bits and a high nibble in the upper 16 bits, so a 16v16 game (team/ally
// numbers > 15) needs both nibbles. We must reassemble both or the number wraps.
//
// Because the ally high nibble reaches bit 31, the encoded integer CAN set the sign
// bit (ally >= 128). We normalize with `>>> 0` on the way out and use unsigned
// (`>>>`) shifts on the way in so the sign bit never bites.

export interface BattleStatus {
  ready: boolean;
  team: number;
  ally: number;
  /** true = participating player, false = spectator. */
  player: boolean;
  handicap: number;
  /** 0 = unknown, 1 = synced, 2 = unsynced (e.g. the player is downloading the map). */
  sync: number;
  side: number;
}

/** Sync-status values carried in bits 22-23 (matches Chobby's ParseBattleStatus). */
export const SYNC_UNKNOWN = 0;
export const SYNC_SYNCED = 1;
/** Player lacks the map/game content — typically still downloading it. */
export const SYNC_UNSYNCED = 2;

export const SPECTATOR_STATUS: BattleStatus = {
  ready: false,
  team: 0,
  ally: 0,
  player: false,
  handicap: 0,
  sync: SYNC_SYNCED, // claim "synced" so the server does not flag us as out of sync
  side: 0,
};

export function encodeBattleStatus(s: BattleStatus): number {
  let bs = 0;
  if (s.ready) bs |= 1 << 1;
  bs |= (s.team & 0xf) << 2; // team low nibble
  bs |= (s.ally & 0xf) << 6; // ally low nibble
  if (s.player) bs |= 1 << 10;
  bs |= (s.handicap & 0x7f) << 11;
  bs |= ((s.team >>> 4) & 0xf) << 18; // team high nibble
  bs |= (s.sync & 0x3) << 22;
  bs |= (s.side & 0xf) << 24;
  bs |= ((s.ally >>> 4) & 0xf) << 28; // ally high nibble (can reach bit 31)
  return bs >>> 0;
}

export function decodeBattleStatus(bs: number): BattleStatus {
  const u = bs >>> 0;
  return {
    ready: ((u >>> 1) & 1) === 1,
    team: ((u >>> 2) & 0xf) | (((u >>> 18) & 0xf) << 4),
    ally: ((u >>> 6) & 0xf) | (((u >>> 28) & 0xf) << 4),
    player: ((u >>> 10) & 1) === 1,
    handicap: (u >>> 11) & 0x7f,
    sync: (u >>> 22) & 0x3,
    side: (u >>> 24) & 0xf,
  };
}
