// Decode the Spring lobby protocol "client status" integer carried by CLIENTSTATUS
// (server → all clients) and MYSTATUS (client → server). This is the GLOBAL per-user
// status (not the per-battle CLIENTBATTLESTATUS in battleStatus.ts).
//
// Bit layout (verified against BYAR-Chobby liblobby Interface:_OnClientStatus):
//   bit  0      in game     (1 = in a game)
//   bit  1      away
//   bits 2-4    rank        (0-7; the server sets these — the client may not)
//   bit  5      access      (1 = server moderator)
//   bit  6      bot         (1 = automated bot account)
//
// "Rank" is the player's account level. Chobby decodes it as
// `level = ((status >> 2) % 8) + 1`, i.e. it shifts the 0-7 bit value up to a 1-8
// display level which maps 1:1 onto the rank icons (ranks/1.png .. ranks/8.png).
// We follow that convention: `rank` here is the 1-8 display level.

export interface ClientStatus {
  inGame: boolean;
  away: boolean;
  /** Account rank as a 1-8 display level (Spring's 0-7 rank bits + 1); maps to ranks/<rank>.png. */
  rank: number;
  /** Server moderator. */
  access: boolean;
  /** Automated bot account (e.g. an autohost). */
  bot: boolean;
}

export function decodeClientStatus(status: number): ClientStatus {
  const u = status >>> 0;
  return {
    inGame: (u & 1) === 1,
    away: ((u >>> 1) & 1) === 1,
    rank: ((u >>> 2) & 0x7) + 1,
    access: ((u >>> 5) & 1) === 1,
    bot: ((u >>> 6) & 1) === 1,
  };
}
