import { describe, expect, it } from "vitest";
import { Battles, type ObservedMessage } from "../src/battle";
import {
  encodeBattleStatus,
  SPECTATOR_STATUS,
  SYNC_SYNCED,
  SYNC_UNSYNCED,
} from "../src/protocol/battleStatus";

// BATTLEOPENED battleId type natType founder ip port maxPlayers passworded rank
//   mapHash engineName \t engineVersion \t map \t title \t gameName
function battleOpened(id: number, founder: string): string {
  return `BATTLEOPENED ${id} 0 0 ${founder} 1.2.3.4 53211 16 0 0 -590370561 spring` +
    `\t2025.06.24\tComet\t${founder}'s lava game\tBYAR`;
}

let seq = 0;
/** Wrap a raw protocol line in a proxy envelope for `Battles.observe`. */
function obs(msg: string, src: "client" | "server" = "server"): ObservedMessage {
  return { ts: ++seq, src, msg };
}

describe("Battles routing", () => {
  it("tracks all battles, not just configured lava lobbies", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);

    // Joining a lobby is what marks it as lava, so messages for not-yet-lava
    // battles must still be processed — we track every battle the line concerns.
    expect(b.observe(obs(battleOpened(100, "host")))).toBe(100);
    expect(b.observe(obs(battleOpened(200, "other")))).toBe(200);

    expect(b.size).toBe(2);
    expect(b.get(100)?.founder).toBe("host");
    expect(b.get(200)?.founder).toBe("other");

    // ...but only the configured lava lobby is surfaced via lava().
    expect(b.lava().map((x) => x.battleId)).toEqual([100]);
  });

  it("returns null (drop) for non-battle messages", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);
    expect(b.observe(obs("PING"))).toBeNull();
    expect(b.observe(obs("ADDUSER alice ?? 42 lavabalance"))).toBeNull();
  });
});

