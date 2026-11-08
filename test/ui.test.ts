// Syntax guard for the two inlined pages.
//
// `ui.ts` builds each page inside a TS template literal, so a stray **backtick** in a comment
// (e.g. describing a `variable`) silently ENDS the template: tsc still accepts the file — what
// follows happens to parse as TypeScript — but the served page gets a truncated <script> and
// the whole UI dies in the browser. That bit twice during development, hence this test: compile
// each page's inlined script and assert the markers that must survive to the end of it.

import { describe, expect, it } from "vitest";
import { ALL_LOBBIES_HTML, BOT_HTML, GAME_HTML, GAMES_HTML, LOBBIES_HTML, LOBBY_HTML, LOGIN_HTML, PLAYER_HTML, POLLS_HTML, RANKING_HTML, SCOUTING_HTML, SQL_HTML } from "../src/ui";

/** The contents of the page's single inlined <script> block. */
function inlineScript(html: string): string {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  expect(m, "the page should carry exactly one inlined <script>").toBeTruthy();
  return m![1]!;
}

describe.each([
  ["LOBBIES_HTML", LOBBIES_HTML],
  ["ALL_LOBBIES_HTML", ALL_LOBBIES_HTML],
  ["LOBBY_HTML", LOBBY_HTML],
  ["RANKING_HTML", RANKING_HTML],
  ["PLAYER_HTML", PLAYER_HTML],
  ["GAMES_HTML", GAMES_HTML],
  ["GAME_HTML", GAME_HTML],
  ["SCOUTING_HTML", SCOUTING_HTML],
  ["SQL_HTML", SQL_HTML],
  ["BOT_HTML", BOT_HTML],
  ["LOGIN_HTML", LOGIN_HTML],
])("%s", (_name, html) => {
  it("has a syntactically valid inlined script", () => {
    const script = inlineScript(html);
    // Compiling (not running) is enough: it parses the whole body, and a template literal cut
    // short by a stray backtick fails here. The script touches `document`, so never call it.
    expect(() => new Function(script)).not.toThrow();
  });

  it("carries no TS-template-literal escape hatch in the emitted page", () => {
    // A `${...}` left in the emitted HTML means an interpolation didn't happen; a lone
    // backtick in the script means a comment or string broke the template.
    const script = inlineScript(html);
    expect(script).not.toContain("${");
    expect(script).not.toContain("`");
  });

  it("carries the sidebar menu with all three sections plus the admin-only SQL entry", () => {
    expect(html).toContain('<nav class="side">');
    expect(html).toContain('href="/ranking"');
    expect(html).toContain('href="/games"');
    expect(html).toContain("navLobby");
    // Hidden by CSS unless SHARED_JS finds admin mode and marks <body>. The
    // Worker flips the marker for a verified Access admin (src/index.ts page()).
    expect(html).toMatch(/<a class="nav admin( active)?" href="\/sql">/);
    expect(html).toContain("nav.side a.nav.admin { display: none; }");
    expect(html).toContain("body.admin-mode nav.side a.nav.admin { display: flex; }");
    expect(inlineScript(html)).toContain("const ADMIN_MODE = /*ADMIN_MODE*/false;");
    expect(inlineScript(html)).not.toContain('PAGE_PARAMS.get("admin")');
  });

  it("shows the auto-refresh toggle (and runs its timer) only in admin mode", () => {
    expect(html).toContain("header.top .toggle { display: none; }");
    expect(html).toContain("body.admin-mode header.top .toggle { display: inline-block; }");
    const script = inlineScript(html);
    expect(script).toContain('let auto = ADMIN_MODE && localStorage.getItem("autoRefresh") === "on"');
    expect(script).toContain("if (autoBtn && ADMIN_MODE) {");
  });
});

describe("the lobby picker (/lobbies)", () => {
  it("offers 'Select a lobby' from both lobby pages' empty states", () => {
    expect(inlineScript(LOBBIES_HTML)).toContain(
      "'<br /><a class=\"pick\" href=\"/lobbies' + SRC_QUERY + '\">Select a lobby</a></div>'",
    );
    expect(inlineScript(LOBBIES_HTML)).toContain("No lava lobbies are currently open (or none configured).");
    expect(inlineScript(LOBBY_HTML)).toContain(
      "'<br /><a class=\"pick\" href=\"/lobbies' + SRC_QUERY + '\">Select a lobby</a></div>'",
    );
  });

  it("draws the avoid line admin-only, and only from data the admin view carries", () => {
    const script = inlineScript(LOBBY_HTML);
    // The row itself is behind the same client-side switch as the other
    // admin-only chrome, and the pair that both people are in the lobby for is
    // marked apart from the rest of a list.
    expect(script).toContain('<div class="line admin-only"><span class="k">\u{1F6AB} Avoids</span>');
    expect(script).toContain('class="avoid-pair');
    expect(LOBBY_HTML).toContain(".lobby .foot-lists .line.admin-only { display: none; }");
    expect(LOBBY_HTML).toContain("body.admin-mode .lobby .foot-lists .line.admin-only { display: block; }");
  });

  it("puts an orange-ringed 'View all lobbies' button left of auto-refresh on the lobby pages", () => {
    for (const html of [LOBBIES_HTML, LOBBY_HTML]) {
      const viewAll = html.indexOf('<a class="viewall" id="viewAll" href="/lobbies"');
      const toggle = html.indexOf('<button class="toggle" id="autoToggle"');
      expect(viewAll).toBeGreaterThan(-1);
      expect(viewAll).toBeLessThan(toggle);
      expect(html).toContain("border: 1px solid #e8862a;");
      expect(html).toContain("header.top .viewall ~ .toggle { margin-left: 0; }");
    }
    // The picker itself has no button to itself.
    expect(ALL_LOBBIES_HTML).not.toContain('class="viewall"');
  });

  it("lists every lobby with players from /api/lobbies/all as a table whose rows open /lobby/:id", () => {
    const script = inlineScript(ALL_LOBBIES_HTML);
    expect(script).toContain('const ALL_LOBBIES_URL = "/api/lobbies/all";');
    expect(script).toContain("<th>Lobby</th><th>#</th><th>Map</th><th>Status</th>");
    expect(script).toContain('const href = "/lobby/" + encodeURIComponent(l.id) + SRC_QUERY;');
    expect(script).toContain("'<tr data-href=\"' + href + '\">'");
    expect(script).toContain('wireRowClicks("rows");');
    expect(script).not.toContain("/api/lobbies/select");
    // wireRowClicks handles any data-href row, not only game rows.
    expect(script).toContain('e.target.closest("tr[data-href]")');
    expect(script).toContain("No lobbies with players are currently open.");
    // Lava lobbies are named in the button's orange.
    expect(script).toContain("'<td class=\"lname\"><a class=\"plink' + (lava ? ' lava' : '') + '\"");
    expect(ALL_LOBBIES_HTML).toContain(".all-lobbies td.lname a.plink.lava { color: #f0a35c; }");
  });
});

