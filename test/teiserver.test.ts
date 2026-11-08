import { describe, expect, it } from "vitest";
import {
  buildLobby,
  extractCsrfToken,
  parseLobbyIndex,
  parseLobbyShow,
  type IndexLobby,
} from "../src/teiserver";

// Minimal HTML slices mirroring the real Teiserver web UI (verified against
// server4.beyondallreason.info): the /battle/lobbies index row layout and a
// /battle/lobbies/show/<id> page for a normal (non-moderator) account — the players
// table has columns [icon, Name, Ready, Team, Party, Rating, Bonus, Faction] and the
// spectators table [icon, Name, Rating].

const INDEX_HTML = `
<table class="table table-sm table-hover">
  <tbody id="lobbies">
    <tr id="lobby-7950">
      <td>Supreme LAVA | 8v8 | Unranked</td>
      <td>Quicksilver Remake 1.2</td>
      <td><i class="fa-fw fa-solid fa-play"></i> &nbsp; 01:25</td>
      <td></td>
      <td><i class="fa-fw fa-solid fa-key"></i></td>
      <td>19</td>
      <td>16</td>
      <td>3</td>
      <td>&nbsp;</td>
    </tr>
    <tr id="lobby-8771">
      <td>EU7 - 011</td>
      <td>All That Glitters v2.2.3</td>
      <td></td>
      <td><i class="fa-fw fa-solid fa-lock"></i></td>
      <td></td>
      <td>1</td>
      <td>1</td>
      <td>0</td>
      <td>&nbsp;</td>
    </tr>
  </tbody>
</table>`;

const SHOW_HTML = `
<h4>
  Match in progress - 01:25 - Supreme LAVA | 8v8 | Unranked - Quicksilver Remake 1.2
</h4>
<ul>
  <li>Max players: 16</li>
  <li>Locked: false</li>
  <li>Rated Game: No</li>
  <li>Balance algorithm: loser_picks</li>
  <li>Bosses: Wherewolf, [Cookie]Stinkbee</li>
  <li>Host team-count: 2</li>
</ul>
<h4>Players</h4>
<table class="table table-sm" id="players-table">
  <thead>
    <tr>
      <th width="100">&nbsp;</th>
      <th>Name</th><th>Ready</th><th>Team</th><th>Party</th>
      <th>Rating</th><th>Bonus</th><th>Faction</th>
    </tr>
  </thead>
  <tbody>
    <tr id="user-row-1">
      <td></td><td>seymo5</td><td>Ready</td><td>0</td><td>&nbsp;</td>
      <td>29.47</td><td>0</td><td>Cortex</td>
    </tr>
    <tr id="user-row-2">
      <td></td><td>Cynical_Jester</td><td></td><td>1</td><td>&nbsp;</td>
      <td>8.96</td><td>0</td><td>Armada</td>
    </tr>
    <tr id="user-row-3">
      <td></td><td>NoSkill</td><td>Ready</td><td>1</td><td>&nbsp;</td>
      <td></td><td>0</td><td></td>
    </tr>
  </tbody>
</table>
<h4>Spectators</h4>
<table class="table table-sm" id="spectators-table">
  <thead>
    <tr><th width="100">&nbsp;</th><th>Name</th><th>Rating</th></tr>
  </thead>
  <tbody>
    <tr id="user-row-9"><td></td><td>jimbobzayy</td><td>8.9</td></tr>
  </tbody>
</table>`;


describe("extractCsrfToken", () => {
  it("reads the meta csrf-token", () => {
    expect(extractCsrfToken('<meta name="csrf-token" content="ABC123">')).toBe("ABC123");
  });

  it("falls back to the hidden form input", () => {
    const html = '<input name="_csrf_token" type="hidden" hidden value="XYZ789">';
    expect(extractCsrfToken(html)).toBe("XYZ789");
  });

  it("returns null when neither is present", () => {
    expect(extractCsrfToken("<html></html>")).toBeNull();
  });
});

describe("parseLobbyIndex", () => {
  it("parses each lobby row's id, name, map, counts and status icons", () => {
    const index = parseLobbyIndex(INDEX_HTML);
    expect([...index.keys()].sort()).toEqual([7950, 8771]);

    const a = index.get(7950)!;
    expect(a.name).toBe("Supreme LAVA | 8v8 | Unranked");
    expect(a.map).toBe("Quicksilver Remake 1.2");
    expect(a.inProgress).toBe(true);
    expect(a.locked).toBe(false);
    expect(a.passworded).toBe(true);
    expect(a.memberCount).toBe(19);
    expect(a.playerCount).toBe(16);
    expect(a.spectatorCount).toBe(3);

    const b = index.get(8771)!;
    expect(b.name).toBe("EU7 - 011"); // a " - " in the name must survive
    expect(b.inProgress).toBe(false);
    expect(b.locked).toBe(true);
    expect(b.passworded).toBe(false);
  });
});