describe("Battle player tracking", () => {
  it("tracks players from status, plus leaves", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);
    b.observe(obs(battleOpened(100, "host")));

    // The bot joins, which makes 100 the current battle for untagged lines. The bot's
    // own join doesn't add a player — only members' CLIENTBATTLESTATUS do.
    b.observe(obs("JOINEDBATTLE 100 lavabalance"));
    // CLIENTBATTLESTATUS carries no battle id — routed to the bot's current battle.
    const playing = encodeBattleStatus({ ...SPECTATOR_STATUS, player: true, ally: 1, team: 2 });
    b.observe(obs(`CLIENTBATTLESTATUS alice ${playing} 0`));
    b.observe(obs(`CLIENTBATTLESTATUS bob ${encodeBattleStatus(SPECTATOR_STATUS)} 0`));

    const snap = b.get(100)!.snapshot();
    // host (founder) + alice + bob (the status-less bot join isn't counted)
    expect(snap.playerCount).toBe(3);

    const alice = snap.players.find((p) => p.name === "alice")!;
    expect(alice.statusKnown).toBe(true);
    expect(alice.spectator).toBe(false);
    expect(alice.ally).toBe(1);
    expect(alice.team).toBe(2);

    const bob = snap.players.find((p) => p.name === "bob")!;
    expect(bob.spectator).toBe(true);

    b.observe(obs("LEFTBATTLE 100 alice"));
    expect(b.get(100)!.hasPlayer("alice")).toBe(false);
  });

  it("surfaces a player's sync status (e.g. unsynced while downloading the map)", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);
    b.observe(obs(battleOpened(100, "host")));
    b.observe(obs("JOINEDBATTLE 100 lavabalance"));

    // dave joined and is still downloading the map: player, sync = 2 (unsynced).
    const downloading = encodeBattleStatus({
      ...SPECTATOR_STATUS,
      player: true,
      ally: 0,
      team: 3,
      sync: SYNC_UNSYNCED,
    });
    b.observe(obs(`CLIENTBATTLESTATUS dave ${downloading} 0`));
    const dave = b.get(100)!.snapshot().players.find((p) => p.name === "dave")!;
    expect(dave.sync).toBe(SYNC_UNSYNCED);
    expect(dave.spectator).toBe(false);

    // Once the download finishes the client re-sends with sync = 1 (synced).
    const synced = encodeBattleStatus({
      ...SPECTATOR_STATUS,
      player: true,
      ally: 0,
      team: 3,
      sync: SYNC_SYNCED,
    });
    b.observe(obs(`CLIENTBATTLESTATUS dave ${synced} 0`));
    expect(b.get(100)!.snapshot().players.find((p) => p.name === "dave")!.sync).toBe(SYNC_SYNCED);
  });

  it("routes untagged lines only while the bot is in a battle", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);
    b.observe(obs(battleOpened(100, "host")));

    // No current battle yet (bot hasn't joined): untagged lines don't route.
    expect(b.observe(obs("CLIENTBATTLESTATUS host 0 0"))).toBeNull();
    expect(b.observe(obs("SETSCRIPTTAGS game/foo=bar"))).toBeNull();

    // The bot's join makes 100 the current battle.
    b.observe(obs("JOINEDBATTLE 100 lavabalance"));
    expect(b.observe(obs("CLIENTBATTLESTATUS host 0 0"))).toBe(100);
    expect(b.observe(obs("SETSCRIPTTAGS game/foo=bar"))).toBe(100);

    // Dropping the lobby from the config (e.g. the bot left) clears the current battle.
    b.setLavaLobbies([]);
    expect(b.observe(obs("SETSCRIPTTAGS game/foo=bar"))).toBeNull();
  });

  it("only the bot's own JOINEDBATTLE adopts the current battle (no stranger hijack)", () => {
    // Reproduces the root of the cross-battle roster bug. Battle 200 is a *stale* lava
    // lobby — the bot joined it earlier and the server never sent a LEFTBATTLE, so its
    // id lingers in the set. A stranger joining that stale lobby must NOT make it the
    // bot's current battle: only the bot's own join may.
    const b = new Battles("huk123");
    b.setLavaLobbies([200]);
    b.observe(obs(battleOpened(200, "h2")));

    // A stranger joins the stale lava lobby 200. Without the self-name gate this would
    // hijack `currentBattle` to 200.
    b.observe(obs("JOINEDBATTLE 200 stranger"));
    expect(b.currentBattleId()).toBeNull();

    // The bot is actually in battle 100.
    b.setLavaLobbies([200, 100]);
    b.observe(obs(battleOpened(100, "h1")));
    b.observe(obs("JOINEDBATTLE 100 huk123"));
    expect(b.currentBattleId()).toBe(100);

    // Another stranger joins the stale lobby 200 — must not steal the current battle.
    b.observe(obs("JOINEDBATTLE 200 stranger2"));
    expect(b.currentBattleId()).toBe(100);

    // So an untagged CLIENTBATTLESTATUS routes to 100 (where the bot is), never to 200.
    const playing = encodeBattleStatus({ ...SPECTATOR_STATUS, player: true, ally: 0, team: 1 });
    expect(b.observe(obs(`CLIENTBATTLESTATUS someone ${playing} 0`))).toBe(100);
    expect(b.get(100)!.hasPlayer("someone")).toBe(true);
    expect(b.get(200)!.hasPlayer("someone")).toBe(false);
  });

  it("rebuilds state after joining battle", () => {
    const b = new Battles("huk123");
    b.setLavaLobbies([7294]);
    const lines = `JOINEDBATTLE 7294 huk123 5477124768
SETSCRIPTTAGS game/modoptions/allowpausegameplay=1
CLIENTBATTLESTATUS Host[EU8][020] 4194306 16777215
CLIENTBATTLESTATUS maxwar 4194304 10055846
CLIENTBATTLESTATUS the_serious_boi 20972600 3772862`;
    for (const l of lines.split("\n")) {
      b.observe(obs(l));
    }

    expect(b.get(7294)).toBeTruthy();
    expect(b.get(7294)!.playerCount).toBe(3);
  });

  it("does not route CLIENTSTATUS to a battle (it's a global, per-user broadcast)", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);
    b.observe(obs(battleOpened(100, "host")));
    b.observe(obs("JOINEDBATTLE 100 lavabalance"));
    const playing = encodeBattleStatus({ ...SPECTATOR_STATUS, player: true, ally: 1, team: 2 });
    b.observe(obs(`CLIENTBATTLESTATUS alice ${playing} 0`));

    // CLIENTSTATUS (rank, in-game, away) is room-independent: the Dispatcher records it
    // on the global user directory, so Battles leaves it unrouted (returns null) even
    // for a member of a tracked battle.
    expect(b.observe(obs("CLIENTSTATUS alice 17"))).toBeNull();
  });

  it("stores structured BATTLEOPENED fields (title, map, game, engine)", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);
    b.observe(obs(battleOpened(100, "host")));

    const snap = b.get(100)!.snapshot();
    expect(snap.title).toBe("host's lava game");
    expect(snap.map).toBe("Comet");
    expect(snap.gameName).toBe("BYAR");
    expect(snap.engineVersion).toBe("2025.06.24");
    expect(snap.maxPlayers).toBe(16);
  });

  it("tracks lobby status from UPDATEBATTLEINFO", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);
    b.observe(obs(battleOpened(100, "host")));
    // Real server format: the map name is space-delimited after mapHash (no TAB).
    b.observe(obs("UPDATEBATTLEINFO 100 3 1 92980629 Hellas Basin v1.4"));

    const snap = b.get(100)!.snapshot();
    expect(snap.spectatorCount).toBe(3);
    expect(snap.locked).toBe(true);
    expect(snap.map).toBe("Hellas Basin v1.4");
  });

  it("updates the title from s.battle.update_lobby_title", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);
    b.observe(obs(battleOpened(100, "host")));
    expect(b.get(100)!.snapshot().title).toBe("host's lava game");

    // The id is tagged on the line, so this routes regardless of the current battle.
    expect(
      b.observe(obs("s.battle.update_lobby_title 100\tSupreme LAVA | 8v8 | Unranked")),
    ).toBe(100);
    expect(b.get(100)!.snapshot().title).toBe("Supreme LAVA | 8v8 | Unranked");
  });

  it("tracks a title update for an unconfigured battle", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);
    // The id is tagged on the line, so it routes and the battle is tracked even
    // though it isn't (yet) a configured lava lobby.
    expect(b.observe(obs("s.battle.update_lobby_title 200\tTracked"))).toBe(200);
    expect(b.get(200)!.snapshot().title).toBe("Tracked");
  });

  it("forgets a battle on BATTLECLOSED", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);
    b.observe(obs(battleOpened(100, "host")));
    b.observe(obs("JOINEDBATTLE 100 lavabalance"));
    b.observe(obs("BATTLECLOSED 100"));
    expect(b.get(100)).toBeUndefined();
    expect(b.size).toBe(0);
    // The current battle is cleared on close, so untagged lines no longer route.
    expect(b.observe(obs("CLIENTBATTLESTATUS alice 0 0"))).toBeNull();
  });

  it("keeps tracking battles dropped from the config (only lava() filters)", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100, 200]);
    b.observe(obs(battleOpened(100, "h1")));
    b.observe(obs(battleOpened(200, "h2")));
    expect(b.size).toBe(2);

    // Dropping 200 from the lava set must NOT destroy its tracked state — battles are
    // only forgotten on BATTLECLOSED. It just stops appearing in lava().
    b.setLavaLobbies([100]);
    expect(b.size).toBe(2);
    expect(b.get(200)?.founder).toBe("h2");
    expect(b.lava().map((x) => x.battleId)).toEqual([100]);
  });

  it("keeps a battle's title when the bot leaves (lobby dropped from lava)", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);
    b.observe(obs(battleOpened(100, "host")));
    b.observe(obs("s.battle.update_lobby_title 100\tSupreme LAVA | 8v8 | Unranked"));
    expect(b.get(100)!.snapshot().title).toBe("Supreme LAVA | 8v8 | Unranked");

    // The bot leaves: the Dispatcher drops 100 from the lava set, then this same
    // LEFTBATTLE is routed. The battle must survive with its title intact.
    b.setLavaLobbies([]);
    expect(b.observe(obs("LEFTBATTLE 100 huk123"))).toBe(100);
    expect(b.get(100)!.snapshot().title).toBe("Supreme LAVA | 8v8 | Unranked");
  });
});

