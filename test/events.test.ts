import { describe, expect, it } from "vitest";
import { parseMessage } from "../src/protocol/framing";
import {
  parseBattleOpened,
  parseClientStatus,
  parseSaidBattleEx,
  parseSetScriptTags,
  parseUpdateBattleInfo,
  parseUpdateLobbyTitle,
} from "../src/protocol/events";
import { decodeClientStatus } from "../src/protocol/clientStatus";

describe("BATTLEOPENED parsing", () => {
  it("extracts structured fields, including the lobby title", () => {
    const line =
      "BATTLEOPENED 3557 0 0 Host[EU7][011] 31.187.64.19 53211 16 0 0 -590370561 spring" +
      "\t2025.06.24\tSupreme Isthmus v2.1\tLava Supreme T3 Eco | 8v8 | Unranked" +
      "\tBeyond All Reason test-30484-7185ea5";
    const b = parseBattleOpened(parseMessage(line))!;
    expect(b.battleId).toBe(3557);
    expect(b.founder).toBe("Host[EU7][011]");
    expect(b.ip).toBe("31.187.64.19");
    expect(b.port).toBe(53211);
    expect(b.maxPlayers).toBe(16);
    expect(b.passworded).toBe(false);
    expect(b.mapHash).toBe(-590370561);
    expect(b.engineName).toBe("spring");
    expect(b.engineVersion).toBe("2025.06.24");
    expect(b.map).toBe("Supreme Isthmus v2.1");
    expect(b.title).toBe("Lava Supreme T3 Eco | 8v8 | Unranked");
    expect(b.gameName).toBe("Beyond All Reason test-30484-7185ea5");
  });

  it("ignores non-BATTLEOPENED lines", () => {
    expect(parseBattleOpened(parseMessage("PING"))).toBeNull();
  });
});

describe("CLIENTSTATUS / client-status decoding", () => {
  it("decodes a zero status (no flags, lowest rank)", () => {
    const s = decodeClientStatus(0);
    expect(s).toEqual({ inGame: false, away: false, rank: 1, access: false, bot: false });
  });

  it("maps the rank bits (2-4) to a 1-8 display level", () => {
    // rank bits = 3 (b2-b4) → 3 << 2 = 12 → display level 4.
    expect(decodeClientStatus(3 << 2).rank).toBe(4);
    // rank bits = 0 → level 1; rank bits = 7 → level 8 (the max).
    expect(decodeClientStatus(0 << 2).rank).toBe(1);
    expect(decodeClientStatus(7 << 2).rank).toBe(8);
    // The rank bits are masked, so higher bits (access/bot) don't leak into rank.
    expect(decodeClientStatus(0xff).rank).toBe(8);
  });

  it("decodes in-game, away, moderator and bot flags", () => {
    expect(decodeClientStatus(1).inGame).toBe(true);
    expect(decodeClientStatus(2).away).toBe(true);
    expect(decodeClientStatus(1 << 5).access).toBe(true);
    expect(decodeClientStatus(1 << 6).bot).toBe(true);
  });

  it("parses a CLIENTSTATUS line into name + decoded status", () => {
    // 1 (in game) | 12 (rank bits = 3) | 32 (moderator) | 64 (bot) = 109.
    const e = parseClientStatus(parseMessage("CLIENTSTATUS Martakus 109"))!;
    expect(e.userName).toBe("Martakus");
    expect(e.status).toBe(109);
    expect(e.rank).toBe(4);
    expect(e.inGame).toBe(true);
    expect(e.away).toBe(false);
    expect(e.access).toBe(true);
    expect(e.bot).toBe(true);
  });

  it("ignores non-CLIENTSTATUS lines", () => {
    expect(parseClientStatus(parseMessage("PING"))).toBeNull();
  });
});

describe("UPDATEBATTLEINFO parsing", () => {
  it("reads the map name as the space-delimited remainder (real server format)", () => {
    // Captured live: the map name follows mapHash space-delimited, NOT after a TAB,
    // and may contain spaces. (matches Chobby's `([^\t]+)` after mapHash).
    const e = parseUpdateBattleInfo(parseMessage("UPDATEBATTLEINFO 7280 1 0 92980629 Hellas Basin v1.4"))!;
    expect(e.battleId).toBe(7280);
    expect(e.spectatorCount).toBe(1);
    expect(e.locked).toBe(false);
    expect(e.mapHash).toBe("92980629");
    expect(e.mapName).toBe("Hellas Basin v1.4");
  });

  it("reports the locked flag", () => {
    const e = parseUpdateBattleInfo(parseMessage("UPDATEBATTLEINFO 7094 1 1 1715956618 Salt Reef 1.1"))!;
    expect(e.locked).toBe(true);
    expect(e.mapName).toBe("Salt Reef 1.1");
  });

  it("still accepts a TAB-delimited map name (defensive fallback)", () => {
    const e = parseUpdateBattleInfo(parseMessage("UPDATEBATTLEINFO 100 3 1 mhash\tRosetta"))!;
    expect(e.mapName).toBe("Rosetta");
  });

  it("ignores non-UPDATEBATTLEINFO lines", () => {
    expect(parseUpdateBattleInfo(parseMessage("PING"))).toBeNull();
  });
});