describe("SQL_HTML", () => {
  it("reads /api/sqlstats only in admin mode and projects onto the free-plan budgets", () => {
    const script = inlineScript(SQL_HTML);
    for (const marker of [
      "const SQL_READS_PER_DAY = 5000000",
      "const SQL_WRITES_PER_DAY = 100000",
      'fetch("/api/sqlstats"',
      "seq !== sqlStatsSeq",
      "if (ADMIN_MODE) {",
      "This page is admin-only",
    ]) {
      expect(script).toContain(marker);
    }
  });
});

describe("BOT_HTML", () => {
  it("has an admin-only sidebar entry on every page", () => {
    for (const html of [LOBBIES_HTML, ALL_LOBBIES_HTML, LOBBY_HTML, RANKING_HTML, PLAYER_HTML, GAMES_HTML, GAME_HTML, SQL_HTML, BOT_HTML]) {
      expect(html).toMatch(/<a class="nav admin( active)?" href="\/bot">/);
    }
  });

  it("reads /bot/status only in admin mode and drives Start/Stop with the bearer token", () => {
    const script = inlineScript(BOT_HTML);
    for (const marker of [
      // The token field: kept in localStorage, sent as the Authorization header.
      'const TOKEN_KEY = "controlToken"',
      'h.authorization = "Bearer " + t',
      // Status polling + the two actions.
      'fetch("/bot/status", { headers: authHeaders() })',
      'fetch("/bot/" + which, { method: "POST", headers: authHeaders() })',
      'act("start")',
      'act("stop")',
      // A failed start relays the supervisor's reason.
      "the container did not come up",
      // Stale-reply guard and the admin gate, like the SQL page.
      "seq !== statusSeq",
      "if (ADMIN_MODE) {",
      "This page is admin-only",
    ]) {
      expect(script).toContain(marker);
    }
  });

  it("maps the platform state to the headline", () => {
    const script = inlineScript(BOT_HTML);
    expect(script).toContain('s.status === "running" || s.status === "healthy"');
    expect(script).toContain("should be running");
  });

  it("shows prominently which lobby the bot is in (or that it isn't in any)", () => {
    const script = inlineScript(BOT_HTML);
    for (const marker of [
      "function lobbyLine",
      "In lobby ",
      "Not in any lobby.",
      "Bot is not running — no lobby.",
      "Joining lobby #",
      // The banner links to the lobby page and picks up its title from the
      // PUBLIC detail endpoint (no token), once per battle id.
      "\"/lobby/' + encodeURIComponent(battle)",
      'fetch("/api/lobbies/" + encodeURIComponent(battle))',
      "function ensureLobbyTitle",
    ]) {
      expect(script).toContain(marker);
    }
  });

  it("shows the persisted restart-rejoin target", () => {
    const script = inlineScript(BOT_HTML);
    expect(script).toContain("s.lastBattle != null");
    expect(script).toContain('kv("Rejoin on restart"');
  });

  it("joins the main lobby and any lobby by id via POST /bot/join", () => {
    const script = inlineScript(BOT_HTML);
    for (const marker of [
      'fetch("/bot/join"',
      "JSON.stringify(id != null ? { battle: id } : {})",
      "Join main lobby",
      "Join by id",
      "function joinTyped",
      // The main-lobby label comes from the configured lava lobby.
      'fetch("/admin/config", { headers: authHeaders() })',
      "config.lava_lobbies[0]",
    ]) {
      expect(script).toContain(marker);
    }
  });
});

describe("RANKING_HTML", () => {
  it("has a debounced prefix search that keeps ?q= in the URL", () => {
    const script = inlineScript(RANKING_HTML);
    for (const marker of [
      "const SEARCH_DEBOUNCE_MS = 500",
      "clearTimeout(searchTimer)",
      '"&q=" + encodeURIComponent(query)',
      'u.searchParams.set("q", query)',
      "seq !== requestSeq",
      "refresh();",
    ]) {
      expect(script).toContain(marker);
    }
    // The box and the pager sit in a static toolbar above the table; only #root re-renders.
    expect(RANKING_HTML).toContain('<input class="ctl search" id="q"');
    expect(RANKING_HTML).toContain('<button class="btn" id="prev"');
    expect(script).not.toContain('class="foot"');
  });
});