describe("Battle BarManager / boss tracking", () => {
  const barState = (host: string, boss: string) =>
    `SAIDBATTLEEX ${host} * BarManager|` +
    JSON.stringify({ BattleStateChanged: { preset: "team", boss } });

  it("routes SAIDBATTLEEX to the bot's current battle and tracks bosses", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);
    b.observe(obs(battleOpened(100, "host")));
    b.observe(obs("JOINEDBATTLE 100 lavabalance"));

    expect(b.observe(obs(barState("host", "jimbobzayy,NoCommBombs")))).toBe(100);
    const snap = b.get(100)!.snapshot();
    expect(snap.bosses).toEqual(["jimbobzayy", "NoCommBombs"]);
    expect(b.get(100)!.isBoss("jimbobzayy")).toBe(true);
    expect(b.get(100)!.isBoss("someone")).toBe(false);
  });

  it("replaces the boss list on each BattleStateChanged and clears on empty", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);
    b.observe(obs(battleOpened(100, "host")));
    b.observe(obs("JOINEDBATTLE 100 lavabalance"));

    b.observe(obs(barState("host", "alice,bob")));
    expect(b.get(100)!.snapshot().bosses).toEqual(["alice", "bob"]);
    b.observe(obs(barState("host", "carol")));
    expect(b.get(100)!.snapshot().bosses).toEqual(["carol"]);
    b.observe(obs(barState("host", "")));
    expect(b.get(100)!.snapshot().bosses).toEqual([]);
  });

  it("does not route an announce when the bot is in no battle", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);
    b.observe(obs(battleOpened(100, "host")));
    expect(b.observe(obs("SAIDBATTLEEX stranger * hello"))).toBeNull();
  });

  it("logs a plain announce without touching the boss list", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);
    b.observe(obs(battleOpened(100, "host")));
    b.observe(obs("JOINEDBATTLE 100 lavabalance"));
    expect(b.observe(obs("SAIDBATTLEEX host * Current battle type is team"))).toBe(100);
    expect(b.get(100)!.snapshot().bosses).toEqual([]);
  });
});