describe("SAIDBATTLEEX parsing", () => {
  it("extracts the speaker and plain announce text", () => {
    const e = parseSaidBattleEx(
      parseMessage("SAIDBATTLEEX Host[EU8][020] * Hi Martakus! Current battle type is team"),
    )!;
    expect(e.userName).toBe("Host[EU8][020]");
    expect(e.message).toBe("* Hi Martakus! Current battle type is team");
    expect(e.barManager).toBeNull();
  });

  it("parses a BarManager JSON payload", () => {
    const json =
      '{"BattleStateChanged": {"locked": "unlocked", "autoBalance": "advanced", "teamSize": "8",' +
      ' "nbTeams": "2", "balanceMode": "clan;skill", "preset": "team", "mutes": "",' +
      ' "boss": "jimbobzayy,NoCommBombs"}}';
    const e = parseSaidBattleEx(parseMessage(`SAIDBATTLEEX Host[EU8][020] * BarManager|${json}`))!;
    expect(e.userName).toBe("Host[EU8][020]");
    expect(e.barManager).not.toBeNull();
    const state = e.barManager!["BattleStateChanged"] as Record<string, unknown>;
    expect(state["boss"]).toBe("jimbobzayy,NoCommBombs");
    expect(state["preset"]).toBe("team");
  });

  it("leaves barManager null when the JSON is malformed", () => {
    const e = parseSaidBattleEx(parseMessage("SAIDBATTLEEX Host * BarManager|{not json"))!;
    expect(e.barManager).toBeNull();
    expect(e.message).toBe("* BarManager|{not json");
  });

  it("ignores non-SAIDBATTLEEX lines", () => {
    expect(parseSaidBattleEx(parseMessage("PING"))).toBeNull();
  });
});

describe("s.battle.update_lobby_title parsing", () => {
  it("extracts the battle id and the title (with spaces and | separators)", () => {
    const e = parseUpdateLobbyTitle(
      parseMessage("s.battle.update_lobby_title 7950\tSupreme LAVA | 8v8 | Unranked"),
    )!;
    expect(e.battleId).toBe(7950);
    expect(e.title).toBe("Supreme LAVA | 8v8 | Unranked");
  });

  it("handles a short title without separators", () => {
    const e = parseUpdateLobbyTitle(parseMessage("s.battle.update_lobby_title 7421\tFFA Fast Start"))!;
    expect(e.battleId).toBe(7421);
    expect(e.title).toBe("FFA Fast Start");
  });

  it("returns null when the battle id is not numeric", () => {
    expect(parseUpdateLobbyTitle(parseMessage("s.battle.update_lobby_title x\tTitle"))).toBeNull();
  });

  it("ignores non-matching lines", () => {
    expect(parseUpdateLobbyTitle(parseMessage("PING"))).toBeNull();
  });
});

describe("CLIENTSTATUS parsing", () => {
  it("extracts the in-game bit (b0) from the status", () => {
    // 17 = 0b10001 → in-game set + rank bits.
    const a = parseClientStatus(parseMessage("CLIENTSTATUS Th1rD1ck 17"))!;
    expect(a.userName).toBe("Th1rD1ck");
    expect(a.status).toBe(17);
    expect(a.inGame).toBe(true);

    // 16 = 0b10000 → in-game clear.
    expect(parseClientStatus(parseMessage("CLIENTSTATUS Th1rD1ck 16"))!.inGame).toBe(false);
    // 1 → just the in-game bit.
    expect(parseClientStatus(parseMessage("CLIENTSTATUS host 1"))!.inGame).toBe(true);
    // 0 → nothing set.
    expect(parseClientStatus(parseMessage("CLIENTSTATUS host 0"))!.inGame).toBe(false);
  });

  it("returns null for other commands and missing names", () => {
    expect(parseClientStatus(parseMessage("CLIENTBATTLESTATUS x 1 0"))).toBeNull();
    expect(parseClientStatus(parseMessage("CLIENTSTATUS"))).toBeNull();
  });
});

describe("SETSCRIPTTAGS parsing", () => {
  it("extracts skills (bracket-stripped) and modoptions; ignores other tags", () => {
    const line =
      "SETSCRIPTTAGS game/players/kaskame/skill=[12.81]\t" +
      "game/players/kaskame/skilluncertainty=4.5\t" +
      "game/modoptions/allowpausegameplay=1\t" +
      "game/modoptions/wreck_metal_ratio=0.6\t" +
      "game/startmetal=1000";
    const e = parseSetScriptTags(parseMessage(line))!;

    expect(e.skills.get("kaskame")).toBe(12.81);
    expect(e.skills.has("kaskame/skilluncertainty")).toBe(false);
    expect(e.modoptions.get("allowpausegameplay")).toBe("1");
    expect(e.modoptions.get("wreck_metal_ratio")).toBe("0.6");
    // Non player/modoption tags are dropped.
    expect(e.modoptions.size).toBe(2);
    expect(e.skills.size).toBe(1);
  });

  it("keeps a modoption value that contains spaces (first, pre-TAB pair)", () => {
    const e = parseSetScriptTags(
      parseMessage("SETSCRIPTTAGS game/modoptions/debugcommands=extremebelow -25 0.125"),
    )!;
    expect(e.modoptions.get("debugcommands")).toBe("extremebelow -25 0.125");
  });

  it("parses a plain (unbracketed) skill value", () => {
    const e = parseSetScriptTags(parseMessage("SETSCRIPTTAGS game/players/alice/skill=10"))!;
    expect(e.skills.get("alice")).toBe(10);
  });

  it("ignores non-SETSCRIPTTAGS lines", () => {
    expect(parseSetScriptTags(parseMessage("PING"))).toBeNull();
  });
});