describe("parseLobbyShow", () => {
  it("parses lobby-level fields and the boss list", () => {
    const show = parseLobbyShow(SHOW_HTML);
    expect(show.maxPlayers).toBe(16);
    expect(show.locked).toBe(false);
    expect(show.bosses).toEqual(["Wherewolf", "[Cookie]Stinkbee"]);
  });

  it("parses the balance algorithm", () => {
    expect(parseLobbyShow(SHOW_HTML).balanceAlgorithm).toBe("loser_picks");
    expect(parseLobbyShow(SHOW_HTML.replace(/<li>Balance algorithm:[\s\S]*?<\/li>/, ""))
      .balanceAlgorithm).toBeNull();
  });

  it("parses the in-progress heading and its elapsed time", () => {
    const show = parseLobbyShow(SHOW_HTML);
    expect(show.inProgress).toBe(true);
    expect(show.inProgressSec).toBe(85); // "01:25"
  });

  it("parses the longer duration forms (hours, days)", () => {
    const at = (dur: string) =>
      parseLobbyShow(SHOW_HTML.replace("01:25", dur)).inProgressSec;
    expect(at("1:05:25")).toBe(3925);
    expect(at("2d 1:05:25")).toBe(2 * 86400 + 3925);
  });

  it("reports pre-game lobbies as not in progress", () => {
    const pre = SHOW_HTML.replace(
      /<h4>[\s\S]*?<\/h4>/,
      "<h4>Pre-game lobby - Supreme LAVA | 8v8 | Unranked - Quicksilver Remake 1.2</h4>",
    );
    const show = parseLobbyShow(pre);
    expect(show.inProgress).toBe(false);
    expect(show.inProgressSec).toBeNull();
  });

  it("treats 'No boss' as an empty list", () => {
    const show = parseLobbyShow(SHOW_HTML.replace("Wherewolf, [Cookie]Stinkbee", "No boss"));
    expect(show.bosses).toEqual([]);
  });

  it("parses players (with ally team + skill) and spectators by header label", () => {
    const show = parseLobbyShow(SHOW_HTML);
    const players = show.members.filter((m) => !m.spectator);
    const specs = show.members.filter((m) => m.spectator);
    expect(players.map((p) => p.name)).toEqual(["seymo5", "Cynical_Jester", "NoSkill"]);

    const seymo = players.find((p) => p.name === "seymo5")!;
    expect(seymo.skill).toBe(29.47);
    expect(seymo.ally).toBe(0);
    expect(seymo.ready).toBe(true);

    const cj = players.find((p) => p.name === "Cynical_Jester")!;
    expect(cj.ally).toBe(1);
    expect(cj.ready).toBe(false);

    const ng = players.find((p) => p.name === "NoSkill")!;
    expect(ng.skill).toBeNull();

    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ name: "jimbobzayy", skill: 8.9, spectator: true, ally: 0 });
  });
});

describe("buildLobby", () => {
  const index: IndexLobby = {
    id: 7950,
    name: "Supreme LAVA | 8v8 | Unranked",
    map: "Quicksilver Remake 1.2",
    inProgress: true,
    locked: false,
    passworded: true,
    memberCount: 4,
    playerCount: 3,
    spectatorCount: 1,
  };

  it("maps into the lobbies() shape, sorts by skill, and reports gaps as empty", () => {
    const show = parseLobbyShow(SHOW_HTML);
    const lobby = buildLobby(index, show);

    expect(lobby.battleId).toBe(7950);
    expect(lobby.title).toBe("Supreme LAVA | 8v8 | Unranked");
    expect(lobby.map).toBe("Quicksilver Remake 1.2");
    expect(lobby.maxPlayers).toBe(16);
    expect(lobby.passworded).toBe(true);
    expect(lobby.bosses).toEqual(["Wherewolf", "[Cookie]Stinkbee"]);
    expect(lobby.playerCount).toBe(4); // 3 players + 1 spectator
    expect(lobby.spectatorCount).toBe(1);
    expect(lobby.inProgress).toBe(true);
    expect(lobby.inProgressSec).toBe(85);
    expect(lobby.balanceAlgorithm).toBe("loser_picks");
    // Not available from this source:
    expect(lobby.founder).toBe("");
    expect(lobby.gameName).toBe("");
    expect(lobby.engineVersion).toBe("");
  });

  it("derives per-player fields", () => {
    const show = parseLobbyShow(SHOW_HTML);
    const lobby = buildLobby(index, show);
    const order = lobby.players.map((p) => p.name);
    // skills: seymo5 29.47, Cynical_Jester 8.96, jimbobzayy 8.9, NoSkill null
    expect(order).toEqual(["seymo5", "Cynical_Jester", "jimbobzayy", "NoSkill"]);

    const seymo = lobby.players.find((p) => p.name === "seymo5")!;
    expect(seymo.skill).toBe(29.47);
    expect(seymo.ally).toBe(0);
    expect(seymo.team).toBe(0); // unique slot is moderator-only
    expect(seymo.ready).toBe(true);
    expect(seymo.spectator).toBe(false);
    expect(seymo.inGame).toBe(true); // lobby in progress
    expect(seymo.rank).toBeNull();
    expect(seymo.sync).toBe(0);
    expect(seymo.statusKnown).toBe(true);

    const spec = lobby.players.find((p) => p.name === "jimbobzayy")!;
    expect(spec.spectator).toBe(true);
  });

});