describe("Battle BarManager vote tracking", () => {
  const barVote = (key: string, payload: Record<string, unknown>) =>
    `SAIDBATTLEEX host * BarManager|` + JSON.stringify({ [key]: payload });

  function joined(): Battles {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);
    b.observe(obs(battleOpened(100, "host")));
    b.observe(obs("JOINEDBATTLE 100 lavabalance"));
    return b;
  }

  it("tracks an onVoteStart and clears on onVoteStop", () => {
    const b = joined();
    b.observe(obs(barVote("onVoteStart", { command: ["start"], user: "huk123", yesCount: 1 })));
    expect(b.get(100)!.voteInProgress).toEqual({ command: ["start"], caller: "huk123" });
    expect(b.get(100)!.snapshot().vote).toEqual({ command: ["start"], caller: "huk123" });

    b.observe(obs(barVote("onVoteStop", { command: ["start"], user: "huk123", voteResult: 0 })));
    expect(b.get(100)!.voteInProgress).toBeNull();
    expect(b.get(100)!.snapshot().vote).toBeNull();
  });

  it("treats a currentVote refresh as a vote in progress", () => {
    const b = joined();
    b.observe(obs(barVote("currentVote", { command: ["forceStart"], user: "alice" })));
    expect(b.get(100)!.voteInProgress).toEqual({ command: ["forceStart"], caller: "alice" });
  });

  it("tolerates malformed vote payloads", () => {
    const b = joined();
    b.observe(obs(barVote("onVoteStart", { command: "start", user: 7 })));
    expect(b.get(100)!.voteInProgress).toEqual({ command: [], caller: "" });
    b.observe(obs(barVote("onVoteStop", {})));
    expect(b.get(100)!.voteInProgress).toBeNull();
  });

  it("a multi-token voted command keeps all its tokens", () => {
    const b = joined();
    b.observe(obs(barVote("onVoteStart", { command: ["set", "map", "Comet"], user: "bob" })));
    expect(b.get(100)!.voteInProgress).toEqual({ command: ["set", "map", "Comet"], caller: "bob" });
  });
});