describe("GAMES_HTML", () => {
  it("makes every game row a real link (stretched <a>) on /games and the player page", () => {
    for (const html of [GAMES_HTML, PLAYER_HTML]) {
      const script = inlineScript(html);
      expect(script).toContain("'<td class=\"when\">' + rowLink(gameHref(g.id), fmtWhen(g.startTime)) + '</td>'");
      expect(script).toContain("'<a class=\"row-link\" href=\"' + esc(href) + '\">'");
      expect(html).toContain('tr.game-row a.row-link::after { content: ""; position: absolute; inset: 0; z-index: 1; }');
      expect(html).toContain("tr.game-row { cursor: pointer; position: relative; }");
    }
  });

  it("pages /api/games by number, links rows to game pages and names to player pages", () => {
    const script = inlineScript(GAMES_HTML);
    for (const marker of [
      "const DEFAULT_PER_PAGE = 20",
      '"/api/games?page="',
      "function losCell",
      "function rosterCell",
      "function unratedTitle",
      "function rebaseFrom",
      "/rebase",
      "function setIgnored",
      "/ignored",
      "function rowMenuCell",

      "otlHref(g.id)",
      "barHref(g.id)",
      // The barreplay slot: asked for server-side, then rendered from the row.
      "&replays=true",
      "function replaySlot",
      "replayHref(g.id)",
      "playerHref(p.userId)",
      'data-href="',
      "function pagerBar",
      "refresh();",
    ]) {
      expect(script).toContain(marker);
    }
  });

  it("puts both row actions in a dropdown, and only the re-run recalculates", () => {
    const script = inlineScript(GAMES_HTML);
    // One "⋯" menu per row, on the same admin-mode switch the ranking's is.
    expect(script).toContain(
      'rowMenuCell({ id: g.id, start: g.startTime, ignored: g.excluded ? "1" : "0" }, "Game actions")',
    );
    expect(script).toContain('<td class="admin-col rowacts">');
    expect(script).toContain('<th class="admin-col rowacts"></th>');
    expect(GAMES_HTML).toContain("th.admin-col, td.admin-col { display: none; }");
    // Both entries, the ignore one both ways round.
    expect(script).toContain("Re-run LOS from here");
    expect(script).toContain('ignored ? "\u21A9 Un-ignore game" : "\uD83D\uDEAB Ignore game"');
    expect(script).toContain('"/api/games/" + encodeURIComponent(id) + "/ignored"');
    expect(script).toContain("{ ignored: ignored }");
    // The toggle recalculates nothing, so the page says what is still pending
    // rather than pretending the ratings moved.
    expect(script).toContain("body.needsRebase");
    expect(script).toContain("re-run LOS from it to drop them.");
    expect(script).toContain("function noteBar()");
    // The fold runs FORWARD from one game, so a re-run started at a later game
    // leaves an earlier marker outstanding: every marker is tracked, the note
    // points at the earliest, and only the ones the fold reached are cleared.
    expect(script).toContain("const pending = new Map();");
    expect(script).toContain("function foldAtOrAfter(aStart, aId, bStart, bId)");
    expect(script).toContain("function earliestPending()");
    expect(script).toContain("if (foldAtOrAfter(p.start, pid, start, id)) pending.delete(pid);");
    // ...and the marked game is badged, separately from the unrated one.
    expect(script).toContain("function excludedBadge(g)");
    expect(script).toContain("if (g.excluded) return excludedBadge(g);");
  });

  it("asks and reports through a dialog rather than alert()/confirm()", () => {
    for (const html of [GAMES_HTML, RANKING_HTML]) {
      const script = inlineScript(html);
      expect(script).toContain("function showDialog(opts)");
      expect(script).toContain("dlg.showModal();");
      // The browser's own alert and confirm block the page on chrome that
      // cannot carry a sentence — nothing here may reach for them, in code or
      // in a comment that would read as permission to.
      expect(script).not.toMatch(/(^|[^.\w])alert\(/);
      expect(script).not.toMatch(/(^|[^.\w])confirm\(/);
      expect(html).toContain("dialog.modal::backdrop");
      // role=dialog takes its accessible name from aria-labelledby; a heading
      // inside it does not name it.
      expect(script).toContain('dlg.setAttribute("aria-labelledby", h.id);');
      // The panel is a list of plain buttons, not an ARIA menu, so it must not
      // claim aria-haspopup and the arrow-key navigation that implies.
      expect(script).not.toContain("aria-haspopup");
    }
    const games = inlineScript(GAMES_HTML);
    // The re-run's two questions are ONE dialog: the confirmation carries the
    // off-map choice as a checkbox instead of a second confirm().
    expect(games).toContain("Re-run LOS from this game?");
    expect(games).toContain("Also rate games played off Supreme Isthmus");
    expect(games).toContain("{ includeOffMap: choice.option }");
    expect(games).toContain('noticeDialog({ title: "Re-run failed"');
  });
});

describe("GAME_HTML", () => {
  it("renders both rosters with the pre-game LOS and its change", () => {
    const script = inlineScript(GAME_HTML);
    for (const marker of [
      '"/api/games/" + encodeURIComponent(GAME_ID)',
      // The facts row's Links carry the same server-resolved barreplay slot,
      // minus the table's reserved width.
      '"?replays=true"',
      "replaySlot(g, false)",
      "function teamTable",
      "p.losBefore",
      "p.losDelta",
      "g.predictedWin",
      "otlHref(g.id)",
      "function unratedTitle",
      "load();",
    ]) {
      expect(script).toContain(marker);
    }
  });
});

describe("LOBBY_HTML", () => {
  it("reaches the end of its script (the refresh loop is the last statement)", () => {
    const script = inlineScript(LOBBY_HTML);
    // Everything the detail page needs, in source order — the tail proves the template wasn't
    // truncated somewhere in the middle.
    for (const marker of [
      "function ratingClass",
      "function ratingPill",
      "function matchupBar",
      "function lobbyCard",
      "async function refresh",
      "applyAuto();",
    ]) {
      expect(script).toContain(marker);
    }
  });

  it("shows LOS, not Lavabar: no skyride links, no fetch-scores plumbing, no hidden pills", () => {
    const script = inlineScript(LOBBY_HTML);
    expect(script).not.toContain("skyride");
    expect(script).not.toContain("show_hidden_score");
    expect(script).not.toContain("requestScores");
    expect(script).not.toContain("hidden-elo");
    // The pill and the assumed-value fallback read the LOS fields.
    expect(script).toContain("p.los");
    expect(script).toContain("UNRATED_LOS");
  });

  it("shows the balancer's handicapped LOS in the pill, with a (?) hint for rookies", () => {
    const script = inlineScript(LOBBY_HTML);
    // The pill (and the sort) use the handicapped value the odds are computed from…
    expect(script).toContain("function displayedLos");
    expect(script).toContain("p.losRaw");
    // …a rookie's pill carries the (?) circle explaining the discount…
    expect(script).toContain('<span class="hint pill-hint">?<span class="hint-tip">');
    expect(script).toContain("Rookie handicap: with only ");
    // …and a never-rated player shows the assumed debutant value instead of no pill.
    expect(script).toContain("No rated lava game yet");
    // The tooltip is pinned to the viewport on hover so the team card's overflow
    // clip (rounded corners) can't cut off a bottom-row tooltip.
    expect(script).toContain('tip.style.position = "fixed"');
  });

  it("sorts each team by LOS (desc) and colours names with the assumed in-game palette", () => {
    const script = inlineScript(LOBBY_HTML);
    // Rosters render strongest-first by the displayed (handicapped) LOS
    // (unrated = the debutant value)…
    expect(script).toContain("function byLosDescLobby");
    expect(script).toContain("key(b) - key(a) || a.name.localeCompare(b.name)");
    expect(script).toContain("[a, byLosDescLobby(players)]");
    // …and, head-to-head only, row N wears BAR's Nth two-team autocolor.
    expect(script).toContain("const TEAM_COLORS");
    expect(script).toContain('"#0B3EF3"'); // first cool colour (Team 1 top)
    expect(script).toContain('"#FF1005"'); // first warm colour (Team 2 top)
    expect(script).toContain("headToHead ? TEAM_COLORS[i] : null");
  });

  it("colours past games' names the same way, by LOS before the game", () => {
    for (const html of [GAMES_HTML, PLAYER_HTML, GAME_HTML]) {
      const script = inlineScript(html);
      expect(script).toContain("function teamTint(idx, j)");
    }
    // Lists: the colour is fixed by LOS place before the highlighted player moves up.
    const list = inlineScript(GAMES_HTML);
    expect(list).toContain("const tint = new Map(sorted.map((p, j) => [p.userId, teamTint(idx, j)]));");
    expect(list).toContain("nameLink(p, idx, p.userId === highlightId, tint.get(p.userId))");
    // The game page: row j of the LOS-sorted team.
    expect(inlineScript(GAME_HTML)).toContain("team.map((p, j) => playerRow(p, i, teamTint(i, j), parties))");
  });

  it("marks who was partied together on the game page, from the stored lobby roster", () => {
    const script = inlineScript(GAME_HTML);
    expect(script).toContain('<th class="party"></th>');
    expect(script).toContain("'<td class=\"party\">' + partyPill(p, parties) + '</td>'");
    const src = script.slice(script.indexOf("function attachParties"));
    const fn = src.slice(0, src.indexOf("\n}\n") + 2);
    const attachParties = new Function("byLosDesc", fn + "return attachParties;")((t: unknown[]) => t);
    const g = {
      teams: [
        [{ name: "Alice" }, { name: "Bob" }, { name: "Carl" }],
        [{ name: "dave" }, { name: "Eve" }],
      ],
      lobby: { lobbyDetails: { players: [
        { name: "alice", party: "#cc0000" }, { name: "Dave", party: "#cc0000" },
        { name: "Bob", party: "#00aa00" }, { name: "Eve", party: "#00aa00" },
        { name: "Carl", party: "#0000ff" }, // a lone member: no pill
      ] } },
    };
    const parties = attachParties(g);
    expect([...parties.entries()]).toEqual([["#cc0000", 1], ["#00aa00", 2]]);
    expect(g.teams.flat().map((p) => (p as { party?: string | null }).party))
      .toEqual(["#cc0000", "#00aa00", "#0000ff", "#cc0000", "#00aa00"]);
    // No lobby info: no parties, nothing thrown.
    expect(attachParties({ teams: [[{ name: "A" }], []], lobby: null }).size).toBe(0);
  });

  it("shows each player's rated lava game count", () => {
    const script = inlineScript(LOBBY_HTML);
    expect(script).toContain('<th class="games" title="rated lava games played">Games</th>');
    expect(script).toContain("p.losGames != null ? esc(p.losGames)");
  });

  it("prints the server's win probability rather than recomputing odds locally", () => {
    const script = inlineScript(LOBBY_HTML);
    // teamAvg carries the server stat's winProb through to the matchup strip…
    expect(script).toContain("winProb: stat.winProb != null ? stat.winProb : null");
    // …and no client-side Elo/OpenSkill formula exists to disagree with it.
    expect(script).not.toContain("function winProb");
    expect(script).not.toContain("eloSwing");
  });

  it("offers the game-start / live roster toggle while an upload exists", () => {
    const script = inlineScript(LOBBY_HTML);
    // The toggle renders only off the response's botRoster metadata…
    expect(script).toContain("function rosterToggle");
    expect(script).toContain("l.botRoster");
    expect(script).toContain("📌 at game start");
    expect(script).toContain("🛋️ live lobby");
    // …the active segment marks what the body carries (server-decided)…
    expect(script).toContain("l.rosterSource === view");
    // …and switching views is a refetch with ?roster=live (never a client-side
    // re-shuffle — the team stats must stay server-computed for both views).
    expect(script).toContain('let rosterView = "bot"');
    expect(script).toContain('"roster=live"');
    // A vanished upload (game over) resets the choice for the next game.
    expect(script).toContain('if (lobby && !lobby.botRoster) rosterView = "bot"');
  });
});

describe("RANKING_HTML", () => {
  it("reaches the end of its script and drives the paged leaderboard", () => {
    const script = inlineScript(RANKING_HTML);
    for (const marker of [
      "/api/ranking?page=",
      "function rankRow",
      "playerHref",
      "function pagerBar",
      "refresh();",
    ]) {
      expect(script).toContain(marker);
    }
    // Rows link to the player page by BAR userId.
    expect(script).toContain('"/player/" + encodeURIComponent(userId)');
  });
});

describe("PLAYER_HTML", () => {
  it("reaches the end of its script (profile, chart, recent games)", () => {
    const script = inlineScript(PLAYER_HTML);
    for (const marker of [
      "function profileCard",
      "function drawChart",
      "function wireChartHover",
      "function gameRow",
      "/api/players/",
      "/history",
      // The games table's Links column carries the same server-resolved
      // barreplay slot as the /games table.
      "&replays=true",
      "replayCell(g)",
      "load();",
    ]) {
      expect(script).toContain(marker);
    }
  });

  it("lists every rated player — no min-games filter", () => {
    expect(inlineScript(RANKING_HTML)).not.toContain("minGames");
    expect(inlineScript(PLAYER_HTML)).not.toContain("minGames");
  });
});

describe("PLAYER_HTML chart", () => {
  it("has a time/games X-axis toggle under the axis and drag-to-zoom on X", () => {
    const script = inlineScript(PLAYER_HTML);
    expect(script).toContain('<button type="button" data-mode="time">Time</button>');
    expect(script).toContain('<button type="button" data-mode="games">Games</button>');
    expect(script).toContain('localStorage.getItem("chartAxis")');
    // Games mode: x = 1-based ordinal, equidistant; time mode: the timestamp.
    expect(script).toContain('return chartMode === "games" ? i + 1 : chartTimes[i];');
    expect(script).toContain('if (chartMode === "games") return [1, n];');
    // Zoom is a drag on the canvas (X only), reset by double-click or the control.
    expect(script).toContain('canvas.addEventListener("mousedown"');
    expect(script).toContain('window.addEventListener("mouseup"');
    expect(script).toContain('canvas.addEventListener("dblclick", () => setChartZoom(null));');
    expect(script).toContain('id="chartReset"');
    expect(PLAYER_HTML).toContain(".chart-axis .seg button.on");
    // Ticks: as many as fit, calendar-aligned in time mode, whole ordinals in games mode.
    expect(script).toContain("function chartTicks(sc) {");
    expect(script).toContain("const want = Math.max(2, Math.floor(sc.W / 70));");
    expect(script).toContain('{ ms: 7 * DAY, unit: "week" }');
  });
});

describe("LOBBY_HTML player links", () => {
  it("links a rated player's name to their player page", () => {
    const script = inlineScript(LOBBY_HTML);
    expect(script).toContain("p.losUserId != null");
    expect(script).toContain("encodeURIComponent(p.losUserId)");
  });
});

describe("LOBBY_HTML balance algorithm", () => {
  it("names the balance algorithm as Teiserver's, apart from SPADS autoBalance", () => {
    // A bare "⚖️ Balance algorithm: auto" reads as SPADS's autoBalance being on.
    // It is a different setting — Teiserver's own consul one — and the SPADS one
    // is what decides whether the bot may set teams, so the label says which.
    const script = inlineScript(LOBBY_HTML);
    expect(script).toContain("⚖️ Teiserver balance algorithm");
    expect(script).toContain("NOT the SPADS autoBalance");
  });
});

describe("private profiles in the UI", () => {
  it("withholds a private player's LOS on the lobby page, keeping the team numbers", () => {
    const script = inlineScript(LOBBY_HTML);
    // The same "– (?)" the game page's roster shows, and told apart from the
    // assumed-debutant pill an unrated player gets — the two look nothing alike
    // to a reader and must not render the same.
    expect(script).toContain("if (p.losPrivate) return null;");
    expect(script).toContain("'<span class=\"pill none\">–</span>'");
    expect(script).toContain("profile is private, so their LOS is not shown");
    // Withheld sorts last: ordering by the hidden number would put it back on
    // screen as a position.
    expect(script).toContain("v == null ? -Infinity : v");
    // The admin view asks for the unblanked ratings.
    expect(script).toContain('const LOBBY_URL = withAdmin("/api/lobbies/"');
  });


  it("adds an admin-only per-row action menu to the ranking, with the private toggle", () => {
    const script = inlineScript(RANKING_HTML);
    // The column and its "⋯" button ride the same client-side switch as the SQL
    // sidebar entry and the games table's own row menu: hidden without ?admin=true.
    expect(script).toContain('<td class="admin-col rowacts">');
    expect(script).toContain('<th class="admin-col rowacts"></th>');
    expect(script).toContain('class="rowmenu-btn"');
    expect(RANKING_HTML).toContain("th.admin-col, td.admin-col { display: none; }");
    expect(RANKING_HTML).toContain(
      "body.admin-mode th.admin-col, body.admin-mode td.admin-col { display: table-cell; }",
    );
    // The menu's one action, both ways round, and the POST behind it. The
    // actions are the page's (rowMenuActions); the menu itself is shared.
    expect(script).toContain("rowMenuActions = (btn) =>");
    expect(script).toContain('isPrivate ? "\u{1F513} Make public" : "\u{1F512} Make private"');
    expect(script).toContain('"/api/players/" + encodeURIComponent(userId) + "/private"');
    expect(script).toContain("{ private: isPrivate }");
    // One menu at a time; click-away and Escape close it.
    expect(script).toContain("function closeRowMenu()");
    expect(script).toContain('if (e.key === "Escape") closeRowMenu();');
    // Private rows are badged, and both the rank and the LOS cell survive a null
    // (the public list serves them rankless and rating-less in its tail).
    expect(script).toContain('class="privbadge"');
    expect(script).toContain("p.rank == null ? '<span class=\"muted\">–</span>' : String(p.rank)");
    expect(script).toContain("return (p.los == null");
    expect(script).toContain("'<span class=\"pill none\">–</span>'"); // keeps the column aligned
    expect(script).toContain("const unranked = ADMIN_MODE ? p.rank == null : !!(p.privateProfile || p.inactive);");
    expect(script).toContain("'<tr' + (unranked ? ' class=\"unranked\"' : '') + '>'");
    expect(RANKING_HTML).toContain("tr.unranked td { background: #14171d; }");
  });

  it("puts each movement in a column against the one it moved", () => {
    const script = inlineScript(RANKING_HTML);
    // ONE table. Each Δ sits directly against the column it is a movement of —
    // the rank's after #, the rating's after LOS — which is what lets both wear
    // the same label: one is a whole number of places, the other a rating to one
    // decimal, and each is read next to the thing it moved.
    const cols = script.slice(script.indexOf("function tableColumns()"));
    const labels = (src: string) => [...src.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    const visitor = cols.slice(cols.indexOf("if (!ADMIN_MODE)"), cols.indexOf("].concat(statColumns());"));
    const admin = cols.slice(cols.indexOf("].concat(statColumns());") + 1);
    const stats = script.slice(script.indexOf("function statColumns()"));
    // A visitor: the tier board, no movement columns (both are the LOS order).
    expect(labels(visitor)).toEqual(["#", "Player", "Rank"]);
    expect(labels(admin.slice(0, admin.indexOf("].concat(statColumns());")))).toEqual([
      "#", "\u0394 (7d)", "Player", "Rank", "LOS", "\u0394 (7d)",
    ]);
    expect(labels(stats.slice(0, stats.indexOf("];")))).toEqual(["Games", "W–L", "Win%", "Last game"]);
    // Same label, different tooltip — that is what tells them apart in a screen
    // reader, where the rendering cannot.
    expect(cols).toContain('title: "Positions gained or lost" + over');
    expect(cols).toContain('title: "LOS gained or lost" + over');
    // Inside the # cell the mark could not work: that cell is right-aligned, so
    // a mark trailing the number decided where the NUMBER landed and the ranks
    // stopped lining up. A column aligns by construction — and only a column
    // can carry a header to sort by.
    expect(script).toContain("function moveMark(p) {");
    expect(RANKING_HTML).toContain("td.chgcol, th.chgcol {");
    // Header and cells come from ONE list, so a column cannot be in the header
    // and not the body — and every cell carries its column's class, which is
    // what lets a single rule hide both halves on a narrow card.
    expect(script).toContain("function rankRow(p, columns) {");
    expect(script).toContain("'<td class=\"col-' + col.key");
    // No tabs left to switch between, and nothing that switched them.
    for (const gone of ["viewSpec", "TAB_SORTS", "applyTab", "lastData", "rankedOnly"]) {
      expect(script, gone).not.toContain(gone);
    }
    expect(RANKING_HTML).not.toContain('data-tab=');
  });

  it("tells a movement from no movement from nothing to compare with", () => {
    const script = inlineScript(RANKING_HTML);
    // Up is green, down is red — and the arrow carries the size.
    expect(script).toContain('\'<span class="chg \' + (up ? "up" : "down")');
    expect(script).toContain('(up ? "\u25B2" : "\u25BC")');
    expect(RANKING_HTML).toContain(".chg.up { color: #5cc274; }");
    expect(RANKING_HTML).toContain(".chg.down { color: #e06c6c; }");
    // A null is "no baseline", a zero is "unchanged": both draw a dash, and the
    // tooltip is what says which.
    expect(script).toContain("if (v == null) {");
    expect(script).toContain("' days ago to compare against\">–</span>'");
    expect(script).toContain("' unchanged over the last ' +");
    // A change too small to print must not read as a rise nobody made.
    expect(script).toContain("if (Number(size) === 0) {");
    // The window comes from the API alongside inactiveDays, so the wording and
    // the SQL cannot disagree about how many days it is.
    expect(script).toContain("if (data.changeDays) CHANGE_DAYS = data.changeDays;");
  });

  it("pins the ranking's column widths so a sort cannot re-lay the table", () => {
    const script = inlineScript(RANKING_HTML);
    // Under automatic layout every column is as wide as the widest thing in it,
    // so the table re-laid itself on every sort and every page — rank 1 against
    // rank 9575, "–" against "▲ 117". Reading a list is following a column down.
    expect(RANKING_HTML).toContain(".ranking .games-table table { table-layout: fixed; }");
    // Only the HEADER row's cells decide a width under fixed layout, which is
    // what the per-column class is for.
    expect(script).toContain('const cls = "col-" + col.key + " "');
    // Every column but the player is a known quantity and gets the room its
    // widest real value needs; the name is the only variable one and takes the
    // remainder, so it is the only one without a width here.
    for (const key of ["rank", "rankchg", "los", "loschg", "games", "wl", "win", "last"]) {
      expect(RANKING_HTML, key).toContain(".ranking th.col-" + key);
    }
    expect(RANKING_HTML).not.toContain(".ranking th.col-player {");
    // A name too long for that remainder can no longer widen the table, so it
    // is ellipsed rather than left to overlap the rating beside it.
    // The truncation is aimed at the NAME (the cell is a flex row) rather than
    // at whatever is last, which was cutting the "inactive" badge in half.
    expect(RANKING_HTML).toContain(".ranking td.name { display: flex;");
    expect(RANKING_HTML).toContain("min-width: 0; overflow: hidden; text-overflow: ellipsis;");
    expect(script).toContain("'<a class=\"plink\" title=\"'");
  });

  it("narrows by dropping the record columns, never the player's name", () => {
    // The name is what every other cell is ABOUT, and it is also the column
    // taking the remainder — so a shortage takes from it first. These are what
    // stop it reaching zero: the type tightens, then the record columns leave
    // one at a time, least useful first.
    expect(RANKING_HTML).toContain(".card.ranking { container: ranking / inline-size; }");
    expect(RANKING_HTML).toContain("@container ranking (max-width: 736px)");
    for (const [width, col] of [[656, "last"], [564, "win"], [514, "wl"], [438, "games"]] as const) {
      expect(RANKING_HTML, col).toContain(
        "@container ranking (max-width: " + width + "px) { .ranking .col-" + col,
      );
    }
    // Whatever else goes, these stay: who, where, and both movements.
    for (const kept of ["col-rank", "col-rankchg", "col-player", "col-los", "col-loschg"]) {
      expect(RANKING_HTML, kept).not.toContain("{ .ranking ." + kept + "  { display: none; } }");
    }
    // Keyed on the CARD, not the viewport: the sidebar is 180px until it becomes
    // a top bar, so one viewport figure means two different card widths.
    expect(RANKING_HTML).not.toContain("@media (max-width: 736px)");
  });

  it("makes every column of the ranking sortable, both ways, server-side", () => {
    const script = inlineScript(RANKING_HTML);
    expect(script).toContain(
      'const SORTS = ADMIN_MODE ? ["rank", "rankChange", "los", "losChange", "tier"] : ["tier"];',
    );
    // A first click gives the direction that puts what the column is for on
    // top; clicking the sorted column reverses it.
    expect(script).toContain('{ rank: "asc", los: "desc", rankChange: "desc", losChange: "desc", tier: "desc" }');
    expect(script).toContain('const DEFAULT_SORT = ADMIN_MODE ? "rank" : "tier";');
    expect(script).toContain('if (key === sort) dir = dir === "asc" ? "desc" : "asc";');
    // The order is the SERVER's — sorting the page in hand would only order the
    // rows already fetched — so a click is a refetch, and from page 1.
    expect(script).toContain('"&sort=" + sort + "&dir=" + dir +');
    expect(script).toContain("page = 1;\n  refresh();");
    // A header is a real control, not a <th> that reacts to a pointer.
    expect(script).toContain('role="button" tabindex="0"');
    expect(script).toContain('aria-sort="');
    expect(script).toContain('if (e.key !== "Enter" && e.key !== " ") return;');
    expect(RANKING_HTML).toContain("thead th.sortable { cursor: pointer; user-select: none; }");
    // The arrow must not inherit its column's font: th.num is monospace, so the
    // # header drew a narrow monospace glyph while every other header drew the
    // UI font's — same declared size, visibly different arrow.
    expect(RANKING_HTML).toContain(
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;\n  }',
    );
    // The server normalizes an unknown key, so the header marks what the rows
    // are REALLY in, not what was asked for.
    expect(script).toContain("if (data.sort) sort = data.sort;");
    // Non-default orders live in the URL; the leaderboard's own is what a bare
    // /ranking already means.
    expect(script).toContain('u.searchParams.delete("sort");');
    expect(script).toContain('u.searchParams.set("sort", sort);');
  });

  it("keeps the history rebuild admin-only now that no tab gates it", () => {
    const script = inlineScript(RANKING_HTML);
    // It edits rows every visitor reads, so it rides the same client-side
    // switch as the admin sidebar entries rather than being on the page for
    // everyone.
    expect(RANKING_HTML).toContain('<button class="btn admin-only" id="rebuild"');
    expect(RANKING_HTML).toContain(".btn.admin-only { display: none; }");
    expect(RANKING_HTML).toContain("body.admin-mode .btn.admin-only { display: inline-block; }");
    expect(script).toContain('fetch("/api/rank-history/rebuild", { method: "POST" })');
    // Every row's change was rewritten, so the list is re-read rather than patched.
    expect(script).toContain("await refresh();");
  });

  it("asks for the hidden profiles only in admin mode", () => {
    // withAdmin appends ?includePrivate=true exactly in admin mode,
    // so a normal visitor's reads are the filtered ones.
    for (const html of [RANKING_HTML, PLAYER_HTML]) {
      const script = inlineScript(html);
      expect(script).toContain("function withAdmin(url) {");
      expect(script).toContain('return url + (url.indexOf("?") >= 0 ? "&" : "?") + "includePrivate=true";');
      expect(script).toContain("if (!ADMIN_MODE) return url;");
    }
    expect(inlineScript(RANKING_HTML)).toContain('const url = withAdmin("/api/ranking?page="');
    const player = inlineScript(PLAYER_HTML);
    expect(player).toContain('fetch(withAdmin("/api/players/" + USER_ID)');
    expect(player).toContain('fetch(withAdmin("/api/players/" + USER_ID + "/history")');
    expect(player).toContain('fetch(withAdmin("/api/players/" + USER_ID + "/games?page="');
    // Admin mode rides the Access cookie, so links between pages carry nothing.
    expect(player).not.toContain("function adminHref(href) {");
    expect(player).toContain('return "/player/" + encodeURIComponent(userId);');
  });

  it("marks a hidden player's withheld rating on the game page with a (?), keeping Δ LOS", () => {
    const script = inlineScript(GAME_HTML);
    expect(script).toContain("function privateDash() {");
    expect(script).toContain("This player\u2019s profile is private");
    // The LOS-before cell becomes the marked dash; the "→ LOS after" is dropped.
    expect(script).toContain("const before = p.privateProfile\n    ? privateDash()");
    // The "→ after" slot is always rendered (empty here) and has a fixed width:
    // td.delta is right-aligned, so an absent suffix would slide the delta to the
    // cell edge and a shorter one would shift it.
    expect(script).toContain("p.privateProfile || p.losAfter == null");
    expect(script).toContain("'></span>'");
    expect(GAME_HTML).toContain("min-width: 3.7em");
    // Δ LOS is untouched — it says nothing about the rating it moved.
    expect(script).toContain("'<td class=\"delta\">' + deltaTxt(p.losDelta) + after + '</td>'");
    // The dash rides in a pill BOX (same width, no colour) so the rating column
    // stays aligned, and the (?) is the usual pill-hint, out of the flow.
    expect(script).toContain("'<span class=\"pill none\">–</span>'");
    expect(script).toContain('<span class="hint pill-hint">?');
    expect(GAME_HTML).toContain(".pill.none");
    expect(GAME_HTML).toContain("td.rating .pill { min-width: 4em; }");
    // The admin view asks for the unblanked roster.
    expect(script).toContain('fetch(withAdmin("/api/games/" + encodeURIComponent(GAME_ID)');
  });

  it("takes team averages from the API so a blanked roster cannot shift them", () => {
    // Averaging what is visible would silently drop a hidden player, and the
    // gap between that mean and the full one would give their rating away.
    for (const html of [GAME_HTML, GAMES_HTML]) {
      const script = inlineScript(html);
      expect(script).toContain("function teamAvgLos(g, i) {");
      expect(script).toContain("const served = g.avgLosBefore;");
      expect(script).not.toContain("function teamLosBefore(");
    }
    expect(inlineScript(GAME_HTML)).toContain("const a = teamAvgLos(g, 0), b = teamAvgLos(g, 1);");
    expect(inlineScript(GAMES_HTML)).toContain("const v = teamAvgLos(g, i);");
  });

  it("badges a lapsed player and leaves everything but their rank alone", () => {
    const rank = inlineScript(RANKING_HTML);
    // The two reasons a row is unranked are told apart, and only one of them
    // takes the rating away.
    expect(rank).toContain('class="idlebadge"');
    expect(rank).toContain("p.privateProfile\n    ? '<span class=\"privbadge\"");
    expect(rank).toContain(": p.inactive");
    // The rule's number comes from the API, so the page keeps no copy of it.
    expect(rank).toContain("if (data.inactiveDays) INACTIVE_DAYS = data.inactiveDays;");
    // Gray, not the orange "private" warning: nothing is being withheld.
    expect(RANKING_HTML).toContain(".idlebadge { background: #21252c;");
    // The player page says why the rank is a dash on an otherwise public profile.
    const player = inlineScript(PLAYER_HTML);
    expect(player).toContain("p.inactive");
    expect(player).toContain("days — not ranked until they play again");
    expect(player).toContain("Not ranked: no rated game in the last ");
  });

  it("shows a private notice instead of the profile card and chart, and drops the LOS columns", () => {
    const script = inlineScript(PLAYER_HTML);
    expect(script).toContain("if (p.privateProfile && p.los == null) { renderPrivate(p); return; }");
    expect(script).toContain("function renderPrivate(p) {");
    expect(script).toContain("\u2019s profile is private.");
    expect(script).toContain("Their games are listed below.");
    // renderPrivate draws no canvas: the chart and its wiring are skipped.
    expect(script).toContain("privateNote(p) +\n    '<div class=\"card wide\" id=\"gamesCard\">");
    // The games table keeps its rows but loses "LOS before" and "Δ LOS".
    expect(script).toContain("hideLos = data.privateProfile === true;");
    expect(script).toContain("const losCells = hideLos ? ''");
    expect(script).toContain("const losHeaders = hideLos ? ''");
    expect(script).toContain("const cols = hideLos ? 6 : ADMIN_MODE ? 8 : 7;");
    expect(PLAYER_HTML).toContain(".private-note");
  });
});

describe("LOGIN_HTML", () => {
  it("is reached from the header's top-right corner on every page, which turns into Log out", () => {
    // No sidebar entry any more: SHARED_JS's authBox fills the header instead.
    expect(RANKING_HTML).not.toContain('class="nav" href="/login"');
    const script = inlineScript(RANKING_HTML);
    expect(script).toContain("function renderAuthBox() {");
    // From localStorage, synchronously: no /api/auth/me request on every page.
    expect(script).toContain('localStorage.getItem(AUTH_USER_KEY)');
    expect(script).not.toContain('fetch("/api/auth/me"');
    expect(script).toContain('<a class="authbtn" href="/login">');
    expect(script).toContain('<button type="button" class="authbtn">Log out</button>');
    expect(script).toContain('fetch("/api/auth/logout", { method: "POST" })');
    expect(RANKING_HTML).toContain("header.top .authbox {");
    // The login page keeps it right: it remembers the user on login and on
    // finding them logged in, and forgets them on logout.
    const login = inlineScript(LOGIN_HTML);
    expect(login).toContain("rememberAuthUser(res.body.user);");
    expect(login).toContain("rememberAuthUser(me.body.user || null);");
    expect(login).toContain("rememberAuthUser(null);");
  });

  it("explains the whisper steps and names the bot from /api/auth/me", () => {
    const script = inlineScript(LOGIN_HTML);
    expect(script).toContain('getJson("/api/auth/me")');
    expect(script).toContain("Send a private message <code>login</code>");
    expect(script).toContain("showSteps(me.body.bot)");
  });

  it("never uses the link on page load: only the Continue button POSTs it", () => {
    const script = inlineScript(LOGIN_HTML);
    // The page only PEEKS at the link (GET) until the button is pressed.
    expect(script).toContain('getJson("/api/auth/link?t=" + encodeURIComponent(token))');
    expect(script).toMatch(/addEventListener\("click"[\s\S]*\/api\/auth\/redeem/);
    // ...and drops the token from the address bar straight away.
    expect(script).toContain('clean.searchParams.delete("t")');
    expect(LOGIN_HTML).toContain('<meta name="referrer" content="no-referrer" />');
  });

  it("shows the dev-only fake login only when the server says it is on", () => {
    const script = inlineScript(LOGIN_HTML);
    expect(script).toContain("devLogin = !!(me.ok && me.body.devLogin)");
    expect(script).toContain("if (devLogin) addDevSection()");
    expect(script).toContain('getJson("/api/auth/dev-login"');
  });
});

describe("POLLS_HTML", () => {
  it("has a Polls menu entry right above Does it work?, active on its own page", () => {
    const nav = POLLS_HTML.slice(POLLS_HTML.indexOf('<nav class="side">'), POLLS_HTML.indexOf("</nav>"));
    expect(nav).toMatch(/class="nav active" href="\/polls">🗳️ Polls<\/a>\s*<a class="nav" href="\/does-it-work">/);
    expect(LOGIN_HTML).toContain('href="/polls">🗳️ Polls</a>');
  });

  it("votes through the API, sends a visitor to /login and casts the saved pick on return", () => {
    expect(POLLS_HTML).toContain('"/api/polls/" + encodeURIComponent(state.poll.slug) + "/vote"');
    expect(POLLS_HTML).toContain('setLoginReturn(location.pathname, "the poll")');
    expect(POLLS_HTML).toContain("takePending(state.poll.slug)");
    expect(POLLS_HTML).toContain('id="voteBtn"');
    expect(POLLS_HTML).toContain('id="resultsBtn"');
  });

  it("the login page goes back where it was sent from", () => {
    expect(LOGIN_HTML).toContain("function goBack()");
    expect(LOGIN_HTML).toContain("takeLoginReturn()");
  });
});

describe("POLLS_HTML / LOGIN_HTML scripts", () => {
  it("parse", () => {
    for (const html of [POLLS_HTML, LOGIN_HTML]) {
      const js = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
      expect(() => new Function(js)).not.toThrow();
    }
  });
});