describe("parseLobbyShow — parties", () => {
  // Teiserver identifies parties by CELL COLOUR in the Party column (2+ members
  // only); an unstyled cell means no party. Markup mirrors the real template:
  // lib/teiserver_web/live/battles/lobbies/show.html.heex
  const SHOW = `
    <ul><li>Max players: 16</li><li>Locked: false</li><li>Bosses: No boss</li></ul>
    <table class="table table-sm" id="players-table"><thead><tr>
      <th width="100">&nbsp;</th><th>Name</th><th>Ready</th><th>Team</th><th>Party</th><th>Rating</th>
    </tr></thead><tbody>
      <tr><td width="100"></td><td>alpha</td><td>Ready</td><td>0</td><td style="background-color: #62EA6B;" width="50">&nbsp;</td><td>21.2</td></tr>
      <tr><td width="100"></td><td>bravo</td><td></td><td>0</td><td style="background-color: #62ea6b;" width="50">&nbsp;</td><td>18.0</td></tr>
      <tr><td width="100"></td><td>charlie</td><td>Ready</td><td>1</td><td style="background-color: #ea62d0;" width="50">&nbsp;</td><td>17.5</td></tr>
      <tr><td width="100"></td><td>delta</td><td>Ready</td><td>1</td><td style="background-color: #ea62d0;" width="50">&nbsp;</td><td>12.0</td></tr>
      <tr><td width="100"></td><td>solo</td><td></td><td>1</td><td width="50">&nbsp;</td><td>9.0</td></tr>
    </tbody></table>
    <table class="table table-sm" id="spectators-table"><thead><tr><th>Name</th><th>Rating</th></tr></thead>
    <tbody><tr><td>watcher</td><td>30.1</td></tr></tbody></table>`;

  it("groups players by the Party column's colour, case-insensitively", () => {
    const show = parseLobbyShow(SHOW);
    const party = (n: string) => show.members.find((m) => m.name === n)!.party;
    expect(party("alpha")).toBe(party("bravo"));
    expect(party("charlie")).toBe(party("delta"));
    expect(party("alpha")).not.toBe(party("charlie"));
    expect(party("solo")).toBeNull();
    expect(party("watcher")).toBeNull(); // spectators table has no Party column
  });

  it("threads the party key into the built lobby's players", () => {
    const index: IndexLobby = {
      id: 1, name: "n", map: "m", inProgress: false, locked: false, passworded: false,
      memberCount: 6, playerCount: 5, spectatorCount: 1,
    };
    const lobby = buildLobby(index, parseLobbyShow(SHOW));
    const party = (n: string) => lobby.players.find((p) => p.name === n)!.party;
    expect(party("alpha")).toBe("#62ea6b");
    expect(party("bravo")).toBe("#62ea6b");
    expect(party("charlie")).toBe("#ea62d0");
    expect(party("solo")).toBeNull();
    expect(party("watcher")).toBeNull();
    expect(lobby.inProgress).toBe(false);
    expect(lobby.inProgressSec).toBeNull();
    expect(lobby.balanceAlgorithm).toBeNull();
  });

  it("leaves party null when the page has no Party column at all", () => {
    const noParty = SHOW.replace("<th>Party</th>", "").replace(
      /<td style="background-color: [^"]*" width="50">&nbsp;<\/td>/g,
      "",
    ).replace(/<td width="50">&nbsp;<\/td>/g, "");
    for (const m of parseLobbyShow(noParty).members) expect(m.party).toBeNull();
  });
});