describe("Battle SETSCRIPTTAGS / modoptions", () => {
  function joined(b: Battles): void {
    b.setLavaLobbies([100]);
    b.observe(obs(battleOpened(100, "host")));
    b.observe(obs("JOINEDBATTLE 100 lavabalance"));
  }

  it("records modoptions and ignores player skill tags (skill lives in the Dispatcher)", () => {
    const b = new Battles("lavabalance");
    joined(b);

    expect(
      b.observe(
        obs(
          "SETSCRIPTTAGS game/players/kaskame/skill=[12.81]\t" +
            "game/modoptions/allowpausegameplay=1\t" +
            "game/modoptions/wreck_metal_ratio=0.6",
        ),
      ),
    ).toBe(100);

    const battle = b.get(100)!;
    expect(battle.modOptions().get("allowpausegameplay")).toBe("1");
    expect(battle.modOptions().get("wreck_metal_ratio")).toBe("0.6");
    // The battle does not track per-player skill (no player/skill key leaked in).
    expect(battle.modOptions().has("players/kaskame/skill")).toBe(false);
  });

  it("handles a value containing spaces in the first (pre-TAB) pair", () => {
    const b = new Battles("lavabalance");
    joined(b);

    b.observe(obs("SETSCRIPTTAGS game/modoptions/debugcommands=extremebelow -25 0.125"));
    expect(b.get(100)!.modOptions().get("debugcommands")).toBe("extremebelow -25 0.125");
  });

  it("merges modoptions across successive SETSCRIPTTAGS messages", () => {
    const b = new Battles("lavabalance");
    joined(b);

    b.observe(obs("SETSCRIPTTAGS game/modoptions/a=1"));
    b.observe(obs("SETSCRIPTTAGS game/modoptions/b=2"));

    const battle = b.get(100)!;
    expect(battle.modOptions().get("a")).toBe("1");
    expect(battle.modOptions().get("b")).toBe("2");
  });
});

describe("Battle message log", () => {
  it("records only the routed lines on each battle, newest-first", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100, 200]);
    b.observe(obs(battleOpened(100, "host")));
    b.observe(obs(battleOpened(200, "host2")));
    b.observe(obs("JOINEDBATTLE 100 alice"));
    b.observe(obs("JOINEDBATTLE 200 carol"));
    b.observe(obs("JOINEDBATTLE 100 bob"));

    const log100 = b.get(100)!.readLog(100);
    expect(log100.total).toBe(3); // BATTLEOPENED 100, JOINEDBATTLE alice, JOINEDBATTLE bob
    expect(log100.entries.map((e) => e.msg)).toEqual([
      "JOINEDBATTLE 100 bob",
      "JOINEDBATTLE 100 alice",
      battleOpened(100, "host"),
    ]);
    // None of battle 200's traffic leaked into battle 100's log.
    expect(log100.entries.every((e) => !e.msg.includes("200"))).toBe(true);

    expect(b.get(200)!.readLog(100).total).toBe(2);
  });

  it("respects the limit (most recent N)", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([100]);
    b.observe(obs(battleOpened(100, "host")));
    b.observe(obs("JOINEDBATTLE 100 alice"));
    b.observe(obs("JOINEDBATTLE 100 bob"));

    const log = b.get(100)!.readLog(1);
    expect(log.total).toBe(3);
    expect(log.count).toBe(1);
    expect(log.entries[0].msg).toBe("JOINEDBATTLE 100 bob");
  });
});

describe("Battles.setSelfName (session account learned from LOGIN)", () => {
  it("routes untagged lines only after the real session account is known", () => {
    // The tracker starts with the statically configured account (BOT_USERNAME) —
    // which may NOT be the account the observed session actually logs in as.
    const b = new Battles("huk123");
    b.setLavaLobbies([1242]);
    b.observe(obs(battleOpened(1242, "Host[EU8][027]")));

    // The bot's own join under its real account: with the stale self name it is a
    // stranger's join, so untagged lines must NOT route anywhere.
    b.observe(obs("JOINEDBATTLE 1242 lavabalance"));
    expect(b.currentBattleId()).toBeNull();
    expect(b.observe(obs("CLIENTBATTLESTATUS KingBlakey 4194348 8686400"))).toBeNull();

    // Once the Dispatcher sees `c LOGIN lavabalance` it corrects the self name;
    // the next join adopts the battle and untagged lines route to it.
    b.setSelfName("lavabalance");
    b.observe(obs("JOINEDBATTLE 1242 lavabalance"));
    expect(b.currentBattleId()).toBe(1242);
    expect(b.observe(obs("CLIENTBATTLESTATUS KingBlakey 4194348 8686400"))).toBe(1242);

    // And the decoded status is applied faithfully: KingBlakey is a spectator.
    const p = b.get(1242)!.snapshot().players.find((x) => x.name === "KingBlakey")!;
    expect(p.spectator).toBe(true);
    expect(p.statusKnown).toBe(true);
  });
});

describe("leave signals beyond LEFTBATTLE", () => {
  // Teiserver suppresses most membership broadcasts for a bot client: departures
  // often arrive with NO LEFTBATTLE. The two remaining signals are SPADS clearing
  // the player's script tags, and the server-wide REMOVEUSER on disconnect.
  it("REMOVESCRIPTTAGS drops the (lowercased) named players from the current battle", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([1242]);
    b.observe(obs("JOINEDBATTLE 1242 lavabalance"));
    b.observe(obs("CLIENTBATTLESTATUS [BRP]WAFFLEMAKER 20972582 4732393"));
    b.observe(obs("CLIENTBATTLESTATUS rickstar19 4195400 854443"));

    expect(
      b.observe(obs("REMOVESCRIPTTAGS game/players/[brp]wafflemaker/skilluncertainty game/players/[brp]wafflemaker/skill")),
    ).toBe(1242);
    let names = b.get(1242)!.snapshot().players.map((p) => p.name);
    expect(names).toEqual(["rickstar19"]);

    // A later CLIENTBATTLESTATUS re-adds a player whose tags were cleared for
    // another reason (e.g. a spectator switch).
    b.observe(obs("REMOVESCRIPTTAGS game/players/rickstar19/skill"));
    b.observe(obs("CLIENTBATTLESTATUS rickstar19 4194304 854443"));
    names = b.get(1242)!.snapshot().players.map((p) => p.name);
    expect(names).toEqual(["rickstar19"]);
    expect(b.get(1242)!.snapshot().players[0].spectator).toBe(true);
  });

  it("REMOVEUSER purges the user from every battle roster", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([1242]);
    b.observe(obs("JOINEDBATTLE 1242 lavabalance"));
    b.observe(obs("CLIENTBATTLESTATUS Kerinas 4195400 1"));
    b.observe(obs("CLIENTBATTLESTATUS huk123 4195354 2"));

    expect(b.observe(obs("REMOVEUSER Kerinas"))).toBeNull(); // not battle-specific
    const names = b.get(1242)!.snapshot().players.map((p) => p.name);
    expect(names).toEqual(["huk123"]);
  });
});

describe("BarManager lobby settings", () => {
  const barManager = (fields: Record<string, string>) =>
    `SAIDBATTLEEX Host[EU8][027] * BarManager|${JSON.stringify({ BattleStateChanged: fields })}`;

  it("records the lobby's own autoBalance setting alongside the boss list", () => {
    const b = new Battles("lavabalance");
    b.setLavaLobbies([1242]);
    b.observe(obs(battleOpened(1242, "Host[EU8][027]")));
    b.observe(obs("JOINEDBATTLE 1242 lavabalance"));

    // Unseen until the host broadcasts.
    expect(b.get(1242)!.snapshot().autoBalance).toBeNull();
    expect(b.get(1242)!.snapshot().balanceMode).toBeNull();

    b.observe(
      obs(barManager({ autoBalance: "Advanced", balanceMode: "Clan;Skill", boss: "KingBlakey,Songi" })),
    );
    let snap = b.get(1242)!.snapshot();
    expect(snap.autoBalance).toBe("advanced"); // normalised
    expect(snap.balanceMode).toBe("clan;skill"); // normalised
    expect(b.get(1242)!.balanceModeSetting).toBe("clan;skill");
    expect(snap.bosses).toEqual(["KingBlakey", "Songi"]);

    // A later broadcast updates what it carries; the rest is untouched when absent.
    b.observe(obs(barManager({ autoBalance: "off" })));
    snap = b.get(1242)!.snapshot();
    expect(snap.autoBalance).toBe("off");
    expect(snap.balanceMode).toBe("clan;skill");
    expect(snap.bosses).toEqual(["KingBlakey", "Songi"]);

    b.observe(obs(barManager({ balanceMode: "skill" })));
    expect(b.get(1242)!.snapshot().balanceMode).toBe("skill");
  });
});
