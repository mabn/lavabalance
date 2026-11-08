// The pages served by the Worker. Self-contained HTML documents (no build step,
// no framework), kept as string constants so the Worker can serve them inline.
// Every page shares one shell: a LEFT SIDEBAR menu (Lobby / Ranking / Games) beside the
// page's own header + content:
//
//   • LOBBIES_HTML — GET / when no lobby is open to redirect to. A compact,
//     clickable LIST of the lava lobbies (or a note when there are none, with a
//     "Select a lobby" button to the picker); each row links to /lobby/:id.
//     GET / itself redirects to the FIRST open lobby (see index.ts), so the
//     menu's "Lobby" lands you in a lobby.
//   • ALL_LOBBIES_HTML — GET /lobbies. The lobby PICKER: every open lobby on
//     Teiserver with at least one player (GET /api/lobbies/all) as a table —
//     name, id, map, status, players, spectators — most players first; a row
//     opens /lobby/:id — and viewing a lava lobby there adopts it as the configured
//     one while the current one is empty or gone (a side effect of GET
//     /api/lobbies/:id). Reached from the list page's empty state ("Select a
//     lobby") and the orange "View all lobbies" header button on the lobby pages.
//   • LOBBY_HTML — GET /lobby/:id. The dense per-team roster view (two teams side
//     by side) for the single lobby named in the URL path. The rating column is
//     LOS (server-resolved by /api/lobbies/:id, with teamStats/winProb); player
//     names link to /player/:userId when LOS knows the player.
//   • RANKING_HTML — GET /ranking. The paged LOS leaderboard (GET /api/ranking),
//     a debounced name-prefix search box (?q=, ranks stay global), each row
//     linking to the player's page. The ranked players come first, then a
//     RANKLESS TAIL (most recently seen first) of everyone the leaderboard
//     leaves out: private profiles, badged and with no rating, and inactive ones
//     (35 days without a game), badged but otherwise untouched. ADMIN MODE gets
//     the true list (everyone in their real place, rating and all) plus a
//     per-row "⋯" actions menu (Make private / Make public →
//     POST /api/players/:id/private).
//   • PLAYER_HTML — GET /player/:userId. One player: profile card, the LOS-over-
//     time chart (GET /api/players/:id/history, canvas; X axis switchable between
//     time and game ordinal, drag a range to zoom X, double-click to reset), and their last 20 games
//     and every game they played, paged 10 at a time (dropdown) in the /games table layout
//     (GET /api/players/:id/games?page=), rows linking to the game page. A
//     PRIVATE profile shows a notice in place of the card and the chart, and its
//     games table drops the LOS columns (admin mode shows the whole thing).
//   • GAMES_HTML — GET /games. The paged games table (GET /api/games?page=),
//     newest first, 20 per page (dropdown: 10/20/50/100) with the pager above
//     the table: start time,
//     duration, the two teams' pre-game average LOS (team colours, the winner ringed in gold),
//     the rosters (names link to player pages) and OTL/BAR links. Rows open
//     the game page.
//   • GAME_HTML — GET /game/:id. One game (GET /api/games/:id): a matchup strip
//     (team averages, predicted win chance, who won), the facts (when, how long,
//     map, an "unrated" note if ignored, OTL + BAR links) and the two rosters side
//     by side with every player's LOS before the game, the change it caused, and
//     their rated-games count. A PRIVATE profile's row shows "– (?)" instead of
//     the LOS-before pill and drops the "→ LOS after"; the Δ LOS stays. Team
//     averages come from the API, never from averaging a blanked roster.
//     Under the rosters, for a game barreplay has published, barreplay's own
//     game summary (imported at view time from barreplay's deployment).
//   • POLLS_HTML — GET /polls, /polls/:slug. One poll (src/polls.ts): question,
//     a column per option with its picture, single choice, a prominent Vote
//     button (logged-out voters go to /login and come back to a cast vote) and
//     View results (overall bars + the split by rank tier; admins see voters).
//   • SQL_HTML — GET /sql. ADMIN-ONLY (admin mode): what each method of the two
//     SQLite-backed Durable Objects (RatingsDO, LosDO) has cost in SQLite rows
//     since its instance started (GET /api/sqlstats, in-memory tally — see
//     src/sqlStats.ts), one table per DO with per-call averages and each
//     method's spend projected onto the free plan's daily row budgets. The
//     sidebar entry is hidden outside admin mode, the page shows nothing but a
//     note there, and the route itself is admin-only.
//   • BOT_HTML — GET /bot. ADMIN-ONLY (admin mode), same gate as the
//     SQL page: a prominent banner saying which lobby the bot is in (linked, with
//     the lobby's title from the public detail endpoint; "not in any lobby" when
//     idle), the container's status (persisted intent, the platform's instance
//     state, the bot process's own /health answer, last stop / last error),
//     Start / Stop buttons, and join controls — "Join main lobby" (the configured
//     lava lobby, labeled from GET /admin/config) and join-by-id, both POSTing
//     /bot/join. The page talks to the token-authed control plane (GET
//     /bot/status, POST /bot/start|stop|join, GET /admin/config), which accepts
//     the Access cookie; the control-token field (kept in localStorage) is the
//     alternative for when CONTROL_TOKEN is set.
//
// ADMIN MODE is a superadmin signed in with Cloudflare Access (src/access.ts,
// the same scheme as barreplay's): the Worker verifies the CF_Authorization
// cookie when it serves a page and, for an admin, flips the ADMIN_MODE marker
// in SHARED_JS (src/index.ts page()). SHARED_JS then puts `admin-mode` on
// <body>, which reveals the admin-only sidebar entries, columns and buttons,
// and flips the LOS reads to their admin view (withAdmin →
// ?includePrivate=true), which the API grants only to a verified admin. The
// sign-in is the muted "admin login" link in the corner of /login.
//
// The lobby pages poll their /api/lobbies endpoints and propagate an optional
// ?src= param; the sidebar's Lobby link carries the same ?src= through.


// Shared <style> block. Covers all pages; rules a page doesn't use are harmless.
const STYLES = /* css */ `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #0e1014;
    color: #c7ccd1;
    font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  /* ---- App shell: left sidebar menu + the page's own header/content ---- */
  .shell { display: flex; min-height: 100vh; }
  nav.side {
    flex: 0 0 180px; width: 180px;
    position: sticky; top: 0; align-self: flex-start; height: 100vh;
    display: flex; flex-direction: column; gap: 4px;
    padding: 14px 10px; background: #12151b; border-right: 1px solid #262b33;
  }
  nav.side .brand {
    padding: 4px 10px 14px; font-size: 16px; font-weight: 700;
    color: #e6e9ec; text-decoration: none; white-space: nowrap;
  }
  nav.side .brand:hover { color: #fff; }
  nav.side a.nav {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border-radius: 6px;
    color: #9aa3ad; text-decoration: none; font-size: 13px; font-weight: 600;
    white-space: nowrap;
  }
  nav.side a.nav:hover { background: #1a1f27; color: #c7ccd1; }
  nav.side a.nav.active { background: #1d2735; color: #e6e9ec; }
  /* Admin-only menu entries (the SQL page): hidden outside admin mode (SHARED_JS). */
  nav.side a.nav.admin { display: none; }
  body.admin-mode nav.side a.nav.admin { display: flex; }
  /* The superadmin entry at the bottom of the menu (SHARED_JS adminEntry):
     only ever added for the site owner's BAR account, or in admin mode. */
  nav.side a.nav.adminentry { margin-top: auto; font-weight: 500; font-size: 12px; color: #7a828c; }
  /* Admin-only table column (the games and ranking tables' row menus): same switch. */
  th.admin-col, td.admin-col { display: none; }
  body.admin-mode th.admin-col, body.admin-mode td.admin-col { display: table-cell; }

  /* ---- Admin row menu (the ranking's player actions and the games table's
     game actions, both in the admin-col) ---- */
  /* A "⋯" button that drops a small action list under it. The panel hangs off
     <body> with position:fixed at the button's on-screen spot (openRowMenu):
     the cards the tables sit in are overflow:hidden, and a panel inside the
     cell was clipped away under the LAST row of a page — the oldest game on
     the games table's last page never showed its menu at all. */
  td.admin-col.rowacts { text-align: right; width: 1%; }
  th.admin-col.rowacts { width: 1%; }
  button.rowmenu-btn {
    cursor: pointer; font: inherit; font-size: 13px; line-height: 1;
    padding: 3px 8px; border-radius: 5px;
    border: 1px solid #2c323b; background: #22272f; color: #9aa3ad;
  }
  button.rowmenu-btn:hover { border-color: #3a414c; color: #e6e9ec; }
  .rowmenu {
    position: fixed; z-index: 20;
    min-width: 150px; padding: 4px;
    background: #1a1f27; border: 1px solid #333a45; border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, .5);
    display: flex; flex-direction: column; gap: 2px;
  }
  .rowmenu button {
    cursor: pointer; font: inherit; font-size: 12px; text-align: left;
    padding: 6px 10px; border-radius: 4px; border: 0;
    background: transparent; color: #c7ccd1; white-space: nowrap;
  }
  .rowmenu button:hover { background: #263041; color: #fff; }
  .rowmenu button:disabled { opacity: .5; cursor: default; }

  /* ---- Modal dialog (what the admin actions ask and report with — showDialog,
     in place of the browser's own alert and confirm). */
  dialog.modal {
    width: min(430px, calc(100vw - 32px));
    padding: 16px 18px 14px;
    border: 1px solid #333a45; border-radius: 10px;
    background: #171b22; color: #c7ccd1;
    font: inherit;
    box-shadow: 0 18px 50px rgba(0, 0, 0, .6);
  }
  dialog.modal::backdrop { background: rgba(8, 10, 13, .66); }
  dialog.modal h3 { margin: 0 0 8px; font-size: 14px; color: #e6e9ec; }
  dialog.modal.err h3 { color: #e08080; }
  /* pre-line: a message may carry its own line breaks (the re-run's summary). */
  dialog.modal p { margin: 0 0 12px; color: #9aa3ad; white-space: pre-line; }
  dialog.modal .opt { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 12px; cursor: pointer; }
  dialog.modal .opt input { margin: 1px 0 0; accent-color: #4a78b8; }
  dialog.modal .opt .t { font-size: 12px; color: #c7ccd1; }
  dialog.modal .opt .t .sub { display: block; margin-top: 2px; color: #79818c; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .modal-actions button {
    cursor: pointer; font: inherit; font-size: 12px; font-weight: 600;
    padding: 6px 12px; border-radius: 6px;
    border: 1px solid #2c323b; background: #22272f; color: #c7ccd1;
  }
  .modal-actions button:hover { border-color: #3a414c; color: #fff; }
  .modal-actions button.primary { background: #26436b; border-color: #34567f; color: #eaf1fb; }
  .modal-actions button.primary:hover { background: #2d4f7c; }
  .modal-actions button.danger { background: #3a1f23; border-color: #6b3036; color: #f0a0a0; }
  .modal-actions button.danger:hover { background: #4a262b; color: #fff; }

  /* The line the games page leaves above its table after a row action whose
     effect is not yet visible in the ratings (see the ignore marker). */
  .rownote {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    margin: 0 0 10px; padding: 8px 12px;
    border: 1px solid #4a3a1c; border-radius: 6px;
    background: #241f16; color: #d9b877; font-size: 12px;
  }
  .rownote .spacer { flex: 1; }
  .rownote button {
    cursor: pointer; font: inherit; font-size: 12px; font-weight: 600;
    padding: 4px 10px; border-radius: 5px;
    border: 1px solid #5d4620; background: #2e2617; color: #f0cd8c;
  }
  .rownote button:hover { background: #3a2f1c; color: #fff; }
  .rownote button.x { border: 0; background: transparent; color: #9a8a68; padding: 2px 6px; }
  /* Rows the leaderboard does not rank — hidden, or lapsed. Everyone sees them:
     a visitor gets them in the ranking's rankless tail, an admin in their true
     place. Dimmed a touch so they read as set apart from the ranked ones rather
     than as a gap in the numbering. */
  tr.unranked td { background: #14171d; }
  .privbadge, .idlebadge {
    margin-left: 6px; font-size: 10px; font-weight: 700; letter-spacing: .3px;
    padding: 1px 5px; border-radius: 4px;
  }
  /* Orange: an admin took this one off the list. */
  .privbadge { background: #2c2418; border: 1px solid #6b4a1f; color: #f0a35c; }
  /* Gray: nobody did anything, the player simply stopped playing. Nothing about
     the profile is withheld, so it must not read as a warning. */
  .idlebadge { background: #21252c; border: 1px solid #363d47; color: #8a929c; }
  /* The player page's stand-in for the profile card + chart of a hidden player. */
  .private-note { padding: 22px 16px; text-align: center; color: #9aa3ad; }
  .private-note .lock { display: block; font-size: 26px; margin-bottom: 8px; }
  .private-note .sub { display: block; margin-top: 6px; font-size: 12px; color: #6b7480; }
  .shell > .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  /* Narrow screens: the sidebar becomes a horizontal bar above the content. */
  @media (max-width: 700px) {
    .shell { flex-direction: column; }
    nav.side {
      position: static; width: 100%; height: auto; flex: none;
      flex-direction: row; align-items: center; gap: 6px;
      padding: 8px 12px; border-right: none; border-bottom: 1px solid #262b33;
      /* More entries than a phone is wide: scroll the bar, not the page. */
      overflow-x: auto; scrollbar-width: none;
    }
    nav.side .brand { padding: 0 8px 0 0; }
    nav.side a.nav.adminentry { margin-top: 0; margin-left: auto; }
  }

  header.top {
    position: relative;
    display: flex; align-items: baseline; gap: 12px;
    padding: 14px 18px; background: #15181e; border-bottom: 1px solid #262b33;
  }
  header.top h1 { margin: 0; font-size: 18px; color: #e6e9ec; }
  header.top h1 a { color: inherit; text-decoration: none; }
  header.top h1 a:hover { color: #fff; }
  header.top .meta { color: #7a828c; font-size: 12px; }
  /* "← all lobbies" back link on the detail page. Right-aligned (margin-left:auto)
     with the other controls so the "lavabalance" title keeps the same position as on
     the list page (which has no back link). */
  header.top .back {
    margin-left: auto;
    font-size: 12px; text-decoration: none; color: #7a828c;
    padding: 4px 10px; border-radius: 5px; border: 1px solid #2c323b; background: #22272f;
  }
  header.top .back:hover { color: #c7ccd1; border-color: #3a414c; }
  /* When the back link is present it owns the auto-margin (pushing the whole right
     group over); cancel the toggle's so the controls stay grouped rather than splitting
     the free space between two auto-margins. */
  header.top .back ~ .toggle { margin-left: 0; }
  header.top .toggle {
    margin-left: auto; cursor: pointer; font: inherit; font-size: 12px;
    padding: 4px 10px; border-radius: 5px; border: 1px solid #2c323b;
    background: #22272f; color: #9aa3ad;
  }
  header.top .toggle:hover { border-color: #3a414c; }
  /* The auto-refresh toggle is admin-only: hidden unless SHARED_JS found admin mode
     and marked <body> (same client-side switch as the SQL sidebar entry). */
  header.top .toggle { display: none; }
  body.admin-mode header.top .toggle { display: inline-block; }
  /* "View all lobbies" link, left of the auto-refresh toggle: same shape as the toggle,
     ringed in orange so it stands out as the way to a lobby that isn't the lava one.
     Like the back link it owns the auto-margin (see the .back rules above). */
  header.top .viewall {
    margin-left: auto; align-self: center; font-size: 12px; text-decoration: none;
    padding: 4px 10px; border-radius: 5px; border: 1px solid #e8862a;
    background: #22272f; color: #f0a35c; white-space: nowrap;
  }
  header.top .viewall:hover { background: #2c2418; border-color: #ffa040; color: #ffb866; }
  header.top .viewall ~ .toggle { margin-left: 0; }
  header.top .toggle.on { background: #1d3325; border-color: #2c5a3c; color: #5cc274; }
  /* Who is logged in + Log in / Log out, at the right end of every page's
     header (SHARED_JS authBox, from /api/auth/me). It owns the auto-margin
     unless a control before it already does (the .back rules above). */
  header.top .authbox {
    margin-left: auto; align-self: center; display: inline-flex; align-items: center; gap: 8px;
    font-size: 12px; white-space: nowrap;
  }
  header.top :is(.back, .viewall) ~ .authbox,
  body.admin-mode header.top .toggle ~ .authbox { margin-left: 0; }
  header.top .authbox .who { color: #c7ccd1; text-decoration: none; max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
  header.top .authbox .who:hover { color: #fff; }
  header.top .authbox .authbtn {
    cursor: pointer; font: inherit; font-size: 12px; text-decoration: none;
    padding: 4px 10px; border-radius: 5px; border: 1px solid #2c323b;
    background: #22272f; color: #9aa3ad;
  }
  header.top .authbox .authbtn:hover { border-color: #3a414c; color: #c7ccd1; }
  /* Small (?) help button in the top-right corner; reveals the attribution popup. */
  header.top .help {
    align-self: center; cursor: pointer; font: inherit; font-size: 12px; font-weight: 700;
    width: 20px; height: 20px; padding: 0; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid #2c323b; background: #22272f; color: #9aa3ad;
  }
  header.top .help:hover { border-color: #3a414c; color: #c7ccd1; }
  .help-pop {
    position: absolute; top: 100%; right: 18px; z-index: 50; margin-top: 6px;
    width: max-content; max-width: 280px; text-align: left;
    padding: 10px 12px; border-radius: 6px;
    background: #0b0d11; border: 1px solid #2c323b; color: #9aa3ad;
    font-size: 11px; line-height: 1.4; box-shadow: 0 4px 14px rgba(0,0,0,.5);
  }
  .help-pop[hidden] { display: none; }
  .help-pop a { color: #7a828c; text-decoration: none; }
  .help-pop a:hover { color: #9aa3ad; text-decoration: underline; }
  main { padding: 14px 18px; display: flex; flex-direction: column; align-items: center; gap: 14px; }

  .lobby {
    width: 100%; max-width: 1400px;
    background: #15181e; border: 1px solid #262b33; border-left: 3px solid #2f6df6;
    border-radius: 8px; overflow: hidden;
  }
  .lobby > .head {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 9px 12px; border-bottom: 1px solid #20242c; background: #181c23;
  }
  .lobby .title { font-weight: 600; color: #e6e9ec; }
  .lobby .id { color: #6b7480; font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 600;
    background: #22272f; color: #9aa3ad;
  }
  .badge.locked { background: #3a1f23; color: #e06c6c; }
  /* "Game in progress" badge — green; the "in lobby" variant stays the neutral gray. */
  .badge.live { background: #1d3325; color: #5cc274; }
  /* The in-progress badge's ticking clock (updated client-side every second). */
  .badge.live .t { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

  /* Roster-view toggle (lobby detail, only while a game-start upload exists):
     two segments, the active one showing which roster the tables carry. */
  .roster-toggle { display: inline-flex; border: 1px solid #2a3038; border-radius: 5px; overflow: hidden; }
  .roster-toggle .rt {
    border: 0; background: #181c23; color: #9aa3ad; cursor: pointer;
    padding: 3px 8px; font-size: 11px; font-weight: 600; line-height: 1.4;
  }
  .roster-toggle .rt + .rt { border-left: 1px solid #2a3038; }
  .roster-toggle .rt.active { background: #24425c; color: #cfe3f5; cursor: default; }

  /* Party pill in its own (unlabelled) column left of LOS, so the pills align
     vertically down the roster: outlined + tinted in the party's own Teiserver
     colour (set inline per party). */
  td.party { width: 1%; text-align: center; padding-right: 0; }
  th.party { padding-right: 0; }
  .party-pill {
    display: inline-block; padding: 1px 8px; border-radius: 9px;
    font-size: 10px; font-weight: 700; line-height: 1.6; white-space: nowrap;
    letter-spacing: .02em; border: 1px solid; vertical-align: middle;
  }

  /* Bosses / spectators / balance-algorithm lines under the team tables. */
  .lobby .foot-lists {
    padding: 2px 16px 14px; display: flex; flex-direction: column; gap: 5px;
  }
  .lobby .foot-lists .line { font-size: 12px; color: #9aa3ad; }
  .lobby .foot-lists .line .k { color: #7a828c; font-weight: 600; margin-right: 6px; }
  .lobby .foot-lists .line a { color: #4d9fff; text-decoration: none; font-weight: 600; }
  .lobby .foot-lists .line a:hover { text-decoration: underline; }
  /* The avoid line is ADMIN-ONLY, the same client-side switch as the admin
     sidebar entries: the server only sends the data with ?includePrivate=true,
     and this keeps the row itself out of a non-admin page either way. */
  .lobby .foot-lists .line.admin-only { display: none; }
  body.admin-mode .lobby .foot-lists .line.admin-only { display: block; }
  .lobby .foot-lists .line .avoid-pair { white-space: nowrap; }
  /* Both people in this lobby = the pair the balancer actually had to weigh. */
  .lobby .foot-lists .line .avoid-pair.live { color: #d8dee6; }

  /* ---- List page: clickable lobby rows ---- */
  .lobby-list { width: 100%; max-width: 1000px; display: flex; flex-direction: column; gap: 10px; }
  a.lobby-row {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 12px 14px; text-decoration: none; color: inherit;
    background: #15181e; border: 1px solid #262b33; border-left: 3px solid #2f6df6;
    border-radius: 8px; transition: background .12s, border-color .12s;
  }
  a.lobby-row:hover { background: #1a1f27; border-left-color: #5b93ff; }
  a.lobby-row .title { font-weight: 600; color: #e6e9ec; font-size: 14px; }
  a.lobby-row .id { color: #6b7480; font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
  a.lobby-row .spacer { margin-left: auto; }
  a.lobby-row .avgs { display: inline-flex; align-items: center; gap: 8px; }
  a.lobby-row .chevron { color: #6b7480; font-size: 16px; }

  /* Two teams side by side, each filling half the (wide) card. A lobby that isn't split into
     two allies (an FFA, or the rtsapi source, which carries no allyteam) has ONE team, and a
     fixed 1fr 1fr left it stranded in a half-width column with dead space beside it —
     auto-fit collapses the empty track so it fills the card. */
  .teams {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr));
    gap: 24px; padding: 16px;
  }
  .team { background: #10131a; border: 1px solid #20242c; border-radius: 8px; overflow: hidden; }
  /* ---- Narrowing a team card ----
     Keyed on the CARD (container query), so a team side by side and a team
     stacked full-width each get the treatment their own width calls for. In
     order, as the card narrows: everything tightens (type, padding, icons);
     then the Games column goes and a party pill drops its word to just the
     number; and only below what that compact table needs (.teams' 360px track
     minimum) do the two teams stack top over bottom — where each gets the full
     width back and returns to full size. A name that still does not fit is
     ellipsed rather than pushing the table past the card. */
  .team { container: team / inline-size; }
  @container team (max-width: 600px) {
    .team h3 { font-size: 16px; padding: 9px 12px; }
    .team thead th { padding: 8px 8px; font-size: 12px; }
    .team td { padding: 8px 8px; }
    .team td.ready, .team thead th.ready { padding-left: 10px; }
    .team td.name .pname { font-size: 14px; line-height: 20px; }
    .team td.name .rank { width: 15px; height: 15px; margin-right: 4px; }
    .team td.skill { font-size: 12px; }
    .team .scout-icons { font-size: 11px; }
    .team td.rating .emblem { width: 24px; height: auto; }
  }
  @container team (max-width: 500px) {
    .team th.games, .team td.games { display: none; }
    .team .party-pill .pword { display: none; }
    .team .party-pill { padding: 1px 6px; }
  }
  @container team (max-width: 420px) {
    .team td.name { max-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .team td.name .boss { margin-left: 3px; }
  }
  .team h3 {
    margin: 0; padding: 12px 16px; font-size: 18px; color: #e6e9ec; font-weight: 600;
    border-bottom: 1px solid #20242c; background: #161a21;
    display: flex; justify-content: space-between; align-items: center;
  }
  /* Average-score badge (team header right side, and the list rows). */
  .avg { display: inline-flex; align-items: center; gap: 5px; }
  /* (?) hint with an instant (no browser-delay) CSS tooltip. Used in both the team
     header and the list rows, so it's scoped to .hint (not .team h3) — otherwise the
     tooltip text would dump inline wherever the scoped rules don't match. */
  .hint {
    position: relative;
    display: inline-flex; align-items: center; justify-content: center;
    width: 14px; height: 14px; border-radius: 50%;
    background: #2a2f38; color: #9aa3ad; font-size: 10px; font-weight: 700;
    cursor: help;
  }
  .hint .hint-tip {
    position: absolute; top: 135%; right: 0; z-index: 20;
    display: none; width: max-content; max-width: 230px;
    padding: 6px 8px; border-radius: 5px; text-align: left;
    background: #0b0d11; border: 1px solid #2c323b; color: #c7ccd1;
    font-size: 11px; font-weight: 400; line-height: 1.35; white-space: normal;
    box-shadow: 0 4px 14px rgba(0,0,0,.5);
  }
  .hint:hover .hint-tip { display: block; }
  /* Hint circle right of an LOS pill (rookie discount / assumed debutant): the
     same (?) visual as the average hints, absolutely hung in the rating cell's
     right padding so the right-aligned pills stay aligned across rows. */
  td.rating { position: relative; }
  /* Vertically centred WITHOUT a transform: a transformed ancestor would turn the
     tooltip's position:fixed (set on hover, see the lobby script) into
     absolute-in-the-marker and re-trap it under the team card's overflow clip. */
  .hint.pill-hint { position: absolute; top: calc(50% - 7px); right: 1px; }
  /* Rows below carry positioned cells that would paint over the open tooltip —
     raise the hovered marker above them. */
  .hint.pill-hint:hover { z-index: 30; }

  table { width: 100%; border-collapse: collapse; }
  thead th {
    text-align: left; padding: 10px 16px; font-size: 13px; font-weight: 700;
    color: #8a929c; border-bottom: 1px solid #20242c; white-space: nowrap;
  }
  thead th.ready { width: 1.4em; padding-left: 16px; padding-right: 0; }
  thead th.skill { text-align: right; }
  thead th.rating { text-align: right; }
  td { padding: 12px 16px; white-space: nowrap; vertical-align: middle; }
  tbody tr + tr td { border-top: 1px solid #181c23; }
  tbody tr:hover { background: #1a1f27; }
  td.ready { width: 1.4em; text-align: center; font-weight: 700; padding-right: 0; }
  td.skill {
    width: 2.6em; text-align: right; font-weight: 700; color: #cdb24e;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  td.name { width: 100%; color: #d8dde2; }
  /* Rank icon (ranks/<1-8>.png), left of the player name. */
  td.name .rank {
    width: 18px; height: 18px; margin-right: 6px;
    vertical-align: middle; image-rendering: auto;
  }
  td.name .pname {
    vertical-align: middle; color: #fff;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", "Liberation Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
    font-size: 16px; font-weight: 700; line-height: 24px;
  }
  .ready-yes { color: #4caf50; }
  .ready-no  { color: #d14b4b; }
  /* Hourglass marker shown in place of the ready tick while a player is unsynced
     (sync === 2) — typically still downloading the map after a host map change. */
  .unsynced { font-size: 13px; }
  /* Crossed-swords "in game" marker shown in place of the ready tick once the match
     has launched and the player has loaded in. */
  .in-game { font-size: 15px; }
  td.name .boss { margin-left: 6px; }

  /* LOS pill, right of the player name. Colors per LOS band. */
  td.rating { width: 1%; text-align: right; }
  th.games { text-align: right; }
  td.games { width: 1%; text-align: right; }
  .pill {
    display: inline-block; min-width: 3.4em; text-align: center;
    padding: 3px 10px; border-radius: 10px; font-weight: 700; font-size: 13px;
    line-height: 1.3; text-decoration: none;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .pill.blue   { background: rgb(13, 110, 253);  color: #fff; }
  .pill.green  { background: rgb(25, 135, 84);   color: #fff; }
  .pill.orange { background: rgb(255, 193, 7);   color: #1a1d21; }
  .pill.gray   { background: rgb(108, 117, 125); color: #fff; }
  /* A pill-shaped BLANK: no rating to show (a private profile). Colourless and
     unbolded, but the same box, so it keeps the column aligned. */
  .pill.none   { background: none; color: #6b7480; font-weight: 400; }
  /* In a RATING COLUMN the pills are read down the page, so they all have to be
     one width. fmtLos is toFixed(1), so "9.5" is a character narrower than
     "14.4" and the default min-width (3.4em) let the short ones shrink — wide
     enough for the longest value, every pill is the same box and the numbers
     line up in a column (the blank above included). */
  td.rating .pill { min-width: 4em; }

  /* Rank emblems (src/los/tiers.ts) — what a visitor sees in place of LOS.
     An admin sees the emblem beside the LOS pill. */
  .rank-badge { display: inline-flex; align-items: center; gap: 7px; vertical-align: middle; }
  .rank-badge .emblem { display: block; flex: none; overflow: visible; }
  td.rating .rank-badge + .pill { margin-left: 6px; }
  .rank-name { font-weight: 700; font-size: 13px; letter-spacing: .04em; white-space: nowrap; }
  .rank-name.tier-placing  { color: #a9b3bf; }
  .rank-name.tier-bronze   { color: #e3a265; }
  .rank-name.tier-silver   { color: #dfe5ec; }
  .rank-name.tier-gold     { color: #f3c53a; }
  .rank-name.tier-platinum { color: #7fe3d6; }
  .rank-name.tier-diamond  { color: #8fc2ff; }
  .profile .rank-badge.with-text { flex-direction: column; gap: 2px; }
  .profile .rank-badge .rank-name { font-size: 12px; text-transform: uppercase; letter-spacing: .14em; }
  .ranking th.col-tier { width: 132px; }
  .ranking td.col-tier, .ranking th.col-tier { text-align: left; }
  /* The admin's list carries the Rank column beside LOS and both movements. */
  body.admin-mode .card.ranking { max-width: 1000px; }
  @keyframes emb-rise { 0% { transform: translateY(0); opacity: 0; } 15% { opacity: 1; } 100% { transform: translateY(-38px); opacity: 0; } }
  @keyframes emb-pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
  .emb-ember { animation: emb-rise 3.6s linear infinite; transform-box: fill-box; }
  .emb-crack { animation: emb-pulse 2.8s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) { .emb-ember, .emb-crack { animation: none; } }

  .empty, .error { color: #7a828c; padding: 22px; text-align: center; }
  /* "Select a lobby" under the empty note: a button-shaped link to the picker page. */
  .empty .pick {
    display: inline-block; margin-top: 12px; text-decoration: none;
    font-size: 13px; font-weight: 600; padding: 6px 14px; border-radius: 5px;
    border: 1px solid #e8862a; background: #22272f; color: #f0a35c;
  }
  .empty .pick:hover { background: #2c2418; border-color: #ffa040; color: #ffb866; }
  /* The all-lobbies picker table. */
  .all-lobbies td { padding: 9px 14px; }
  .all-lobbies thead th { padding: 9px 14px; }
  .all-lobbies tr[data-href] { cursor: pointer; }
  .all-lobbies td.lname { width: 100%; white-space: normal; font-weight: 600; color: #e6e9ec; }
  /* Lava lobbies (sorted to the top by the API) get the button's orange for their name. */
  .all-lobbies td.lname a.plink.lava { color: #f0a35c; }
  .all-lobbies td.lname a.plink.lava:hover { color: #ffb866; }
  .all-lobbies td.lid { color: #6b7480; font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .all-lobbies td.lmap { color: #c7ccd1; }
  .all-lobbies td.lstatus { white-space: nowrap; }
  .all-lobbies td.lstatus .badge + .badge { margin-left: 4px; }
  .all-lobbies td.num { color: #c7ccd1; }

  /* ---- SQL stats page (/sql, admin-only) ---- */
  .sqlstats .card .window { color: #7a828c; font-size: 12px; padding: 10px 16px 4px; }
  .sqlstats .card .window b { color: #9aa3ad; font-weight: 600; }
  .sqlstats table { font-size: 13px; }
  .sqlstats thead th { padding: 8px 12px; text-align: right; }
  .sqlstats thead th:first-child { text-align: left; }
  .sqlstats td { padding: 6px 12px; text-align: right; font-variant-numeric: tabular-nums; }
  .sqlstats td.op {
    text-align: left; color: #8fd3ff; font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .sqlstats td.dim { color: #6a7785; }
  .sqlstats td.hot { color: #e0a04c; }
  .sqlstats td.over { color: #e06c6c; font-weight: 600; }
  .sqlstats tfoot td { border-top: 1px solid #2a323c; color: #e6e9ec; font-weight: 600; }
  .sqlstats tfoot td.op { color: #e6e9ec; font-family: inherit; font-size: 13px; }
  .sqlstats .grand table tbody td { font-weight: 600; color: #e6e9ec; }
  .sqlstats .bar { text-align: center; }
  .sqlstats .bar button {
    cursor: pointer; font: inherit; font-size: 12px; padding: 4px 12px; border-radius: 5px;
    border: 1px solid #2c323b; background: #22272f; color: #9aa3ad;
  }
  .sqlstats .bar button:hover { border-color: #3a414c; color: #c7ccd1; }
  .error { color: #e06c6c; }

  /* ---- Login page (/login) ---- */
  .loginpage .card { max-width: 560px; }
  .loginpage .body { padding: 16px; font-size: 14px; color: #c7ccd1; line-height: 1.55; }
  .loginpage .body p { margin: 0 0 12px; }
  .loginpage ol.steps { margin: 0 0 14px; padding-left: 22px; }
  .loginpage ol.steps li { margin-bottom: 8px; }
  .loginpage code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
    background: #22272f; border: 1px solid #2c323b; border-radius: 4px; padding: 1px 6px; color: #e6e9ec;
  }
  .loginpage .fine { font-size: 12px; color: #7a828c; }
  .loginpage .returnnote {
    margin: 14px 0 0 !important; padding: 9px 12px; border-radius: 6px; font-size: 13px;
    background: #1c1830; border: 1px solid #3b3264; color: #c9bdf7;
  }
  .loginpage .returnnote a { color: #e2d9ff; font-weight: 600; }
  .loginpage .who { font-size: 18px; font-weight: 700; color: #e6e9ec; margin-bottom: 14px; }
  .loginpage button.act {
    cursor: pointer; font: inherit; font-size: 14px; font-weight: 600;
    padding: 8px 20px; border-radius: 6px; border: 1px solid #2c5236;
    background: #1d3325; color: #5cc274;
  }
  .loginpage button.act:hover:not(:disabled) { border-color: #3e7a4e; color: #7fdc97; }
  .loginpage button.act:disabled { opacity: .4; cursor: default; }
  .loginpage button.act.quiet { border-color: #2c323b; background: #22272f; color: #c7ccd1; }
  .loginpage .note { margin-top: 12px; font-size: 13px; }
  .loginpage .note.err { color: #e06c6c; }
  /* Dev-only fake login (DEV_LOGIN=true): dashed orange so it can
     never be mistaken for part of the real page. */
  .loginpage .card.dev { margin-top: 16px; border: 1px dashed #d9a44a; }
  .loginpage .card.dev > h2 { color: #d9a44a; }
  .loginpage .devrow { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .loginpage .devrow input { flex: 1; min-width: 160px; }

  /* ---- Polls page (/polls) ---- */
  .pollpage { padding: 18px; display: flex; flex-direction: column; align-items: center; gap: 16px; }
  .poll {
    width: 100%; max-width: 1080px; background: #15181e; border: 1px solid #262b33;
    border-radius: 10px; overflow: hidden;
  }
  .poll-head { padding: 22px 24px 6px; background: radial-gradient(120% 140% at 0% 0%, #2a1a12 0%, #15181e 55%); }
  .poll-kicker {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #8a929c;
  }
  .poll-kicker .state { padding: 2px 8px; border-radius: 999px; background: #1d3325; color: #5cc274; border: 1px solid #2c5236; }
  .poll-kicker .state.closed { background: #2a1d1d; color: #e06c6c; border-color: #5a2c2c; }
  .poll-head h2 { margin: 10px 0 8px; font-size: 26px; line-height: 1.2; color: #f3f5f7; letter-spacing: -.01em; }
  .poll-question { font-size: 15px; line-height: 1.55; color: #c7ccd1; max-width: 760px; }
  .poll-question p { margin: 0 0 10px; }
  .poll-hint { margin: 2px 0 0; font-size: 12px; color: #7a828c; }
  .choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; padding: 16px 24px 4px; }
  .choice {
    --accent: #7a828c;
    position: relative; display: flex; flex-direction: column; gap: 10px;
    padding: 14px; border-radius: 10px; background: #12151b; border: 2px solid #262b33;
    transition: border-color .15s, background .15s, transform .15s, box-shadow .15s;
  }
  .choice.selected { border-color: color-mix(in srgb, var(--accent) 45%, #262b33); }
  .choice.selected .pick { box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
  .choice-heading { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); }
  .choice-heading .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
  .choice .shot {
    display: block; width: 100%; padding: 0; border: 1px solid #262b33; border-radius: 8px; overflow: hidden;
    background: #0e1014; cursor: zoom-in; position: relative;
  }
  .choice .shot img { display: block; width: 100%; height: auto; }
  .choice .shot .zoomhint {
    position: absolute; right: 8px; bottom: 8px; padding: 3px 8px; border-radius: 5px; font-size: 11px;
    background: rgba(14,16,20,.85); color: #c7ccd1; opacity: 0; transition: opacity .15s;
  }
  .choice .shot:hover .zoomhint, .choice .shot:focus-visible .zoomhint { opacity: 1; }
  .choice .caption { margin: 0; font-size: 13px; color: #9aa3ad; line-height: 1.45; }
  .choice .pick {
    margin-top: auto; display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 8px;
    background: #181c23; border: 1px solid #262b33; cursor: pointer;
    transition: border-color .15s, background .15s;
  }
  .choice:not(.closed) .pick:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 9%, #181c23); }
  .choice.closed .pick { cursor: default; }
  .choice.selected .pick { background: color-mix(in srgb, var(--accent) 14%, #181c23); border-color: color-mix(in srgb, var(--accent) 50%, #262b33); }
  .choice .pick input { position: absolute; opacity: 0; pointer-events: none; }
  .choice .radio {
    flex: none; width: 20px; height: 20px; border-radius: 50%; border: 2px solid #4a525d; display: grid; place-items: center;
    transition: border-color .15s;
  }
  .choice .radio::after { content: ""; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); transform: scale(0); transition: transform .15s; }
  .choice.selected .radio { border-color: var(--accent); }
  .choice.selected .radio::after { transform: scale(1); }
  .choice .pick:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
  .choice .pick .txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .choice .pick .lbl { font-size: 15px; font-weight: 700; color: #e6e9ec; }
  .choice .pick .sub { font-size: 12px; color: #8a929c; }
  .choice .mine {
    position: absolute; top: 10px; right: 12px; padding: 2px 9px; border-radius: 999px;
    font-size: 11px; font-weight: 700; background: var(--accent); color: #0e1014;
  }
  .choice .pick.shake { animation: pollshake .35s; }
  @keyframes pollshake { 0%,100% { transform: none; } 25% { transform: translateX(-5px); } 75% { transform: translateX(5px); } }

  .poll-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 18px 24px 22px; }
  .vote-btn {
    cursor: pointer; font: inherit; font-size: 17px; font-weight: 800; letter-spacing: .02em;
    padding: 13px 38px; border-radius: 10px; border: none; color: #1a0d05;
    background: linear-gradient(135deg, #ffb347 0%, #ff7a2f 50%, #f0462b 100%);
    box-shadow: 0 6px 22px rgba(255, 110, 50, .28), inset 0 1px 0 rgba(255,255,255,.35);
    transition: transform .1s, box-shadow .15s, filter .15s;
  }
  .vote-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 8px 28px rgba(255, 110, 50, .4), inset 0 1px 0 rgba(255,255,255,.35); filter: brightness(1.05); }
  .vote-btn:active:not(:disabled) { transform: translateY(1px); }
  .vote-btn:disabled { cursor: default; filter: grayscale(.7) brightness(.7); box-shadow: none; }
  .vote-btn.done { background: linear-gradient(135deg, #3fbf6a, #2b9a55); color: #06170d; filter: none; }
  .results-btn {
    cursor: pointer; font: inherit; font-size: 14px; font-weight: 600; padding: 11px 18px; border-radius: 10px;
    border: 1px solid #2c323b; background: #1a1e25; color: #c7ccd1;
  }
  .results-btn:hover { border-color: #3a414c; color: #fff; }
  .poll-status { font-size: 13px; color: #9aa3ad; min-height: 1em; }
  .poll-status.ok { color: #5cc274; }
  .poll-status.err { color: #e06c6c; }
  .poll-status .login { color: #ffb866; font-weight: 600; }
  .poll-status .ago { color: #7a828c; }

  .poll-results { border-top: 1px solid #20242c; padding: 20px 24px 24px; background: #13161c; }
  .poll-results[hidden] { display: none; }
  .poll-results.reveal { animation: pollreveal .35s ease-out; }
  @keyframes pollreveal { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
  .poll-results h3 { margin: 0 0 14px; font-size: 15px; color: #e6e9ec; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .poll-results h3 .sub { font-size: 12px; font-weight: 400; color: #7a828c; }
  .rbar { margin-bottom: 14px; }
  .rbar-top { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; font-size: 14px; }
  .rbar-top .lbl { font-weight: 700; color: #e6e9ec; }
  .rbar-top .you { font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 999px; background: var(--accent); color: #0e1014; }
  .rbar-top .lead { font-size: 11px; color: #ffd84a; }
  .rbar-top .num { margin-left: auto; font-variant-numeric: tabular-nums; color: #9aa3ad; }
  .rbar-top .pct { font-size: 18px; font-weight: 800; color: var(--accent); margin-left: 8px; }
  .rbar-track { height: 14px; border-radius: 999px; background: #1d2129; overflow: hidden; }
  .rbar-fill {
    height: 100%; border-radius: 999px; width: 0; transition: width .8s cubic-bezier(.2,.8,.2,1);
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 65%, #000), var(--accent));
  }
  .split { width: 100%; display: flex; height: 26px; border-radius: 8px; overflow: hidden; margin: 2px 0 18px; background: #1d2129; }
  .split > div { display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 800; color: #0e1014; transition: flex-basis .8s cubic-bezier(.2,.8,.2,1); flex-basis: 0; min-width: 0; overflow: hidden; white-space: nowrap; }
  .tiers { margin-top: 22px; }
  .tiers h4 { margin: 0 0 4px; font-size: 13px; color: #e6e9ec; }
  .tiers .sub { margin: 0 0 10px; font-size: 12px; color: #7a828c; }
  .tier-row { display: grid; grid-template-columns: 150px 1fr 90px; align-items: center; gap: 12px; padding: 6px 0; border-bottom: 1px solid #1a1e25; font-size: 13px; }
  .tier-row:last-child { border-bottom: none; }
  .tier-row .who { display: flex; align-items: center; gap: 8px; color: #c7ccd1; font-weight: 600; }
  .tier-row .mini { display: flex; height: 12px; border-radius: 999px; overflow: hidden; background: #1d2129; }
  .tier-row .mini > div { height: 100%; }
  .tier-row .n { text-align: right; color: #7a828c; font-variant-numeric: tabular-nums; }
  .tier-row .why { font-size: 11px; color: #6b7480; }
  .legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: #9aa3ad; margin-bottom: 8px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  .poll-empty { color: #7a828c; font-size: 14px; padding: 6px 0 2px; }
  .voters { margin-top: 22px; }
  .voters h4 { margin: 0 0 8px; font-size: 13px; color: #d9a44a; }
  .voters .scroll { overflow-x: auto; }
  .voters table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .voters th, .voters td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #1a1e25; }
  .voters th { color: #7a828c; font-weight: 600; }
  .voters td a { color: #c7ccd1; text-decoration: none; font-weight: 600; }
  .voters td a:hover { color: #7fbaff; }
  .poll-foot { width: 100%; max-width: 1080px; font-size: 12px; color: #6b7480; line-height: 1.5; }
  .lightbox {
    position: fixed; inset: 0; z-index: 50; background: rgba(5,6,8,.88); display: grid; place-items: center;
    padding: 24px; cursor: zoom-out; animation: pollreveal .2s ease-out;
  }
  .lightbox figure { margin: 0; max-width: min(1200px, 100%); }
  .lightbox img { display: block; max-width: 100%; max-height: 80vh; border-radius: 10px; border: 1px solid #262b33; }
  .lightbox figcaption { margin-top: 10px; text-align: center; color: #c7ccd1; font-size: 14px; }
  .lightbox figcaption b { color: var(--accent); }
  @media (max-width: 700px) {
    .pollpage { padding: 12px; }
    .poll-head { padding: 18px 16px 4px; }
    .poll-head h2 { font-size: 21px; }
    .choices { padding: 14px 16px 4px; grid-template-columns: 1fr; }
    .poll-actions { padding: 16px; }
    .vote-btn { flex: 1 1 100%; }
    .results-btn { flex: 1 1 100%; }
    .poll-results { padding: 18px 16px; }
    .tier-row { grid-template-columns: 110px 1fr 72px; }
  }

  /* ---- Bot page (admin-only) ---- */
  .botpage .card { max-width: 700px; }
  .botpage .actions { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #20242c; background: #14171d; flex-wrap: wrap; }
  .botpage .actions .note { font-size: 12px; color: #7a828c; }
  .botpage .actions .note.err { color: #e06c6c; }
  .botpage button.act {
    cursor: pointer; font: inherit; font-size: 13px; font-weight: 600;
    padding: 6px 18px; border-radius: 6px; border: 1px solid #2c323b;
    background: #22272f; color: #c7ccd1;
  }
  .botpage button.act:disabled { opacity: .4; cursor: default; }
  .botpage button.act.start { border-color: #2c5236; background: #1d3325; color: #5cc274; }
  .botpage button.act.start:hover:not(:disabled) { border-color: #3e7a4e; color: #7fdc97; }
  .botpage button.act.stop { border-color: #57343a; background: #3a1f23; color: #e06c6c; }
  .botpage button.act.stop:hover:not(:disabled) { border-color: #7d474f; color: #f08d8d; }
  .botpage .kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 18px; padding: 12px 16px; font-size: 13px; }
  .botpage .kv .k { color: #7a828c; white-space: nowrap; }
  .botpage .kv .v { color: #e6e9ec; overflow-wrap: anywhere; }
  .botpage .kv .v.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .botpage .kv .v .err { color: #e06c6c; }
  .botpage .state { display: inline-flex; align-items: center; gap: 7px; font-weight: 600; }
  .botpage .state .dot { width: 9px; height: 9px; border-radius: 50%; background: #6b7480; }
  .botpage .state.up { color: #5cc274; } .botpage .state.up .dot { background: #5cc274; }
  .botpage .state.down { color: #e06c6c; } .botpage .state.down .dot { background: #e06c6c; }
  .botpage .state.mid { color: #d9a44a; } .botpage .state.mid .dot { background: #d9a44a; }
  .botpage .token { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid #20242c; background: #14171d; font-size: 12px; color: #7a828c; flex-wrap: wrap; }
  .botpage .token input { width: 260px; }
  /* The prominent "which lobby is the bot in" banner. */
  .botpage .lobbyline {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 16px; font-size: 18px; font-weight: 700; color: #e6e9ec;
    border-bottom: 1px solid #20242c;
  }
  .botpage .lobbyline a { color: #4d9fff; text-decoration: none; }
  .botpage .lobbyline a:hover { color: #7fbaff; text-decoration: underline; }
  .botpage .lobbyline .title { font-weight: 400; font-size: 14px; color: #9aa3ad; }
  .botpage .lobbyline.none { color: #d9a44a; }
  .botpage .lobbyline.off { color: #6b7480; font-weight: 400; }
  /* Join controls: main-lobby button + the join-by-id input. */
  .botpage .joinrow {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 12px 16px; border-bottom: 1px solid #20242c; background: #14171d;
  }
  .botpage .joinrow .sep { color: #3a414c; }
  .botpage .joinrow input { width: 110px; }
  .botpage button.act.join { border-color: #2c4a6b; background: #1c2836; color: #6fb1ff; }
  .botpage button.act.join:hover:not(:disabled) { border-color: #3a6fd8; color: #9ccaff; }

  /* ---- Matchup strip, above both team tables (two-team lobbies only) ----
     Each side's average, win chance and the elo a win is worth, meeting in the MIDDLE so the
     two teams read against each other instead of at opposite edges of the card. Same 16px
     side padding as .teams, so the divider lands in the gap between the two team columns. */
  .matchup {
    display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
    gap: 4px 26px; padding: 14px 16px 0;
  }
  .matchup .side { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .matchup .side.left { align-items: flex-end; text-align: right; }
  .matchup .side.right { align-items: flex-start; text-align: left; }
  .matchup .line { display: flex; align-items: center; gap: 8px; }
  /* Mirror the right side so both averages — and both win percentages — flank the divider. */
  .matchup .side.right .line { flex-direction: row-reverse; }
  .matchup .tname { font-size: 13px; font-weight: 600; color: #9aa3ad; }
  /* Team labels in the in-game team colours, matching the balance bar's segments
     (left/Team 1 blue, right/Team 2 red). Two-team lobbies only — same as the bar. */
  .matchup .side.left .tname, .team h3 .tname.t1 { color: #0b3ef3; }
  .matchup .side.right .tname, .team h3 .tname.t2 { color: #ff1005; }
  .matchup .wp { font-size: 17px; font-weight: 700; color: #e6e9ec; }
  /* Middle column: the "vs" divider and the rating gap between the two averages. */
  .matchup .mid {
    display: flex; flex-direction: column; align-items: center; gap: 4px; color: #6b7480;
  }
  .matchup .mid .vs {
    font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
  }
  .matchup .mid .gap {
    font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 1px 6px; border-radius: 4px; background: #20242c; color: #8a929c;
    white-space: nowrap;
  }
  /* Win-probability split, spanning the whole strip: left segment = the left team, in the
     in-game team colours (Team 1 blue, Team 2 red). */
  .matchup .probbar {
    grid-column: 1 / -1; display: flex; height: 5px; margin-top: 10px;
    border-radius: 3px; overflow: hidden; background: #20242c;
  }
  .matchup .probbar span { display: block; min-width: 2px; }
  .matchup .probbar .a { background: #0b3ef3; }
  .matchup .probbar .b { background: #ff1005; }

  /* ---- Game page: barreplay's summary under the teams ----
     The summary draws itself (barreplay's module, imported from its
     deployment); its colours are custom properties declared on
     .brs-root, so they are overridden there to sit on this page's panels. */
  .summary-slot { border-top: 1px solid #20242c; }
  .summary-slot:empty { border-top: 0; }
  .summary-slot > h2 {
    margin: 0; padding: 12px 16px 0; font-size: 18px; color: #e6e9ec; font-weight: 600;
  }
  .summary-slot > .empty, .summary-slot > .error { padding: 16px; }
  .summary-slot .brs-root {
    --brs-bg: transparent; --brs-panel: #10131a; --brs-line: #20242c; --brs-grid: #1a1f27;
    --brs-text: #c7ccd1; --brs-muted: #9aa3ad;
    max-width: none; padding: 12px 16px 24px;
  }

  /* ---- Ranking / player pages ---- */
  .card {
    width: 100%; max-width: 980px;
    background: #15181e; border: 1px solid #262b33; border-left: 3px solid #2f6df6;
    border-radius: 8px; overflow: hidden;
  }
  .card > h2 {
    margin: 0; padding: 11px 16px; font-size: 14px; color: #e6e9ec;
    border-bottom: 1px solid #20242c; background: #181c23;
    display: flex; align-items: center; gap: 10px;
  }
  .card > h2 .sub { font-weight: 400; font-size: 12px; color: #7a828c; }
  /* A toolbar control for maintenance rather than for reading, on the same
     client-side switch as the admin sidebar entries and the admin table
     column: hidden outside admin mode (SHARED_JS). */
  .btn.admin-only { display: none; }
  body.admin-mode .btn.admin-only { display: inline-block; }

  /* ---- Movement marks (the two Δ columns) ---- */
  .chg { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; }
  .chg.up { color: #5cc274; }
  .chg.down { color: #e06c6c; }
  .chg.flat { color: #6b7480; font-weight: 400; }
  /* Each movement is its OWN column, sitting against the one it is a movement
     of. Inside that cell it could not work: td.rankno is right-aligned, so a
     mark trailing the number decided where the NUMBER landed — a "▲ 12" and a
     "–" put their ranks in two different places and the column stopped reading
     as one. A table column aligns by construction, and it is also the only way
     a movement gets a header of its own to sort by. */
  td.chgcol, th.chgcol {
    width: 1%; white-space: nowrap; text-align: left;
    padding-left: 0; padding-right: 10px;
  }
  td.chgcol .chg { font-size: 11px; }
  /* ...which leaves the # column free to sit tight against it. */
  td.rankno, th.sortable.rankhead { padding-right: 4px; }

  /* ---- Sortable column headers ---- */
  thead th.sortable { cursor: pointer; user-select: none; }
  thead th.sortable:hover { color: #c7ccd1; }
  thead th.sortable:focus-visible { outline: 2px solid #4b90c4; outline-offset: -2px; }
  thead th.sorted { color: #e6e9ec; }
  /* The arrow must NOT inherit its column's font. th.num is monospace, so the
     # header drew a narrow monospace glyph while every other header drew the
     UI font's — same declared size, visibly different arrow. Pinned to the body
     stack so all four are one mark. */
  thead th .sortmark {
    margin-left: 4px; font-size: 11px; color: #4b90c4;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  td.num, th.num { text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  td.rankno { color: #6b7480; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; width: 3em; text-align: right; }
  a.plink { color: #4d9fff; text-decoration: none; font-weight: 700; }
  a.plink:hover { color: #7fbaff; text-decoration: underline; }
  /* Lobby roster names stay white; the link only shows itself on hover. */
  td.name a.pname { color: #fff; text-decoration: none; }
  td.name a.pname:hover { color: #7fbaff; text-decoration: underline; }
  .res-w { color: #5cc274; font-weight: 700; }
  .res-l { color: #e06c6c; font-weight: 700; }
  .delta-up { color: #5cc274; }
  .delta-down { color: #e06c6c; }
  .muted { color: #6b7480; }
  /* Controls inside a card: the filter toolbar under the title and the pager footer. */
  .card .toolbar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 9px 16px; border-bottom: 1px solid #20242c; background: #14171d;
    color: #7a828c; font-size: 12px;
  }
  .card .toolbar .spacer { margin-left: auto; }
  .card .toolbar label { display: inline-flex; align-items: center; gap: 6px; }
  .card .foot {
    display: flex; align-items: center; justify-content: center; gap: 14px;
    padding: 10px 16px; border-top: 1px solid #20242c; background: #14171d;
    color: #9aa3ad; font-size: 12px;
  }
  .btn {
    cursor: pointer; font: inherit; font-size: 12px;
    padding: 4px 12px; border-radius: 5px; border: 1px solid #2c323b;
    background: #22272f; color: #9aa3ad;
  }
  .btn:hover:not(:disabled) { border-color: #3a414c; color: #c7ccd1; }
  .btn:disabled { opacity: .4; cursor: default; }
  select.ctl {
    font: inherit; font-size: 12px; color: #c7ccd1; cursor: pointer;
    padding: 3px 6px; border-radius: 5px; border: 1px solid #2c323b; background: #22272f;
  }
  input.ctl {
    font: inherit; font-size: 12px; color: #c7ccd1;
    padding: 4px 8px; border-radius: 5px; border: 1px solid #2c323b; background: #22272f;
  }
  input.ctl:focus { outline: none; border-color: #3a6fd8; }
  input.ctl::placeholder { color: #6b7480; }
  /* The ranking page's search box, in the left group next to the pager. */
  .card .toolbar input.search { width: 200px; margin-left: 10px; }
  /* Player profile card. */
  .profile { padding: 14px 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 14px 22px; }
  .profile .who { display: flex; align-items: center; gap: 12px; }
  .profile .who .pname2 { font-size: 22px; font-weight: 700; color: #fff; }
  .profile .pill.big { font-size: 17px; padding: 5px 14px; border-radius: 12px; }
  .profile .stats { display: flex; flex-wrap: wrap; gap: 6px 26px; margin-left: auto; }
  .profile .stat .k { font-size: 11px; color: #7a828c; }
  .profile .stat .v { font-size: 15px; font-weight: 700; color: #e6e9ec; white-space: nowrap; }
  /* LOS-over-time chart. */
  .chartwrap { position: relative; padding: 10px 12px 6px; }
  .chartwrap canvas { display: block; width: 100%; height: 260px; cursor: crosshair; }
  .chart-tip {
    position: absolute; z-index: 10; pointer-events: none;
    padding: 5px 8px; border-radius: 5px; white-space: nowrap;
    background: #0b0d11; border: 1px solid #2c323b; color: #c7ccd1;
    font-size: 11px; line-height: 1.4; box-shadow: 0 4px 14px rgba(0,0,0,.5);
  }
  .chart-tip[hidden] { display: none; }
  .chartwrap canvas.selecting { cursor: col-resize; }
  /* Axis controls under the chart: the time/games toggle (centered) + reset zoom. */
  .chart-axis {
    display: flex; align-items: center; justify-content: center; gap: 10px;
    padding: 2px 0 6px; font-size: 11px; color: #6b7480;
  }
  .chart-axis .seg { display: inline-flex; border: 1px solid #2c323b; border-radius: 5px; overflow: hidden; }
  .chart-axis .seg button {
    cursor: pointer; font: inherit; font-size: 11px; padding: 3px 10px; border: 0;
    background: #22272f; color: #9aa3ad;
  }
  .chart-axis .seg button + button { border-left: 1px solid #2c323b; }
  .chart-axis .seg button.on { background: #1d3325; color: #5cc274; }
  .chart-axis .seg button:hover:not(.on) { color: #c7ccd1; }
  .chart-axis .reset { cursor: pointer; font: inherit; font-size: 11px; color: #4d9fff; background: none; border: 0; padding: 0; }
  .chart-axis .reset:hover { text-decoration: underline; }
  .chart-axis .reset[hidden] { display: none; }

  /* ---- Games list / game page ----
     Team colours: the in-game blue/red (matchup strip) lifted for legibility on the
     dark rows — tc0 = Team 1 (blue), tc1 = Team 2 (red). Used for names and LOS. */
  .tc0 { color: #5b8cff; }
  .tc1 { color: #ff5f52; }
  a.tc0, a.tc1 { text-decoration: none; }
  /* The player page's own name in the rosters. */
  a.tc0.me, a.tc1.me { font-weight: 700; text-decoration: underline; }
  a.tc0:hover, a.tc1:hover { text-decoration: underline; }
  .card.wide { max-width: 1400px; }
  /* Wider than the generic card's 700 because the ranking carries two more
     columns than it used to (the Δ pair). The card is overflow:hidden for its
     rounded corners and the admin row menu must NOT be clipped, so the table
     cannot be given a scroller of its own — the cap has to fit the columns. */
  .card.ranking { max-width: 860px; }

  /* ---- The ranking's column widths ----
     FIXED layout, because with the automatic one every column is as wide as the
     widest thing in it and so the whole table re-laid itself on every sort and
     every page: rank 1 against rank 9575, "–" against "▼ 117". Reading a list
     is following a column down, and a column that moves under you is the one
     thing a table must not do.
     Every column but the PLAYER is a known quantity — a rank, a delta, a count,
     a date — so each is given the room its widest real value needs and the name,
     the only genuinely variable one, takes whatever is left. Under fixed layout
     only the HEADER row's cells decide the widths, which is what col-<key> is
     for. */
  .ranking .games-table table { table-layout: fixed; }
  .ranking th.col-rank    { width: 58px; }
  .ranking th.col-rankchg { width: 66px; }
  .ranking th.col-los     { width: 66px; }
  .ranking th.col-loschg  { width: 66px; }
  .ranking th.col-games   { width: 62px; }
  .ranking th.col-wl      { width: 88px; }
  .ranking th.col-win     { width: 56px; }
  .ranking th.col-last    { width: 108px; }
  .ranking th.admin-col.rowacts { width: 46px; }
  /* col-player takes the remainder. A name longer than that can no longer widen
     the table, so it is cut with an ellipsis rather than allowed to overlap the
     rating beside it; the full name is on the link's own title.
     The cell is a FLEX row so the truncation lands on the NAME and not on
     whatever happens to be last: ellipsing the cell itself cut the "inactive"
     badge in half, which reads as a rendering fault rather than as a shortage
     of room. The badge keeps its width, the name gives up its own. */
  .ranking td.name { display: flex; align-items: center; gap: 6px; min-width: 0; }
  /* min-width:0 is load-bearing: a flex item defaults to min-width:auto, so the
     name refused to shrink below its own min-content and pushed the whole table
     past the card instead of ellipsing. */
  .ranking td.name a.plink {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ranking td.name .privbadge, .ranking td.name .idlebadge { flex: none; margin-left: 0; }

  /* ---- Narrowing the ranking ----
     The player's NAME is the one column that must never go: it is what every
     other cell is about. But it is also the column taking the remainder, so it
     is the first thing a shortage takes from — squeeze the card and the name
     reaches zero while nine columns of numbers sit there intact.
     So the card gives room up in two ways as it narrows. First the type and the
     padding tighten, which buys ~80px across the fixed columns at no cost to
     what is readable. Then the RECORD columns leave one at a time, least useful
     first: a date, then a rate derivable from the two numbers beside it, then
     those numbers, then the count. What stays at every width is who the player
     is, where they stand, and how both have moved.
     Keyed on the CARD (container query) and not the viewport, because the card's
     width depends on which shell layout is up — the sidebar is 180px until it
     becomes a top bar at 700px — so one viewport figure means two different
     cards. A browser without container queries simply keeps every column, which
     is the behaviour this replaced. */
  .card.ranking { container: ranking / inline-size; }
  @container ranking (max-width: 736px) {
    .ranking .games-table table { font-size: 12px; }
    .ranking .games-table td, .ranking .games-table thead th { padding-left: 9px; padding-right: 9px; }
    .ranking td.rankno, .ranking th.sortable.rankhead { padding-right: 3px; }
    .ranking th.col-rank    { width: 50px; }
    .ranking th.col-rankchg { width: 58px; }
    /* Not 58 like its neighbours: the LOS pill carries a min-width of its own
       that no column setting overrides, so a narrower column does not narrow
       the pill, it just lets it spill the cell. */
    .ranking th.col-los     { width: 66px; }
    .ranking th.col-loschg  { width: 58px; }
    .ranking th.col-games   { width: 54px; }
    .ranking th.col-wl      { width: 76px; }
    .ranking th.col-win     { width: 50px; }
    .ranking th.col-last    { width: 92px; }
    .ranking th.admin-col.rowacts { width: 40px; }
  }
  @container ranking (max-width: 656px) { .ranking .col-last  { display: none; } }
  @container ranking (max-width: 564px) { .ranking .col-win   { display: none; } }
  @container ranking (max-width: 514px) { .ranking .col-wl    { display: none; } }
  @container ranking (max-width: 438px) { .ranking .col-games { display: none; } }
  /* Past the last drop there is nothing left to remove — what remains is who,
     where, and both movements — so the floor tightens the survivors instead.
     Without this the name, being the column that takes the remainder, is the
     one thing that shrinks, and on the narrowest phone in admin mode (where the
     row-actions column costs another 40px) it reached zero: the one outcome
     this whole block exists to prevent. */
  @container ranking (max-width: 380px) {
    .ranking .games-table td, .ranking .games-table thead th { padding-left: 7px; padding-right: 7px; }
    .ranking th.col-rank    { width: 42px; }
    .ranking th.col-rankchg { width: 50px; }
    /* The LOS pill and the row-actions button have widths of their own that no
       column setting overrides; squeezed below them they simply overflow the
       cell. These two are what they actually measure. */
    .ranking th.col-los     { width: 64px; }
    .ranking th.col-loschg  { width: 50px; }
    .ranking th.admin-col.rowacts { width: 40px; }
  }
  .games-table td { padding: 9px 14px; }
  .games-table thead th { padding: 9px 14px; }
  /* Pills inside the compact tables lose their vertical padding so every row
     (ranking, player games, game rosters aside) is the same height as /games. */
  .games-table .pill { padding: 0 10px; line-height: 1.35; }
  /* A game row is a real link: the start time is an <a> whose ::after is
     stretched over the whole row, so a click, ctrl/cmd/shift/middle click,
     right-click "open in new tab", copy link and the hover URL all work anywhere
     on the row, natively. What else in the row is interactive or has a tooltip
     (player names, OTL/BAR/replay, the actions menu, badges, rank emblems) is
     lifted above the overlay and keeps its own behaviour. */
  tr.game-row { cursor: pointer; position: relative; }
  tr.game-row a.row-link { color: inherit; text-decoration: none; }
  tr.game-row a.row-link::after { content: ""; position: absolute; inset: 0; z-index: 1; }
  tr.game-row a:not(.row-link), tr.game-row button, tr.game-row [title] { position: relative; z-index: 2; }
  tr.game-row .hint.pill-hint { z-index: 2; }
  tr.game-row td.when { color: #c7ccd1; white-space: nowrap; }
  tr.game-row td.dur { color: #8a929c; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  /* The LOS cell is a fixed 3-slot grid — LOS | vs | LOS — so both numbers sit at
     the same x in every row; the header centres over the same grid. Every number
     wears the pill's padding, and only the winner's is outlined (gold ring). */
  tr.game-row td.los, thead th.los { width: 1%; white-space: nowrap; }
  thead th.los { text-align: center; }
  tr.game-row td.los {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    display: grid; grid-template-columns: 4.2em 1.6em 4.2em;
    align-items: center; justify-items: center;
  }
  tr.game-row td.los .n {
    display: inline-block; min-width: 4em; text-align: center;
    padding: 0 6px; border-radius: 9px; line-height: 1.35;
  }
  /* The winner's ring: a gold pill-shaped outline, text keeps its team colour. */
  tr.game-row td.los .n.win {
    font-weight: 700;
    box-shadow: 0 0 0 1px #e3b53a, 0 0 5px rgba(227, 181, 58, .3);
  }
  tr.game-row td.los .vs, td.roster .vs { color: #6b7480; font-family: inherit; font-size: 11px; }
  td.roster .vs { padding: 0 5px; }
  tr.game-row td.pct { color: #c7ccd1; width: 1%; }
  tr.game-row td.result, tr.game-row td.rating, tr.game-row td.delta { width: 1%; }
  tr.game-row td.pct .expected { color: #6b7480; }
  /* An unlikely result, in the page's own W/L colours: green when the player pulled
     it off, red when it went against them. The games table shows the WINNER's chance,
     so only the green one ever comes up there. Weight is its own class because the
     player page bolds only the really unlikely results (under 20%). */
  tr.game-row td.pct .upset { color: #4ee06a; }
  tr.game-row td.pct .upset-bad { color: #e06c6c; }
  tr.game-row td.pct .strong { font-weight: 700; }
  /* The (?) in the "%" header: pop the tip to the right, so it isn't clipped at the
     left edge of the (narrow) column. */
  thead th .hint { vertical-align: middle; margin-left: 2px; }
  thead th .hint .hint-tip { left: 0; right: auto; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  td.roster { width: 100%; white-space: normal; }
  td.roster .more { color: #8a929c; }
  td.links { white-space: nowrap; text-align: right; }
  td.links a, .ext a { color: #4d9fff; text-decoration: none; font-weight: 700; margin-left: 10px; }
  td.links a:hover, .ext a:hover { text-decoration: underline; }
  /* The barreplay slot: a "replay" link, an hourglass, or nothing at all. In a
     table all three take a fixed width, so the OTL/BAR pair stays put down the
     column instead of shifting on every row that happens to have a replay. */
  td.links .replay, .ext .replay { display: inline-block; margin-left: 10px; }
  td.links .replay { min-width: 44px; text-align: right; }
  /* On the player page the slot is the cell's only content (no OTL/BAR), so it
     sits flush against the right edge like every other column there. */
  td.links .replay:first-child { margin-left: 0; }
  td.links .replay.pending, .ext .replay.pending { color: #8a929c; cursor: help; }
  .badge.ignored { background: #3a2f1f; color: #d9a44a; }
  /* An admin marked this game ignored. Orange like the ranking's "private"
     badge — both say "somebody took this off the list", as against the
     .badge.ignored gray-gold of a game the fold itself never rated. */
  .badge.excluded { background: #2c2418; border: 1px solid #6b4a1f; color: #f0a35c; }
  /* ...and the marker has not reached the ratings yet (needsRebase). */
  .badge.excluded .pend { opacity: .75; font-weight: 400; }
  .badge.won { background: #1d3325; color: #5cc274; }
  /* Game page: the facts row under the matchup strip. */
  .facts { display: flex; flex-wrap: wrap; gap: 8px 26px; padding: 12px 16px 14px; }
  .facts .stat .k { font-size: 11px; color: #7a828c; }
  .facts .stat .v { font-size: 14px; font-weight: 700; color: #e6e9ec; white-space: nowrap; }
  .facts .stat .v.plain { font-weight: 400; color: #c7ccd1; }
  .team h3 .who { display: flex; align-items: center; gap: 8px; }
  .team h3 .trophy { font-size: 15px; }
  td.delta { text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
  /* The "→ LOS after" suffix. A fixed slot (wide enough for the longest value)
     so the delta beside it always starts in the same place, whatever the suffix
     is — or whether there is one at all. */
  td.delta .after {
    color: #6b7480; margin-left: 6px; font-size: 11px;
    display: inline-block; min-width: 3.7em; text-align: left;
  }
  td.name .faction { margin-left: 8px; font-size: 11px; color: #6b7480; font-weight: 400; }
  td.games { color: #8a929c; }

  /* ---- Scouting: OneTrickLava's play-style cards (src/scout.ts) ---- */
  /* The roster's badge strip, right of the name: icons only, the caption on hover. */
  .scout-icons { margin-left: 6px; font-size: 12px; letter-spacing: 1px; cursor: help; white-space: nowrap; }
  .arch {
    display: inline-block; padding: 1px 8px; border-radius: 9px; font-size: 11px; font-weight: 600;
    background: #1b2230; border: 1px solid #2a3446; color: #9fb4d6; white-space: nowrap;
  }
  .arch + .arch { margin-left: 4px; }
  .wr.hi { color: #5cc274; }
  .wr.lo { color: #e06c6c; }
  .wr.mid { color: #c7ccd1; }
  /* The lobby's scouting report, between the rosters and the foot lines. */
  .scout-report { margin: 0 16px 14px; border: 1px solid #20242c; border-radius: 8px; background: #10131a; overflow: hidden; }
  .scout-report > h3 {
    margin: 0; padding: 10px 14px; font-size: 14px; color: #e6e9ec; font-weight: 600;
    background: #161a21; border-bottom: 1px solid #20242c;
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  }
  .scout-report > h3 .sub { font-weight: 400; font-size: 12px; color: #7a828c; }
  .scout-report > h3 a.more { margin-left: auto; color: #4d9fff; text-decoration: none; font-size: 12px; font-weight: 600; }
  .scout-report > h3 a.more:hover { text-decoration: underline; }
  table.lanes { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.lanes td, table.lanes th { padding: 6px 12px; border-bottom: 1px solid #1a1e25; }
  table.lanes tr:last-child td { border-bottom: 0; }
  table.lanes th { color: #7a828c; font-weight: 600; font-size: 11px; text-align: left; }
  table.lanes td.lane, table.lanes th.lane { text-align: center; white-space: nowrap; width: 1%; }
  table.lanes td.lane { color: #c7ccd1; font-weight: 700; }
  table.lanes.mirror td.pick.left, table.lanes.mirror th.left { text-align: right; }
  table.lanes .pk a { text-decoration: none; font-weight: 700; }
  table.lanes .pk a:hover { text-decoration: underline; }
  table.lanes .pk .share { color: #7a828c; font-size: 11px; margin: 0 6px; }
  table.lanes .pk .wr { font-size: 11px; font-weight: 700; }
  table.lanes .none { color: #4a525c; }
  /* Both sides' expected players MAIN this lane: the matchup to watch. */
  table.lanes tr.clash td.lane { color: #f0a35c; }
  table.lanes .edge { color: #e3b53a; margin: 0 3px; }
  .scout-teams { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); border-top: 1px solid #20242c; }
  .scout-team { padding: 10px 14px; font-size: 12px; color: #9aa3ad; display: flex; flex-direction: column; gap: 6px; }
  .scout-team + .scout-team { border-left: 1px solid #1a1e25; }
  .scout-team .k { color: #7a828c; font-weight: 600; margin-right: 6px; }
  .scout-team .k.tc0 { color: #5b8cff; }
  .scout-team .k.tc1 { color: #ff5f52; }
  /* A scouted player with no warning badge: a quiet marker, the card on hover. */
  .scout-icons.plain { opacity: .55; }
  .lanes-wrap { overflow-x: auto; }
  @media (max-width: 560px) {
    table.lanes .pk .share { display: none; }
    table.lanes td, table.lanes th { padding: 5px 6px; }
  }
  .scout-team .threat { display: block; }
  .scout-team .threat b { color: #e6e9ec; }
  .scout-foot { padding: 7px 14px; font-size: 11px; color: #6b7480; border-top: 1px solid #1a1e25; }
  /* Player page: the play-style card. */
  .style-body { padding: 12px 16px 16px; display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px 28px; }
  .style-body h4 { margin: 0 0 8px; font-size: 11px; color: #7a828c; text-transform: uppercase; letter-spacing: .06em; }
  .style-body .archs { display: flex; flex-wrap: wrap; gap: 6px; }
  .style-body .archs .arch + .arch { margin-left: 0; }
  .badge-line { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 8px; font-size: 12px; }
  .badge-line .ic { font-size: 18px; line-height: 1; }
  .badge-line b { color: #e6e9ec; display: block; }
  .badge-line span { color: #9aa3ad; }
  .lane-row { display: grid; grid-template-columns: 7.5em 1fr 3.5em 3.5em; align-items: center; gap: 8px; font-size: 12px; margin-bottom: 5px; }
  .lane-row .ln { color: #c7ccd1; font-weight: 600; white-space: nowrap; }
  .lane-row .g { color: #7a828c; text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .lane-row .wr { text-align: right; font-weight: 700; }
  .bar { height: 7px; background: #1d2129; border-radius: 4px; overflow: hidden; }
  .bar > span { display: block; height: 100%; background: #2f6df6; border-radius: 4px; }
  .bar.warm > span { background: #e0793a; }
  .trait-row { display: grid; grid-template-columns: 7.5em 1fr 4.5em; align-items: center; gap: 8px; font-size: 12px; margin-bottom: 5px; }
  .trait-row .tn { color: #9aa3ad; }
  .trait-row .tv { color: #c7ccd1; text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .kv { display: flex; flex-wrap: wrap; gap: 6px 22px; font-size: 12px; }
  .kv .k { color: #7a828c; display: block; font-size: 11px; }
  .kv .v { color: #e6e9ec; font-weight: 700; }
  .src-note { padding: 8px 16px; border-top: 1px solid #20242c; font-size: 11px; color: #6b7480; background: #14171d; }
  /* Scouting page boards. */
  .kings { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0; }
  .king { padding: 10px 14px; border-bottom: 1px solid #1a1e25; border-right: 1px solid #1a1e25; font-size: 12px; }
  .king h4 { margin: 0 0 6px; font-size: 12px; color: #e6e9ec; }
  .king ol { margin: 0; padding-left: 18px; color: #9aa3ad; }
  .king li { margin: 2px 0; }
  .king li a { color: #c7ccd1; text-decoration: none; font-weight: 600; }
  .king li a:hover { color: #7fbaff; text-decoration: underline; }
  .danger { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; color: #f0a35c; }
`;

// The attribution popup markup shared by both pages' headers.
const HELP_POP = /* html */ `
  <button class="help" id="helpBtn" type="button" aria-label="About" aria-expanded="false">?</button>
  <div class="help-pop" id="helpPop" hidden>
    Icons by IceXuick for
    <a href="https://github.com/beyond-all-reason/BYAR-Chobby/tree/master/LuaMenu/images/ranks"
       target="_blank" rel="noopener noreferrer">Beyond All Reason</a>
    · licensed
    <a href="https://creativecommons.org/licenses/by-nc-nd/4.0/"
       target="_blank" rel="noopener noreferrer">CC BY-NC-ND</a>
  </div>
`;

/**
 * The left menu, shared by every page. "Lobby" opens the FIRST open lobby (GET /
 * redirects there); any other lobby opens by id in the URL (/lobby/:id — the
 * detail endpoint serves every open battle, not just the configured lava set).
 * `active` highlights the current item; the Lobby link's href is rewritten
 * client-side to carry ?src=/?all= (SHARED_JS). The SQL entry is admin-only:
 * hidden by CSS unless SHARED_JS found admin mode and marked <body>.
 */
const sidebar = (active: "lobby" | "ranking" | "games" | "scouting" | "polls" | "doesitwork" | "sql" | "bot" | "login") => /* html */ `
<nav class="side">
  <a class="brand" href="/">🌋 lavabalance</a>
  <a class="nav navLobby${active === "lobby" ? " active" : ""}" href="/">🛋️ Lobby</a>
  <a class="nav${active === "ranking" ? " active" : ""}" href="/ranking">🏆 Ranking</a>
  <a class="nav${active === "games" ? " active" : ""}" href="/games">🎮 Games</a>
  <a class="nav${active === "scouting" ? " active" : ""}" href="/scouting">🔭 Scouting</a>
  <a class="nav${active === "polls" ? " active" : ""}" href="/polls">🗳️ Polls</a>
  <a class="nav${active === "doesitwork" ? " active" : ""}" href="/does-it-work">🧪 Does it work?</a>
  <a class="nav admin${active === "bot" ? " active" : ""}" href="/bot">🤖 Bot</a>
  <a class="nav admin${active === "sql" ? " active" : ""}" href="/sql">🗄️ SQL</a>
</nav>`;

// Shared client-side helpers used by all pages: HTML escaping, LOS bands/pills,
// rank icons, team grouping, and the ?src= propagation. Inlined into each page's
// <script>.
const SHARED_JS = /* js */ `
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---- Party pills (lobby page + game page) ----
// A party is keyed by the colour Teiserver shows for it; the parties map takes
// that key to its number ("party 1", "party 2", … in order of appearance).
function partyPill(p, parties) {
  if (!p.party || !parties.has(p.party)) return "";
  const n = parties.get(p.party);
  // The key IS the colour Teiserver shows for this party. Only a plain hex value
  // may reach the style attribute; anything else falls back to the neutral gray.
  const hex = /^#[0-9a-fA-F]{6}$/.test(p.party) ? p.party : null;
  const c = hex || "#9aa3ad";
  const bg = hex ? hex + "24" : "transparent";
  return '<span class="party-pill" style="color:' + c + ';border-color:' + c +
    ';background:' + bg + '" title="party ' + n + ' (colour as shown by Teiserver)">' +
    '<span class="pword">party </span>' + n + '</span>';
}

// ---- Scouting (OneTrickLava play-style cards, src/scout.ts) ----
// A 0..1 fraction as a whole percentage; "?" for an unknown.
function pctTxt(f) {
  return f == null ? "?" : Math.round(f * 100) + "%";
}
// A win rate's colour: green from 55%, red under 45%.
function wrClass(f) {
  return f == null ? "mid" : f >= 0.55 ? "hi" : f < 0.45 ? "lo" : "mid";
}
// Seconds as m:ss.
function fmtMinSec(sec) {
  if (sec == null) return "?";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ":" + (s < 10 ? "0" : "") + s;
}
// The badge icons with their captions as the tooltip (roster rows, boards).
function scoutIcons(badges) {
  if (!badges || !badges.length) return "";
  const tip = badges.map((b) => b.label + (b.caption ? " — " + b.caption : "")).join("\\n");
  return '<span class="scout-icons" title="' + esc(tip) + '">' +
    badges.map((b) => esc(b.icon || "•")).join("") + "</span>";
}
function archChips(list) {
  return (list || []).map((a) => '<span class="arch">' + esc(a) + "</span>").join("");
}

// LOS band → pill color. LOS is on BAR's shown-OS scale (max(mu − sigma, 0)): a
// debutant sits around 16.7, the lobby's top players in the 30s-40s.
function ratingClass(r) {
  if (r >= 30) return "blue";
  if (r >= 20) return "green";
  if (r >= 12) return "orange";
  return "gray";
}

// LOS shown with one decimal everywhere (pills, averages, the gap).
function fmtLos(v) {
  return Number(v).toFixed(1);
}

// LOS assumed for a player with no rated lava game: a debutant's effective rating
// (mu 25 minus the game-0 rookie handicap of 13, minus sigma 8.33). Matches
// UNRATED_LOS in src/lobbyView.ts, which uses the exact value for the
// server-computed averages.
const UNRATED_LOS = 3.7;
function effectiveRating(p) {
  return p.los != null ? p.los : UNRATED_LOS;
}

// ---- Rank emblems (src/los/tiers.ts) ----
// What a visitor sees in place of LOS: one detailed SVG per tier, drawn from
// shared parts (a chamfered chrome plate around a dark textured core, wing
// blades that grow with the tier, the tier's insignia). Below 32 px the fine
// detail (texture, rivets, embers) is dropped so the shape stays readable.
const TIER_INFO = {
  // Dark matte gunmetal, so it never reads as Silver.
  placing:  { name: "Placing",  m: ["#7b828a", "#4b5259", "#2a2f35", "#5d646c", "#121417"], tint: "#15181c", wings: 0 },
  bronze:   { name: "Bronze",   m: ["#ffd6a8", "#c98544", "#7a3f16", "#e3a265", "#3a1c08"], tint: "#2a1c13", wings: 1 },
  silver:   { name: "Silver",   m: ["#ffffff", "#cfd6de", "#7e8893", "#eef2f6", "#3c434b"], tint: "#1d2024", wings: 2 },
  gold:     { name: "Gold",     m: ["#fff6c2", "#f3c53a", "#a26c06", "#ffe07a", "#4f3203"], tint: "#2a2210", wings: 3, tip: "#ffd84a" },
  platinum: { name: "Platinum", m: ["#f0fffc", "#a6eae0", "#3a8f87", "#d4fbf5", "#163f3b"], tint: "#0f2a2b", wings: 3, tip: "#7ff3e4" },
  diamond:  { name: "Diamond",  m: ["#eef6ff", "#9fc8ff", "#3f6fd8", "#cfe4ff", "#152a6e"], tint: "#0c1f4d", wings: 4, tip: "#7fb0ff" },
};
const TIER_ORDER = ["placing", "bronze", "silver", "gold", "platinum", "diamond"];
const PLACING_GAMES = 5;
function tierName(t) { return TIER_INFO[t] ? TIER_INFO[t].name : ""; }
function tierRankIndex(t) { return t == null ? -1 : TIER_ORDER.indexOf(t); }

let emblemSeq = 0;
const EMB_FRAME = "M94 26 L146 26 L180 56 L180 118 L120 186 L60 118 L60 56 Z";
function embScale(s) { return 'transform="translate(120 108) scale(' + s + ') translate(-120 -108)"'; }
function embGrad(id, stops) {
  return '<linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' + stops.map(function (s) {
    return '<stop offset="' + s[0] + '" stop-color="' + s[1] + '"' + (s[2] != null ? ' stop-opacity="' + s[2] + '"' : '') + '/>';
  }).join("") + '</linearGradient>';
}
function embMirror(inner) {
  return '<g>' + inner + '</g><g transform="translate(240,0) scale(-1,1)">' + inner + '</g>';
}
function embWings(n, id, m, edge) {
  let o = "";
  for (let i = n - 1; i >= 0; i--) {
    const a = -20 + i * 15, L = 74 - i * 11;
    o += '<g transform="translate(160 132) rotate(' + a + ')">' +
      '<path d="M0 -8 L' + (L * .72) + ' -10 L' + L + ' -1 L' + (L * .66) + ' 7 L0 8 Z" fill="url(#' + id + 'w)" stroke="' + edge + '" stroke-width="1.6" stroke-linejoin="round"/>' +
      '<path d="M2 -6.5 L' + (L * .72) + ' -8.4 L' + (L - 3) + ' -1.2" fill="none" stroke="' + m[0] + '" stroke-width="1.3"/>' +
      '<path d="M4 0.5 L' + (L * .8) + ' 0" stroke="' + edge + '" stroke-opacity=".55" stroke-width="1"/></g>';
  }
  return embMirror(o);
}
function embCrest(id, edge, m, h) {
  function sp(x, y0, ht, w) {
    return '<path d="M' + (x - w) + ' ' + y0 + ' L' + x + ' ' + (y0 - ht) + ' L' + (x + w) + ' ' + y0 + ' Z" fill="url(#' + id + 'w)" stroke="' + edge + '" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<path d="M' + x + ' ' + (y0 - ht + 3) + ' L' + x + ' ' + (y0 - 2) + '" stroke="' + m[0] + '" stroke-width="1.2"/>';
  }
  return sp(120, 30, 26 * h, 13) + sp(98, 32, 16 * h, 9) + sp(142, 32, 16 * h, 9);
}
function embChevron(y, id, edge, m) {
  const w = 34;
  const d = 'M' + (120 - w) + ' ' + y + ' L120 ' + (y + w * .55) + ' L' + (120 + w) + ' ' + y + ' L' + (120 + w) + ' ' + (y + 11) +
    ' L120 ' + (y + 11 + w * .55) + ' L' + (120 - w) + ' ' + (y + 11) + ' Z';
  return '<path d="' + d + '" transform="translate(0 3)" fill="#000" fill-opacity=".6"/>' +
    '<path d="' + d + '" fill="url(#' + id + 'g)" stroke="' + edge + '" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<path d="M' + (122 - w) + ' ' + (y + 2) + ' L120 ' + (y + w * .55 + 2) + ' L' + (118 + w) + ' ' + (y + 2) + '" fill="none" stroke="' + m[0] + '" stroke-width="1.4"/>';
}
function embGem(cx, cy, s) {
  function P(x, y) { return (cx + x * s).toFixed(1) + "," + (cy + y * s).toFixed(1); }
  function f(pts, c) {
    return '<polygon points="' + pts.map(function (p) { return P(p[0], p[1]); }).join(" ") + '" fill="' + c + '" stroke="#0d1d5c" stroke-width=".8" stroke-linejoin="round"/>';
  }
  const S = ["#f2f8ff", "#a9cdff", "#5b8cf2", "#cfe3ff", "#2747b3", "#7fb0ff"];
  return f([[-26, -6], [-14, -18], [14, -18], [26, -6], [0, 32]], S[4]) +
    f([[-14, -18], [14, -18], [8, -8], [-8, -8]], S[0]) + f([[-14, -18], [-8, -8], [-26, -6]], S[1]) + f([[14, -18], [26, -6], [8, -8]], S[3]) +
    f([[-26, -6], [-8, -8], [0, -6]], S[5]) + f([[26, -6], [0, -6], [8, -8]], S[1]) + f([[-8, -8], [8, -8], [0, -6]], S[3]) +
    f([[-26, -6], [0, -6], [-9, 8]], S[2]) + f([[0, -6], [26, -6], [9, 8]], S[4]) + f([[-26, -6], [-9, 8], [0, 32]], S[5]) +
    f([[-9, 8], [0, -6], [9, 8], [0, 32]], S[1]) + f([[9, 8], [26, -6], [0, 32]], S[2]) +
    '<path d="M' + P(-11, -15) + ' L' + P(-5, -10) + '" stroke="#fff" stroke-width="2" stroke-linecap="round"/>' +
    '<path transform="translate(' + (cx + 12 * s) + ' ' + (cy - 16 * s) + ')" fill="#fff" d="M0 -9 L1.6 -1.6 L9 0 L1.6 1.6 L0 9 L-1.6 1.6 L-9 0 L-1.6 -1.6 Z"/>';
}
function embFlame(id, edge, m) {
  const outer = "M120 58 C130 74 148 86 146 110 C145 128 134 142 120 144 C106 142 95 128 94 110 C93 96 102 88 106 76 C110 86 114 90 117 92 C115 80 116 68 120 58 Z";
  const inner = "M121 92 C128 102 136 110 134 122 C133 131 127 136 120 137 C113 136 107 130 107 122 C107 114 112 110 114 104 C116 109 118 111 119 112 C118 104 118 98 121 92 Z";
  return '<path d="' + outer + '" transform="translate(0 3)" fill="#000" fill-opacity=".6"/>' +
    '<path d="' + outer + '" fill="url(#' + id + 'g)" stroke="' + edge + '" stroke-width="1.6"/>' +
    '<path d="M118 64 C116 74 116 82 117 90" fill="none" stroke="' + m[0] + '" stroke-width="1.3"/>' +
    '<path d="' + inner + '" fill="url(#' + id + 'c2)" stroke="' + edge + '" stroke-width="1.2"/>' +
    '<path d="M112 118 C112 126 116 131 121 132" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="1.4" stroke-linecap="round"/>';
}
const EMB_CRACKS = ["M78 74 L94 88 L90 104 L104 116", "M164 72 L148 88 L154 102 L138 114",
  "M100 168 L110 150 L104 138 L116 128", "M142 166 L132 150 L138 138 L126 128"];

// The emblem SVG. opts: size (px).
function rankEmblem(tier, opts) {
  const t = TIER_INFO[tier];
  if (!t) return "";
  opts = opts || {};
  const size = opts.size || 24;
  const compact = size < 32;
  const m = t.m, edge = m[4], id = "emb" + (emblemSeq++);
  const defs = [
    embGrad(id + "f", [[0, m[0]], [.3, m[1]], [.48, m[2]], [.52, m[4]], [.6, m[3]], [1, m[2]]]),
    embGrad(id + "f2", [[0, m[4]], [.45, m[2]], [1, m[0]]]),
    embGrad(id + "w", [[0, m[0]], [.45, m[1]], [.55, m[2]], [1, m[3]]]),
    embGrad(id + "g", [[0, m[0]], [.42, m[3]], [.5, m[1]], [.58, m[2]], [1, m[1]]]),
    embGrad(id + "h", [[0, "#fff", .85], [.35, "#fff", 0]]),
    embGrad(id + "c2", [[0, "#ffffff"], [1, m[1]]]),
    '<radialGradient id="' + id + 'c" cx=".5" cy=".3" r=".8"><stop offset="0" stop-color="' + t.tint + '"/><stop offset=".7" stop-color="#0b0c0e"/><stop offset="1" stop-color="#000"/></radialGradient>',
    '<clipPath id="' + id + 'k"><path d="' + EMB_FRAME + '" ' + embScale(.74) + '/></clipPath>',
  ];
  if (!compact) {
    defs.push('<filter id="' + id + 'n" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="7"/>' +
      '<feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .55 -.18"/><feComposite in2="SourceGraphic" operator="in"/></filter>');
    defs.push('<filter id="' + id + 'b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>');
    defs.push('<filter id="' + id + 's" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3.5"/></filter>');
  }
  let back = "", front = "";
  if (tier === "diamond" && !compact) {
    back += '<ellipse cx="120" cy="112" rx="96" ry="88" fill="#3d7bff" opacity=".35" filter="url(#' + id + 'b)"/>' +
      '<ellipse cx="120" cy="150" rx="60" ry="40" fill="#ff5a1f" opacity=".35" filter="url(#' + id + 'b)"/>';
  }
  if (tier === "platinum" || tier === "diamond") back += embCrest(id, edge, m, tier === "diamond" ? 1.25 : 1);
  if (t.wings) back += embWings(compact ? Math.min(t.wings, 2) : t.wings, id, m, edge);
  if (!compact) back += '<path d="' + EMB_FRAME + '" transform="translate(0 6)" fill="#000" opacity=".55" filter="url(#' + id + 's)"/>';

  let frame = '<path d="' + EMB_FRAME + '" fill="url(#' + id + 'f)" stroke="' + edge + '" stroke-width="2.2" stroke-linejoin="round"/>' +
    '<path d="' + EMB_FRAME + '" fill="none" stroke="url(#' + id + 'h)" stroke-width="2" ' + embScale(.985) + '/>' +
    '<path d="' + EMB_FRAME + '" ' + embScale(.86) + ' fill="url(#' + id + 'f2)" stroke="' + edge + '" stroke-width="1.4"/>' +
    '<path d="' + EMB_FRAME + '" ' + embScale(.79) + ' fill="' + m[4] + '" stroke="#000" stroke-opacity=".7" stroke-width="2"/>' +
    '<path d="' + EMB_FRAME + '" ' + embScale(.74) + ' fill="url(#' + id + 'c)"/>';
  if (!compact) frame += '<rect x="40" y="20" width="160" height="180" fill="#fff" filter="url(#' + id + 'n)" clip-path="url(#' + id + 'k)" opacity=".5"/>';
  frame += '<path d="' + EMB_FRAME + '" ' + embScale(.74) + ' fill="none" stroke="#000" stroke-width="3" stroke-opacity=".8"/>';
  if (!compact) {
    frame += '<path d="M80 136 L120 181 L160 136" ' + embScale(.74) + ' fill="none" stroke="' + m[1] + '" stroke-opacity=".6" stroke-width="1.6"/>';
    frame += [[94, 32], [146, 32], [173, 58], [67, 58], [173, 116], [67, 116]].map(function (p) {
      return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="2.4" fill="url(#' + id + 'g)" stroke="' + edge + '" stroke-width=".8"/>';
    }).join("");
  }
  if (tier === "diamond" && !compact) {
    frame += '<g clip-path="url(#' + id + 'k)" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
      '<g class="emb-crack" stroke="#ff5a1f" stroke-width="6" opacity=".5" filter="url(#' + id + 's)">' +
      EMB_CRACKS.map(function (d) { return '<path d="' + d + '"/>'; }).join("") + '</g>' +
      '<g stroke="#ffb347" stroke-width="1.8">' + EMB_CRACKS.map(function (d) { return '<path d="' + d + '"/>'; }).join("") + '</g></g>';
  }

  // Placing: no insignia at all, just the plain gunmetal plate (the "n/5"
  // count is in the label and tooltip).
  if (tier === "bronze") front += embChevron(94, id, edge, m);
  if (tier === "silver") front += embChevron(84, id, edge, m) + embChevron(106, id, edge, m);
  if (tier === "gold") front += embChevron(74, id, edge, m) + embChevron(96, id, edge, m) + embChevron(118, id, edge, m);
  if (tier === "platinum") front += embFlame(id, edge, m);
  if (tier === "diamond") {
    if (!compact) front += '<circle cx="120" cy="104" r="30" fill="#6fa4ff" opacity=".45" filter="url(#' + id + 's)"/>';
    front += embGem(120, 102, compact ? 1.3 : 1.2);
    if (!compact) {
      front += [[96, 150, 0], [146, 144, 1.3], [120, 162, 2.2], [106, 134, 2.9]].map(function (e) {
        return '<circle class="emb-ember" style="animation-delay:' + e[2] + 's" cx="' + e[0] + '" cy="' + e[1] + '" r="1.7" fill="#ffc06a"/>';
      }).join("");
    }
  }
  if (t.tip) {
    front += '<path d="M120 170 L129 180 L120 194 L111 180 Z" fill="' + t.tip + '" stroke="' + edge + '" stroke-width="1.5"/>' +
      '<path d="M120 172 L125 179 L120 179 Z" fill="#fff" opacity=".8"/>';
  }
  const gloss = tier === "placing" ? "" :
    '<path d="M60 56 L94 26 L146 26 L180 56 L180 70 C150 60 90 60 60 76 Z" fill="#fff" opacity=".12" clip-path="url(#' + id + 'k)"/>';
  const h = Math.round(size * 230 / 240);
  return '<svg class="emblem" viewBox="0 0 240 230" width="' + size + '" height="' + h + '" aria-hidden="true">' +
    '<defs>' + defs.join("") + '</defs>' + back + frame + gloss + front + '</svg>';
}

// The tier as a reader sees it: "Placing 2/5", or the tier's name.
function tierLabel(tier, games) {
  if (tier === "placing") return "Placing " + Math.min(games || 0, PLACING_GAMES) + "/" + PLACING_GAMES;
  return tierName(tier);
}

// An emblem with its name as the tooltip (opts.text: the name beside it too).
// A player LOS has never rated is placing at 0 games.
function rankBadge(tier, games, opts) {
  opts = opts || {};
  if (tier == null) return "";
  const label = tierLabel(tier, games);
  return '<span class="rank-badge' + (opts.text ? " with-text" : "") + '" title="' + esc(label) + '">' +
    rankEmblem(tier, { size: opts.size || 24 }) +
    (opts.text ? '<span class="rank-name tier-' + tier + '">' + esc(label) + '</span>' : '') +
  '</span>';
}

// Group a lobby's non-spectator players by ally team, returning [allyKey, players][]
// sorted by ally number.
function teamsOf(l) {
  const teams = new Map();
  for (const p of l.players) {
    if (p.spectator) continue;
    if (!teams.has(p.ally)) teams.set(p.ally, []);
    teams.get(p.ally).push(p);
  }
  return [...teams.keys()].sort((a, b) => a - b).map((a) => [a, teams.get(a)]);
}

// Mean team LOS. PREFERS the server's aggregate for this ally team (teamStats) — it
// also carries the OpenSkill win probability, which only the server can compute (it
// needs every player's mu/sigma, not just the shown LOS). The local computation is
// the fallback for a response without stats (then there is no win probability).
function teamAvg(players, stat) {
  // LOS is admin-only: a visitor's response carries no averages (and no LOS to
  // average), only the win chance.
  if (!ADMIN_MODE) {
    if (!players.length) return null;
    return { exact: null, winProb: stat && stat.winProb != null ? stat.winProb : null };
  }
  if (stat && stat.avg != null) {
    return {
      exact: stat.avg,
      winProb: stat.winProb != null ? stat.winProb : null,
    };
  }
  if (!players.length) return null;
  let sum = 0;
  for (const p of players) sum += effectiveRating(p);
  return { exact: sum / players.length, winProb: null };
}

// Average team LOS for the team-header badge. (Unrated players are explained per
// row by their own assumed-debutant pill hint, so the average needs no (?) here.)
function teamAvgBadge(players, stat) {
  const t = teamAvg(players, stat);
  if (!t || t.exact == null) return "";
  return '<span class="avg">' +
    '<span class="pill ' + ratingClass(t.exact) + '">Avg ' + fmtLos(t.exact) + '</span></span>';
}

// ---- Head-to-head odds ----
//
// The win probability is NOT recomputed here: it comes from the server's teamStats
// (OpenSkill predictWin over every player's mu/sigma, rookie handicap included — the
// same predictor the LOS fold is calibrated with). The strip just prints it.

// One side of the matchup strip: team name + average LOS on top, then its chance to
// win (when the server sent one). The cls argument ("left"/"right") decides which way
// it's aligned, so both sides meet at the divider in the middle.
function matchupSide(label, t, cls) {
  const winLine = t.winProb != null
    ? '<div class="line"><span class="wp">' + (t.winProb * 100).toFixed(1) + '% win</span></div>'
    : '';
  return '<div class="side ' + cls + '">' +
    '<div class="line"><span class="tname">' + esc(label) + '</span>' +
      (t.exact == null ? '' : '<span class="pill ' + ratingClass(t.exact) + '">Avg ' + fmtLos(t.exact) + '</span>') + '</div>' +
    winLine +
  '</div>';
}

// The head-to-head strip drawn above both team tables: each team's average LOS and its
// win chance (from the server's teamStats — OpenSkill predictWin), with the LOS gap
// between them in the middle and a bar showing the split. Two-team lobbies only (see
// lobbyCard) — both numbers are head-to-head.
function matchupBar(teams, statFor) {
  const a = teamAvg(teams[0][1], statFor(teams[0][0]));
  const b = teamAvg(teams[1][1], statFor(teams[1][0]));
  if (!a || !b) return "";
  const gap = a.exact == null || b.exact == null ? null : Math.abs(a.exact - b.exact);
  const probbar = a.winProb != null && b.winProb != null
    ? '<div class="probbar">' +
        '<span class="a" style="width:' + (a.winProb * 100).toFixed(1) + '%"></span>' +
        '<span class="b" style="width:' + (b.winProb * 100).toFixed(1) + '%"></span>' +
      '</div>'
    : '';
  return '<div class="matchup">' +
    matchupSide("Team " + (teams[0][0] + 1), a, "left") +
    '<div class="mid">' +
      '<span class="vs">vs</span>' +
      (gap == null ? '' : '<span class="gap" title="LOS gap between the team averages">Δ ' + fmtLos(gap) + '</span>') +
    '</div>' +
    matchupSide("Team " + (teams[1][0] + 1), b, "right") +
    probbar +
  '</div>';
}

// If the page was opened with a ?src= param (e.g. ?src=rtsapi to read the public BAR API
// instead of the Dispatcher) and/or ?all=true (show every open lobby, not just the
// configured lava ones), poll /api/lobbies with the same params so the view matches the
// URL the user opened — and carry them through links between the two pages.
const PAGE_PARAMS = new URLSearchParams(location.search);
const FWD_PARAMS = new URLSearchParams();
if (PAGE_PARAMS.get("src")) FWD_PARAMS.set("src", PAGE_PARAMS.get("src"));
if (PAGE_PARAMS.get("all") === "true") FWD_PARAMS.set("all", "true");
const SHOW_ALL = FWD_PARAMS.get("all") === "true";
// SRC_QUERY says WHICH DATA we're looking at, so it belongs on the links between pages too.
const SRC_QUERY = FWD_PARAMS.toString() ? "?" + FWD_PARAMS.toString() : "";

const LOBBIES_URL = "/api/lobbies" + SRC_QUERY;

// The sidebar's Lobby link carries the same ?src=/?all= as the page, so switching
// sections keeps you on the data source you were looking at.
document.querySelectorAll("a.navLobby").forEach((a) => a.setAttribute("href", "/" + SRC_QUERY));
// So does the "View all lobbies" header button (the picker's rows link back into /lobby/:id).
document.querySelectorAll("a.viewall").forEach((a) => a.setAttribute("href", "/lobbies" + SRC_QUERY));

// Admin mode reveals the admin-only sections (the SQL page's sidebar entry and
// the rest). The Worker decides it, not the URL: it rewrites the marker below
// to true when it serves the page to a superadmin signed in with Cloudflare
// Access (src/access.ts, src/index.ts page()). The cookie rides every request,
// so navigating keeps it with nothing carried in the links. It only reveals —
// the admin routes check the cookie themselves.
const ADMIN_MODE = /*ADMIN_MODE*/false;
document.body.classList.toggle("admin-mode", ADMIN_MODE);

// The header's top-right corner: who is logged in (their name, linking to
// their player page) and a Log out button, or a Log in link to /login for a
// visitor (src/auth.ts). Drawn SYNCHRONOUSLY from localStorage — no request,
// no layout shift. The login page is what keeps it right: it saves the user
// when it logs someone in (or finds them logged in via /api/auth/me) and
// clears it on logout; the header's own Log out clears it too.
const AUTH_USER_KEY = "authUser";
function storedAuthUser() {
  try {
    const u = JSON.parse(localStorage.getItem(AUTH_USER_KEY) || "null");
    return u && typeof u.name === "string" && Number.isFinite(u.userId) ? u : null;
  } catch (e) {
    return null;
  }
}
function rememberAuthUser(user) {
  try {
    if (user) localStorage.setItem(AUTH_USER_KEY, JSON.stringify({ userId: user.userId, name: user.name }));
    else localStorage.removeItem(AUTH_USER_KEY);
  } catch (e) {
    // Storage blocked: the header just shows Log in.
  }
}
// Where to send a visitor back to once they have logged in. A page that needs
// a login (the poll's Vote button) saves itself here and goes to /login; the
// login itself finishes on the link the bot whispers, often in another tab,
// so the way back is kept in localStorage rather than in the URL. Expires
// after LOGIN_RETURN_TTL_MS so a forgotten one does not hijack a later login.
const LOGIN_RETURN_KEY = "loginReturn";
const LOGIN_RETURN_TTL_MS = 30 * 60 * 1000;
function setLoginReturn(path, label) {
  try {
    localStorage.setItem(LOGIN_RETURN_KEY, JSON.stringify({ path, label, at: Date.now() }));
  } catch (e) {}
}
function peekLoginReturn() {
  try {
    const r = JSON.parse(localStorage.getItem(LOGIN_RETURN_KEY) || "null");
    if (r && typeof r.path === "string" && r.path.charAt(0) === "/" && r.path.charAt(1) !== "/" &&
        Date.now() - r.at < LOGIN_RETURN_TTL_MS) return r;
  } catch (e) {}
  return null;
}
function takeLoginReturn() {
  const r = peekLoginReturn();
  try { localStorage.removeItem(LOGIN_RETURN_KEY); } catch (e) {}
  return r;
}
function renderAuthBox() {
  const header = document.querySelector("header.top");
  if (!header) return;
  let box = header.querySelector(".authbox");
  if (!box) {
    box = document.createElement("span");
    box.className = "authbox";
    header.appendChild(box);
  }
  const user = storedAuthUser();
  if (!user) {
    box.innerHTML = '<a class="authbtn" href="/login">\u{1F511} Log in</a>';
    return;
  }
  box.innerHTML = '<a class="who" href="/player/' + encodeURIComponent(user.userId) + '" title="logged in as ' +
    esc(user.name) + '">\u{1F464} ' + esc(user.name) + '</a><button type="button" class="authbtn">Log out</button>';
  box.querySelector("button").addEventListener("click", async (ev) => {
    ev.target.disabled = true;
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      rememberAuthUser(null);
      location.reload();
    }
  });
}
renderAuthBox();

// The superadmin login (Cloudflare Access, src/access.ts) at the bottom of the
// sidebar — for the site owner only. Hardcoded on purpose: the entry is shown
// when the BAR account logged in here is huk123 (or the page is already in
// admin mode, so the sign-out is reachable); nobody else sees it. It only
// hides a link: the Access login and every admin check stand on their own.
const SUPERADMIN_NAME = "huk123";
(function adminEntry() {
  const nav = document.querySelector("nav.side");
  const user = storedAuthUser();
  const owner = user && user.name.toLowerCase() === SUPERADMIN_NAME;
  if (!nav || !(owner || ADMIN_MODE)) return;
  const a = document.createElement("a");
  a.className = "nav adminentry";
  if (ADMIN_MODE) {
    a.href = "/admin/logout";
    a.title = "Signed in as admin (Cloudflare Access). Click to sign out.";
    a.textContent = "\u{1F6E1}\uFE0F Admin \u00B7 sign out";
  } else {
    a.href = "/admin/login?next=" + encodeURIComponent(location.pathname + location.search);
    a.textContent = "\u{1F6E1}\uFE0F Login as admin";
  }
  nav.appendChild(a);
})();

// In admin mode the LOS reads ask for the hidden profiles too
// (?includePrivate=true — see src/los/index.ts): the ranking lists them, and a
// private player's page serves its rating instead of the "private" notice.
// Anything a normal visitor fetches leaves the flag off and gets the filtered
// view. Adds & or ? as the URL needs.
function withAdmin(url) {
  if (!ADMIN_MODE) return url;
  return url + (url.indexOf("?") >= 0 ? "&" : "?") + "includePrivate=true";
}

// Hints inside a card that CLIPS its content (the team cards are overflow:hidden
// for their rounded corners) would have a bottom-row tooltip cut off at the card
// edge. So on hover, pin the tooltip to the viewport: position:fixed escapes
// every ancestor clip (these markers deliberately carry no transform, which
// would re-capture fixed descendants), and flip it above the marker when there
// is no room below. Delegated, so it survives every re-render.
document.addEventListener("mouseover", (e) => {
  const hint = e.target && e.target.closest ? e.target.closest(".hint.pill-hint") : null;
  if (!hint) return;
  const tip = hint.querySelector(".hint-tip");
  if (!tip) return;
  const r = hint.getBoundingClientRect();
  tip.style.position = "fixed";
  tip.style.right = (document.documentElement.clientWidth - r.right) + "px";
  tip.style.top = "";
  tip.style.bottom = "";
  const below = document.documentElement.clientHeight - r.bottom - 5;
  if (tip.offsetHeight > below) tip.style.bottom = (document.documentElement.clientHeight - r.top + 5) + "px";
  else tip.style.top = (r.bottom + 5) + "px";
});

// ---- Game helpers (games list + game page) ----
function playerHref(userId) {
  return "/player/" + encodeURIComponent(userId);
}
function gameHref(id) {
  return "/game/" + encodeURIComponent(id);
}
// The same replay id names the game on onetricklava (the lava community's own
// index, where the scraper discovers games) and on the official BAR replay site.
function otlHref(id) {
  return "https://onetricklava.com/games/" + encodeURIComponent(id);
}
function barHref(id) {
  return "https://www.beyondallreason.info/replays?gameId=" + encodeURIComponent(id);
}
// barreplay (the sibling deployment) plays the game back in the browser, keyed
// by the same id again. Only for games it actually HAS — see replaySlot.
function replayHref(id) {
  return "https://replay.fogofwar.dev/replays/" + encodeURIComponent(id);
}
// "1 Sept, 21:05" in the viewer's local time.
function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function fmtDur(ms) {
  return Math.round(Number(ms || 0) / 60000) + "m";
}
// A team's pre-game average LOS, or null for an ignored game (no ratings) / an
// empty team. Served by the API (WireGame.avgLosBefore) rather than averaged
// here, because a private player's entry arrives with its rating blanked: an
// average taken from what we can see would drop them silently, and the gap
// between a 7-man mean here and an 8-man mean elsewhere would give the hidden
// rating away exactly. The local fallback is for a response predating the field.
function teamAvgLos(g, i) {
  if (!ADMIN_MODE) return null; // LOS is admin-only; a visitor's games carry none
  const served = g.avgLosBefore;
  if (served && served[i] !== undefined) return served[i];
  const vals = (g.teams[i] || []).map((p) => p.losBefore).filter((v) => v != null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
// Strongest first, so a truncated roster shows the names that matter.
function byLosDesc(team) {
  // A visitor's roster carries no LOS, but the API serves each team already in
  // LOS order, so a visitor keeps that order as it came.
  if (!ADMIN_MODE) return team.slice();
  const key = (p) => (p.losBefore ?? -1);
  return team.slice().sort((a, b) => key(b) - key(a) || a.name.localeCompare(b.name));
}

// ---- In-game player colours ----
// BAR's autocolor gadget (luarules/gadgets/game_autocolors.lua, IceXuick palette
// V6) gives a two-team game cool shades to the first team and warm shades to the
// second, in a fixed order. The lobby can't know the real in-game assignment, so
// we ASSUME the game hands them out in LOS order (strongest first) — exactly how
// these tables are sorted, so row N wears colour N. Two-team lobbies only, like
// the matchup strip; FFA / multi-team lobbies keep plain names. Past games use
// the same rule over LOS BEFORE the game (the order byLosDesc gives, which is
// also the order a visitor's copy arrives in), so a name wears the colour it
// most likely had in that game.
const TEAM_COLORS = [
  [ // First team (cool)
    "#0B3EF3", "#0CE908", "#00f5e5", "#6941f2", "#8fff94",
    "#1b702f", "#7cc2ff", "#a294ff", "#0B849B", "#689E3D",
    "#4F2684", "#2C32AC", "#6968A0", "#D8EEFF", "#3475FF",
    "#7EB900", "#4A4376", "#B7EA63", "#C4A9FF", "#37713A",
  ],
  [ // Second team (warm)
    "#FF1005", "#FFD200", "#FF6107", "#F80889", "#FCEEA4",
    "#8a2828", "#F190B3", "#C88B2F", "#B04523", "#FFBB7C",
    "#A35274", "#773A01", "#F5A200", "#BBA28B", "#971C48",
    "#FF68EA", "#DD783F", "#FFAAF3", "#764A4A", "#9F0D05",
  ],
];

// ---- Games-table cells (the /games table and the player page's recent games) ----
const SHOWN_NAMES = 3; // names listed per team before "+N"

// tint: the player's assumed in-game colour (TEAM_COLORS; only our own hex
// palette ever reaches the style attribute). tc<team> stays as the fallback.
function nameLink(p, team, highlight, tint) {
  return '<a class="tc' + team + (highlight ? ' me' : '') + '"' + (tint ? ' style="color:' + tint + '"' : '') +
    ' href="' + playerHref(p.userId) + '">' + esc(p.name) + '</a>';
}

/** The assumed in-game colour of the player at row j of team idx (LOS order). */
function teamTint(idx, j) {
  const pal = TEAM_COLORS[idx];
  return pal ? pal[j % pal.length] : null;
}

// "A, B, C +5" — the team's strongest names, the rest folded into a count. With a
// highlightId, that player leads their side and is marked (the player page).
function rosterCell(team, idx, highlightId) {
  let sorted = byLosDesc(team);
  // The colour goes with the player's LOS place, so it is fixed before the
  // highlighted player is moved to the front.
  const tint = new Map(sorted.map((p, j) => [p.userId, teamTint(idx, j)]));
  if (highlightId != null) {
    const me = sorted.filter((p) => p.userId === highlightId);
    sorted = me.concat(sorted.filter((p) => p.userId !== highlightId));
  }
  const shown = sorted.slice(0, SHOWN_NAMES)
    .map((p) => nameLink(p, idx, p.userId === highlightId, tint.get(p.userId))).join(", ");
  const more = sorted.length - SHOWN_NAMES;
  return shown + (more > 0 ? ' <span class="more">+' + more + '</span>' : "");
}

// The unrated badge's tooltip: the stored reason mapped to a sentence. Only
// known reasons interpolate (the map is the sanitizer); anything else — a
// null from a row predating the column, or a value this build has no words
// for — falls back to the generic truth.
function unratedTitle(g) {
  return {
    "off-map": "played off the rated map (not Supreme Isthmus) — stored, never rated",
    "uploaded too late": "uploaded after later games were already rated — stored, never rated",
    "start metal storage": "start metal storage was not 4000 (required from 1 Oct 2026) — stored, never rated",
    "excluded": "an admin had this game ignored when LOS was last re-run — stored, never rated",
  }[g.unrankedReason] || "stored, never rated";
}

// The badge a game an admin marked ignored wears, in place of the unrated one.
// The marker and the fold can disagree: marking a game changes no rating, so
// one that was rated before it was marked keeps its ratings until LOS is
// re-run from it — which is what "pending" says.
function excludedBadge(g) {
  const title = g.ignored
    ? "an admin ignored this game — it carries no ratings"
    : "an admin ignored this game, but it still carries the ratings it was folded with; " +
      "re-run LOS from it to drop them";
  return ' <span class="badge excluded" title="' + title + '">ignored' +
    (g.ignored ? "" : ' <span class="pend">· pending</span>') + "</span>";
}

// Whichever of the two a game has earned: an admin's ignore marker wins, since
// it also explains the unrated state it produces.
function gameBadges(g) {
  if (g.excluded) return excludedBadge(g);
  return g.ignored ? ' <span class="badge ignored" title="' + unratedTitle(g) + '">unrated</span>' : "";
}

// Both rosters — "A, B, C +5 v D, E, F +5" — plus whatever badge the game wears.
function rostersCell(g, highlightId) {
  return g.teams.map((team, i) => rosterCell(team, i, highlightId)).join('<span class="vs">v</span>') +
    gameBadges(g);
}

// "20.5 vs 22.1": each team's pre-game average LOS in its colour; the winning
// side's number is ringed by a gold pill-shaped outline. Both numbers carry the
// pill's padding (only the winner gets the ring) so they line up down the column
// whichever side won. An ignored game carries no ratings and shows dashes.
function losCell(g) {
  const avg = (i) => {
    const v = teamAvgLos(g, i);
    const won = v != null && g.winnerTeam === i;
    return '<span class="n tc' + i + (won ? " win" : "") + '">' + (v == null ? "–" : fmtLos(v)) + '</span>';
  };
  return avg(0) + '<span class="vs">vs</span>' + avg(1);
}

// A team's pre-game predicted win chance (server-computed OpenSkill predictWin, the
// same predictor the fold is calibrated with); null on ignored games, which carry
// no ratings.
function winChanceOf(g, team) {
  const pw = g.predictedWin;
  return pw && pw[team] != null ? pw[team] : null;
}

// The cell both win-chance columns render: the number is ALWAYS a win chance, the
// class is picked by the caller from whatever it wants the colour to say.
function pctSpan(pct, cls) {
  return '<span class="' + cls + '">' + pct + '%</span>';
}

// Games table: the winner's chance, so the value shown IS the chance of the result
// that happened, and every row is somebody's win — hence green only, no red.
// Coloured by how surprising it was: above 75% fades to gray (nothing to see),
// below 25% is bright green (the underdog took it), bold below 15%.
function winChanceCell(g, team) {
  const p = winChanceOf(g, team);
  if (p == null) return '<span class="muted">–</span>';
  const pct = Math.round(p * 100);
  const cls = pct > 75 ? "expected" : pct < 25 ? "upset" : "";
  return pctSpan(pct, pct < 15 ? cls + " strong" : cls);
}

// Player page: the number stays THIS player's side's win chance, but the colour
// reads the chance of the result they actually got — that same win chance when they
// won, its complement when they lost — which a colour keyed to the displayed number
// alone cannot say (a 30% loss and a 30% win are opposite stories behind identical
// text). Gray above 60% is the likely thing happening; only a real upset — under
// 25% — takes a colour, and it takes the side the player was on: green for one they
// pulled off, red for one that went against them, bold under 15%, so the handful of
// games that decided a player's rating stand out down the column.
function resultChanceCell(g, team, won) {
  const p = winChanceOf(g, team);
  if (p == null) return '<span class="muted">–</span>';
  const pct = Math.round(p * 100);
  const res = won ? pct : 100 - pct;
  const cls = res > 60 ? "expected" : res < 25 ? (won ? "upset" : "upset-bad") : "";
  return pctSpan(pct, res < 15 ? cls + " strong" : cls);
}

function winChanceHeader(label, tip) {
  return '<th class="num">' + label + ' <span class="hint">?<span class="hint-tip">' + tip + '</span></span></th>';
}

// The barreplay slot, from the game's server-resolved replay status
// (?replays=true — see src/barreplay.ts). Three states, and the third is the
// common one: a link once a replay is published, an hourglass while barreplay
// is re-simulating the game (an hour of engine time, so it is worth saying
// that it is coming), and NOTHING for a game that simply has no replay — most
// of them. In a TABLE the nothing is still a fixed-width slot (reserve), so
// the column reads straight down whichever state each row is in; in the game
// page's one-line facts row there is no column to hold open, so it is empty.
function replaySlot(g, reserve) {
  const r = g.replay;
  if (r && r.published) {
    return '<a class="replay" href="' + esc(replayHref(g.id)) + '" target="_blank" rel="noopener noreferrer" ' +
      'title="Watch this game on barreplay">replay</a>';
  }
  if (r && r.jobState === "processing") {
    return '<span class="replay pending" title="barreplay is re-simulating this game right now — ' +
      'the replay is not watchable yet. It usually takes up to an hour.">\u23f3</span>';
  }
  return reserve ? '<span class="replay none"></span>' : "";
}

// The player page's games table has no OTL/BAR columns, but a game with a
// replay is worth reaching from there too — so it gets the same slot on its
// own, under the same three rules.
function replayCell(g) {
  return '<td class="links">' + replaySlot(g, true) + '</td>';
}

function linksCell(g) {
  return '<td class="links">' +
    '<a href="' + esc(otlHref(g.id)) + '" target="_blank" rel="noopener noreferrer">OTL</a>' +
    '<a href="' + esc(barHref(g.id)) + '" target="_blank" rel="noopener noreferrer">BAR</a>' +
    replaySlot(g, true) +
    '</td>';
}

// The pager above a games table: Prev / "Page N of M · T games" / Next, and a
// per-page dropdown. Rendered as HTML; wirePager binds the controls afterwards.
const PER_PAGE_CHOICES = [10, 20, 50, 100];
function pagerBar(data, totalPages, perPage) {
  const label = "Page " + data.page + " of " + totalPages +
    " · " + data.total + " game" + (data.total === 1 ? "" : "s");
  const opts = PER_PAGE_CHOICES.map((n) =>
    '<option value="' + n + '"' + (n === perPage ? ' selected' : '') + '>' + n + '</option>').join("");
  return '<div class="toolbar">' +
    '<button class="btn" id="pgPrev" type="button"' + (data.page <= 1 ? ' disabled' : '') + '>‹ Prev</button>' +
    '<span>' + label + '</span>' +
    '<button class="btn" id="pgNext" type="button"' + (data.page >= totalPages ? ' disabled' : '') + '>Next ›</button>' +
    '<span class="spacer"></span>' +
    '<label>Per page <select class="ctl" id="pgPer">' + opts + '</select></label>' +
    '</div>';
}
// onPage(n) / onPer(n): the page re-fetches. Element properties, so re-binding
// after each re-render stays idempotent.
function wirePager(page, totalPages, onPage, onPer) {
  document.getElementById("pgPrev").onclick = () => { if (page > 1) onPage(page - 1); };
  document.getElementById("pgNext").onclick = () => { if (page < totalPages) onPage(page + 1); };
  document.getElementById("pgPer").onchange = (e) => onPer(Number(e.target.value));
}
// Keep the current page / per-page in the URL (?page=, ?per=) so a refresh or a
// back-navigation lands on the same view; defaults are left out of the URL.
function syncPagingUrl(page, perPage, defaultPer) {
  const u = new URL(location.href);
  if (page > 1) u.searchParams.set("page", String(page)); else u.searchParams.delete("page");
  if (perPage !== defaultPer) u.searchParams.set("per", String(perPage)); else u.searchParams.delete("per");
  history.replaceState(null, "", u);
}
function perPageFromUrl(defaultPer) {
  const n = Number(PAGE_PARAMS.get("per"));
  return PER_PAGE_CHOICES.includes(n) ? n : defaultPer;
}

// A click anywhere on a row carrying data-href (a game row, a lobby row on the
// picker) opens that page — except on the links inside it (player names, OTL/BAR),
// which keep their own targets. Modifier clicks open it in a new tab like a real
// link would. Set as a property so re-rendering the table and re-wiring stays
// idempotent. On game rows most clicks land on the row's own link (rowLink) and
// never get here; this catches the ones on a tooltip element lifted above it
// (a rank emblem, a badge).
function wireRowClicks(tbodyId) {
  document.getElementById(tbodyId).onclick = (e) => {
    if (e.target.closest("a, button")) return;
    const row = e.target.closest("tr[data-href]");
    if (!row) return;
    const href = row.getAttribute("data-href");
    if (e.ctrlKey || e.metaKey || e.shiftKey) window.open(href, "_blank");
    else location.href = href;
  };
}

// The link a game row is made of (see tr.game-row in the CSS): the cell's text
// in an <a> that the stylesheet stretches over the whole row, so every way a
// browser opens a link works on the row without any script.
function rowLink(href, text) {
  return '<a class="row-link" href="' + esc(href) + '">' + esc(text) + '</a>';
}


// ---- Modal dialog ----
//
// What the admin actions ask and report with, in place of the browser's own
// alert and confirm: those block the page on an OS chrome that cannot say more
// than one line, and
// a re-run of the LOS fold is worth explaining before it happens. A <dialog>
// is built on demand, shown modally and thrown away on close.
//
// opts: {title, message, option?: {label, hint}, buttons: [{label, value,
// primary, danger}], tone?: "error"}. Resolves with {value, option} — the
// chosen button's value and the checkbox's state — or null when the dialog was
// dismissed (Escape, the backdrop's Cancel), so a caller reads like a confirm.
let dialogSeq = 0;
function showDialog(opts) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal" + (opts.tone === "error" ? " err" : "");
    const h = document.createElement("h3");
    h.textContent = opts.title;
    // A heading does not name the dialog on its own: role=dialog takes its
    // accessible name from aria-labelledby, and without one a screen reader
    // announces the buttons with no idea what they answer. Unique per dialog,
    // since more than one is built over a page's life.
    h.id = "dlgtitle" + ++dialogSeq;
    dlg.setAttribute("aria-labelledby", h.id);
    dlg.appendChild(h);
    if (opts.message) {
      const p = document.createElement("p");
      p.textContent = opts.message; // text, never markup: nothing here is escaped
      dlg.appendChild(p);
    }
    let check = null;
    if (opts.option) {
      const label = document.createElement("label");
      label.className = "opt";
      check = document.createElement("input");
      check.type = "checkbox";
      const text = document.createElement("span");
      text.className = "t";
      text.textContent = opts.option.label;
      if (opts.option.hint) {
        const sub = document.createElement("span");
        sub.className = "sub";
        sub.textContent = opts.option.hint;
        text.appendChild(sub);
      }
      label.appendChild(check);
      label.appendChild(text);
      dlg.appendChild(label);
    }
    const row = document.createElement("div");
    row.className = "modal-actions";
    let picked = null;
    for (const b of opts.buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = b.label;
      if (b.primary) btn.className = "primary";
      if (b.danger) btn.className = "danger";
      btn.onclick = () => { picked = b.value; dlg.close(); };
      row.appendChild(btn);
    }
    dlg.appendChild(row);
    // One place to resolve, whichever way it closed — a button, Escape, or the
    // form's implicit submit — and the element goes with it.
    dlg.addEventListener("close", () => {
      const option = check ? check.checked : false;
      dlg.remove();
      resolve(picked == null ? null : { value: picked, option: option });
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    const first = row.querySelector("button.primary") || row.querySelector("button");
    if (first) first.focus();
  });
}

// "Do this?" — resolves to the checkbox state (an object, hence truthy) when
// confirmed, null when not. The option adds the one extra choice the action
// carries, which is how the LOS re-run asks about off-map games without a
// second dialog.
async function confirmDialog(opts) {
  const r = await showDialog({
    title: opts.title,
    message: opts.message,
    option: opts.option,
    buttons: [
      { label: opts.cancelLabel || "Cancel", value: false },
      { label: opts.confirmLabel || "OK", value: true, primary: !opts.danger, danger: opts.danger },
    ],
  });
  return r && r.value ? { option: r.option } : null;
}

/** "Here is what happened" — one button, nothing to decide. */
function noticeDialog(opts) {
  return showDialog({
    title: opts.title,
    message: opts.message,
    tone: opts.tone,
    buttons: [{ label: "Close", value: true, primary: true }],
  });
}

/** POST JSON and read the answer, turning a non-2xx into the error it carries. */
async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}

// ---- Admin row menu ----
//
// The "⋯" button at the end of an admin row, dropping a small list of actions
// under it. The machinery is shared — one menu open at a time, a click
// anywhere else or Escape closes it — and the ACTIONS belong to the page: it
// assigns rowMenuActions, which is handed the button (with whatever
// data-attributes the cell carried) and returns
// [{label, title, onClick(item, btn)}].
let rowMenuActions = () => [];
let openMenu = null;

/** The cell a row ends with. Its data map becomes the data-… attributes the actions read back. */
function rowMenuCell(data, title) {
  const attrs = Object.keys(data)
    .map((k) => " data-" + k + '="' + esc(data[k]) + '"')
    .join("");
  // aria-expanded and nothing else. The panel is a plain list of buttons, not
  // an ARIA menu, so the button must not advertise a popup role it does not
  // implement: that promises the arrow-key navigation a menu is expected to
  // have. A disclosure is what this is, and what it says it is.
  return '<td class="admin-col rowacts"><button type="button" class="rowmenu-btn"' + attrs +
    ' title="' + esc(title || "Actions") + '" aria-expanded="false">⋯</button></td>';
}

function closeRowMenu() {
  if (!openMenu) return;
  openMenu.panel.remove();
  openMenu.btn.setAttribute("aria-expanded", "false");
  openMenu = null;
}

function openRowMenu(btn) {
  const wasFor = openMenu && openMenu.btn === btn;
  closeRowMenu();
  if (wasFor) return; // second click on the same button = close
  const panel = document.createElement("div");
  panel.className = "rowmenu";
  for (const a of rowMenuActions(btn)) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = a.label;
    if (a.title) item.title = a.title;
    item.onclick = () => a.onClick(item, btn);
    panel.appendChild(item);
  }
  // On <body>, fixed at the button: inside the cell, the card's overflow clip
  // swallowed the panel under a page's last row. Below the button when it fits
  // in the viewport, above it when it does not.
  document.body.appendChild(panel);
  const r = btn.getBoundingClientRect();
  panel.style.right = Math.max(4, document.documentElement.clientWidth - r.right) + "px";
  const h = panel.offsetHeight;
  const below = r.bottom + 2;
  panel.style.top = (below + h <= window.innerHeight || r.top - h - 2 < 0 ? below : r.top - h - 2) + "px";
  btn.setAttribute("aria-expanded", "true");
  openMenu = { btn: btn, panel: panel };
}

// A fixed panel would float away from its row on a scroll or a resize; closing
// is simpler and what a dropdown is expected to do. Scrolls INSIDE the panel
// (none today) would not count.
window.addEventListener("scroll", (e) => {
  if (openMenu && !(e.target instanceof Node && openMenu.panel.contains(e.target))) closeRowMenu();
}, true);
window.addEventListener("resize", () => closeRowMenu());

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button.rowmenu-btn");
  if (btn) { openRowMenu(btn); return; }
  if (!e.target.closest(".rowmenu")) closeRowMenu();
});
// A dialog opened FROM the menu owns Escape while it is up; the menu closes
// with it either way, since the action that opened it closes the menu.
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeRowMenu(); });

// (?) help button: toggle the attribution popup; click elsewhere to dismiss.
// (Only the lobby pages carry it — it credits the rank icons — hence the guard.)
const helpBtn = document.getElementById("helpBtn");
const helpPop = document.getElementById("helpPop");
if (helpBtn) {
  helpBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    helpPop.hidden = !helpPop.hidden;
    helpBtn.setAttribute("aria-expanded", String(!helpPop.hidden));
  });
  document.addEventListener("click", (e) => {
    if (!helpPop.hidden && !helpPop.contains(e.target) && e.target !== helpBtn) {
      helpPop.hidden = true;
      helpBtn.setAttribute("aria-expanded", "false");
    }
  });
}

// Auto-refresh, toggleable via the header button (preference persisted, shared key).
// Only the lobby pages have the button — ranking/LOS data changes only on upload —
// and it is ADMIN-ONLY: outside admin mode the button stays hidden (CSS) and the
// timer never runs, whatever the stored preference says.
let autoTimer = null;
let auto = ADMIN_MODE && localStorage.getItem("autoRefresh") === "on"; // off by default
const autoBtn = document.getElementById("autoToggle");
function applyAuto() {
  if (!autoBtn) return;
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (auto) autoTimer = setInterval(refresh, 3000);
  autoBtn.textContent = auto ? "⏸ Auto-refresh: on" : "▶ Auto-refresh: off";
  autoBtn.classList.toggle("on", auto);
}
if (autoBtn && ADMIN_MODE) {
  autoBtn.addEventListener("click", () => {
    auto = !auto;
    localStorage.setItem("autoRefresh", auto ? "on" : "off");
    applyAuto();
    if (auto) refresh(); // refresh immediately when turning it back on
  });
}
`;

// ---------------------------------------------------------------------------
// Lobby list — served only by GET / when there is no open lobby to redirect to
// (there is no menu entry for it anymore; a specific lobby opens by id at
// /lobby/:id).
// ---------------------------------------------------------------------------
export const LOBBIES_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lavabalance · lobbies</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell">
${sidebar("lobby")}
<div class="main">
<header class="top">
  <h1>Lobbies</h1>
  <span class="meta" id="meta">loading…</span>
  <a class="viewall" id="viewAll" href="/lobbies" title="Every open lobby on the server">🔎 View all lobbies</a>
  <button class="toggle" id="autoToggle" type="button"></button>
  ${HELP_POP}
</header>
<main id="root"><div class="empty">loading…</div></main>
</div>
</div>

<script>
${SHARED_JS}

// One row per lobby: name · #id · lock · in-progress status · players/max (excluding
// spectators), linking to the lobby's detail page (carrying any ?src=). "In progress"
// is derived from the roster (any player loaded into the running match) since not every
// source reports a battle-level flag.
function lobbyRow(l) {
  const playerCount = l.players.filter((p) => !p.spectator).length;
  const slots = l.maxPlayers ? playerCount + " / " + l.maxPlayers : String(playerCount);
  const inProgress = l.players.some((p) => p.inGame);
  const statusBadge = inProgress
    ? '<span class="badge live">⚔️ in progress</span>'
    : '<span class="badge">🛋️ in lobby</span>';
  const lockBadge = l.locked ? '<span class="badge locked">🔒 locked</span>' : '';
  const href = "/lobby/" + encodeURIComponent(l.battleId) + SRC_QUERY;
  const title = l.title || (l.founder ? l.founder + "'s lobby" : "battle");
  return '<a class="lobby-row" href="' + href + '">' +
    '<span class="title">' + esc(title) + '</span>' +
    '<span class="id">#' + esc(l.battleId) + '</span>' +
    lockBadge +
    '<span class="spacer"></span>' +
    statusBadge +
    '<span class="badge">👤 ' + slots + '</span>' +
    '<span class="chevron">›</span>' +
  '</a>';
}

async function refresh() {
  const root = document.getElementById("root");
  const meta = document.getElementById("meta");
  try {
    const res = await fetch(LOBBIES_URL, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const lobbies = await res.json();
    meta.textContent = "updated " + new Date().toLocaleTimeString();
    root.innerHTML = lobbies.length
      ? '<div class="lobby-list">' + lobbies.map(lobbyRow).join("") + '</div>'
      : '<div class="empty">' + (SHOW_ALL
          ? 'No lobbies are currently open.'
          : 'No lava lobbies are currently open (or none configured).') +
          '<br /><a class="pick" href="/lobbies' + SRC_QUERY + '">Select a lobby</a></div>';
  } catch (e) {
    meta.textContent = "";
    root.innerHTML = '<div class="error">Failed to load lobbies: ' + esc(e.message) + '</div>';
  }
}

refresh();
applyAuto();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// All-lobbies picker (GET /lobbies): every open lobby on Teiserver with at least
// one player, as a table; a row opens /lobby/:id. Reached from the list page's
// empty state and the "View all lobbies" header button.
// ---------------------------------------------------------------------------
export const ALL_LOBBIES_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lavabalance · all lobbies</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell">
${sidebar("lobby")}
<div class="main">
<header class="top">
  <h1>All lobbies</h1>
  <span class="meta" id="meta">loading…</span>
  <button class="toggle" id="autoToggle" type="button"></button>
  ${HELP_POP}
</header>
<main>
<div class="card all-lobbies">
  <div id="root"><div class="empty">loading…</div></div>
</div>
</main>
</div>
</div>

<script>
${SHARED_JS}

// The picker reads Teiserver's own lobby index (GET /api/lobbies/all): no lava filter,
// no ?src= (it is the server's list whatever source the lobby views use). Rows link
// into /lobby/:id carrying the page's ?src=/?all= like everything else.
const ALL_LOBBIES_URL = "/api/lobbies/all";

// One row per lobby: name · #id · map · status badges · players · spectators.
function lobbyTr(l) {
  const status = (l.inProgress
      ? '<span class="badge live">⚔️ in progress</span>'
      : '<span class="badge">🛋️ in lobby</span>') +
    (l.locked ? '<span class="badge locked">🔒 locked</span>' : '') +
    (l.passworded ? '<span class="badge locked">🔑 password</span>' : '');
  const href = "/lobby/" + encodeURIComponent(l.id) + SRC_QUERY;
  // Lava lobbies (the API lists them first) are named in orange, like the header button.
  const lava = String(l.name || "").toLowerCase().includes("lava");
  return '<tr data-href="' + href + '">' +
    '<td class="lname"><a class="plink' + (lava ? ' lava' : '') + '" href="' + href + '">' +
      esc(l.name || ("battle #" + l.id)) + '</a></td>' +
    '<td class="lid">#' + esc(l.id) + '</td>' +
    '<td class="lmap">' + esc(l.map || "") + '</td>' +
    '<td class="lstatus">' + status + '</td>' +
    '<td class="num">' + esc(l.playerCount) + '</td>' +
    '<td class="num">' + esc(l.spectatorCount) + '</td>' +
    '</tr>';
}

function renderTable(lobbies) {
  const root = document.getElementById("root");
  if (!lobbies.length) {
    root.innerHTML = '<div class="empty">No lobbies with players are currently open.</div>';
    return;
  }
  root.innerHTML =
    '<table>' +
    '<thead><tr><th>Lobby</th><th>#</th><th>Map</th><th>Status</th>' +
    '<th class="num">Players</th><th class="num">Spectators</th></tr></thead>' +
    '<tbody id="rows">' + lobbies.map(lobbyTr).join("") + '</tbody>' +
    '</table>';
  wireRowClicks("rows");
}

async function refresh() {
  const meta = document.getElementById("meta");
  try {
    const res = await fetch(ALL_LOBBIES_URL, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const lobbies = await res.json();
    meta.textContent = lobbies.length + " lobb" + (lobbies.length === 1 ? "y" : "ies") +
      " · updated " + new Date().toLocaleTimeString();
    renderTable(lobbies);
  } catch (e) {
    meta.textContent = "";
    document.getElementById("root").innerHTML =
      '<div class="error">Failed to load lobbies: ' + esc(e.message) + '</div>';
  }
}

refresh();
applyAuto();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Detail page (GET /lobby/:id): the dense per-team roster for one lobby.
// ---------------------------------------------------------------------------
export const LOBBY_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lavabalance · lobby</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell">
${sidebar("lobby")}
<div class="main">
<header class="top">
  <h1>Lobby</h1>
  <span class="meta" id="meta">loading…</span>
  <a class="viewall" id="viewAll" href="/lobbies" title="Every open lobby on the server">🔎 View all lobbies</a>
  <button class="toggle" id="autoToggle" type="button"></button>
  ${HELP_POP}
</header>
<main id="root"><div class="empty">loading…</div></main>
</div>
</div>

<script>
${SHARED_JS}

// The lobby id from the URL path (/lobby/:id).
const LOBBY_ID = Number(decodeURIComponent((location.pathname.split("/")[2] || "")));

// The detail page hits the single-lobby endpoint (/api/lobbies/:id), NOT the list — only
// it resolves LOS ratings, and just for this one lobby's roster. Carries the same ?src=.
// withAdmin: admin mode asks for the unblanked ratings, as on every other page.
const LOBBY_URL = withAdmin("/api/lobbies/" + encodeURIComponent(LOBBY_ID) + SRC_QUERY);

function rankIcon(p) {
  if (p.rank == null) return "";
  return '<img class="rank" src="/ranks/' + encodeURIComponent(p.rank) + '.png" ' +
    'alt="rank ' + esc(p.rank) + '" title="Rank ' + esc(p.rank) + '" />';
}

// The LOS a row SHOWS (the server already applies the rookie handicap to los): the handicapped value, the assumed debutant value for
// someone never rated, and null for a profile whose rating is withheld — those
// three read very differently and must not collapse into one another.
function displayedLos(p) {
  if (p.losPrivate) return null;
  if (p.los == null) return UNRATED_LOS;
  return p.los;
}

// The (?) circle hung right of a pill (same visual as the average hints), carrying
// an instant tooltip. Absolutely positioned so the pills stay aligned across rows.
function pillHint(text) {
  return '<span class="hint pill-hint">?<span class="hint-tip">' + text + '</span></span>';
}

// The rank column for a visitor: the emblem alone (its name is the tooltip).
// A player LOS has never rated is placing at 0 games; a private profile's rank
// is withheld like its LOS.
function lobbyRank(p) {
  if (p.losPrivate) {
    return '<span class="pill none">–</span>' +
      pillHint('This player\u2019s profile is private, so their rank is not shown. The win chance still counts them.');
  }
  return rankBadge(p.tier || "placing", p.losGames || 0, { size: 30 });
}

function ratingPill(p) {
  if (!ADMIN_MODE) return lobbyRank(p);
  return (p.tier ? rankBadge(p.tier, p.losGames || 0, { size: 24 }) : '') + losPillOf(p);
}

function losPillOf(p) {
  const los = displayedLos(p);
  if (los == null) {
    // Withheld, not missing: the same "– (?)" the game page's roster shows, and
    // for the same reason. The team average and the win chance beside it are
    // unaffected — the server computes those from the real rating.
    return '<span class="pill none">–</span>' +
      pillHint('This player\u2019s profile is private, so their LOS is not shown. The team ' +
        'average and win chance still count it.');
  }
  if (p.los == null) {
    // Never rated — but balancing and the win chances count them as a debutant,
    // so show that assumed value rather than an empty cell.
    return '<span class="pill ' + ratingClass(los) + '" title="assumed LOS (no rated lava game yet)">' +
      fmtLos(los) + '</span>' +
      pillHint('No rated lava game yet — balancing and the win chances count this player as a ' +
        'debutant: LOS ' + UNRATED_LOS + ' (μ 25 minus the 13 rookie handicap, minus σ 8.3).');
  }
  const games = p.losGames != null ? p.losGames : 0;
  const title = "LOS " + fmtLos(los) + " over " + games + " rated lava game" +
    (games === 1 ? "" : "s");
  const pill = '<span class="pill ' + ratingClass(los) + '" title="' + title + '">' +
    fmtLos(los) + '</span>';
  if (!(p.losHandicap > 0)) return pill;
  // A rookie's pill wears the handicapped value; the (?) explains the discount.
  return pill + pillHint('Rookie handicap: with only ' + games + ' rated lava game' +
    (games === 1 ? '' : 's') + ', raw LOS ' + fmtLos(p.losRaw) + ' is discounted by ' +
    fmtLos(p.losHandicap) + ' to ' + fmtLos(los) +
    ' — the value balancing and the win chances use. The discount fades out over the first 35 games.');
}

// ---- Party pills ----
// Teiserver identifies a party ONLY by the roster's Party-column colour, so the
// server relays that colour as an opaque per-player key. Number the parties
// "party 1", "party 2", … in order of appearance down the roster and tint each
// pill with the party's own Teiserver colour.
function partyIndex(l) {
  const map = new Map();
  for (const p of l.players) {
    if (p.spectator || !p.party) continue;
    if (!map.has(p.party)) map.set(p.party, map.size + 1);
  }
  return map;
}

// Strongest first by the DISPLAYED (handicapped) LOS so the rows follow the pill
// values; a player with no LOS rating counts as the debutant value (UNRATED_LOS,
// same as the averages), ties broken by name. A player whose rating is WITHHELD
// has no displayed value to sort on and goes last — sorting them by the hidden
// number would put it back on screen as a position.
function byLosDescLobby(players) {
  // A visitor has no LOS, but each player carries their place in the lobby by
  // it (losOrder, the same order this sorts an admin's by).
  if (!ADMIN_MODE) return players.slice().sort((a, b) => (a.losOrder ?? 0) - (b.losOrder ?? 0));
  const key = (p) => { const v = displayedLos(p); return v == null ? -Infinity : v; };
  return players.slice().sort((a, b) => key(b) - key(a) || a.name.localeCompare(b.name));
}

function playerRow(p, parties, color) {
  // In-game players show the crossed-swords marker (the match has launched and they've
  // loaded in). Otherwise, an unsynced player (sync === 2) is missing the map/game
  // content — typically still downloading it — so show a downloading marker instead of
  // the ready tick; else show the lobby ready tick/cross.
  const ready = p.inGame
    ? '<span class="in-game" title="in game">⚔️</span>'
    : p.sync === 2
      ? '<span class="unsynced" title="unsynced — downloading map">⏳</span>'
      : p.ready ? '<span class="ready-yes">✓</span>' : '<span class="ready-no">✗</span>';
  const boss = p.boss ? '<span class="boss" title="boss">👑</span>' : '';
  // The assumed in-game colour for this roster position (two-team lobbies only).
  // Only our own hex palette reaches the style attribute.
  const tint = color ? ' style="color:' + color + '" ' : ' ';
  // A player LOS knows links to their player page (LOS chart + recent games).
  const name = p.losUserId != null
    ? '<a class="pname"' + tint + 'href="/player/' + encodeURIComponent(p.losUserId) + '" ' +
      'title="LOS profile of ' + esc(p.name) + '">' + esc(p.name) + '</a>'
    : '<span class="pname"' + tint + '>' + esc(p.name) + '</span>';
  const games = p.losGames != null ? esc(p.losGames) : '<span class="muted">–</span>';
  // OneTrickLava's warning badges (💥 comm bomber, 🪂 dropper, …), icons only —
  // the captions are the tooltip. Archetypes and the main lane ride the same
  // tooltip when the player has no badge, so every scouted row says something.
  const sc = p.scout;
  let scout = "";
  if (sc) {
    scout = sc.badges && sc.badges.length
      ? scoutIcons(sc.badges)
      : '<span class="scout-icons plain" title="' + esc(
          (sc.archetypes || []).join(", ") +
          (sc.lane ? " · plays " + sc.lane.name + " " + pctTxt(sc.lane.share) : "")) +
        '">🔭</span>';
  }
  return '<tr>' +
    '<td class="ready">' + ready + '</td>' +
    '<td class="skill">' + (p.skill == null ? "??" : esc(Math.round(p.skill))) + '</td>' +
    '<td class="name">' + rankIcon(p) + name + boss + scout + '</td>' +
    '<td class="party">' + partyPill(p, parties) + '</td>' +
    '<td class="rating">' + ratingPill(p) + '</td>' +
    '<td class="games" title="rated lava games played">' + games + '</td>' +
    '</tr>';
}

// showAvg is false when the matchup strip above already carries the averages (two-team
// lobbies); FFA / unsplit lobbies keep the badge in the team header instead.
function teamTable(label, players, showAvg, stat, cls, parties, palette) {
  return '<div class="team">' +
    '<h3><span class="tname' + (cls ? ' ' + cls : '') + '">👥 ' + esc(label) + '</span>' +
      (showAvg ? teamAvgBadge(players, stat) : '') + '</h3>' +
    '<table>' +
    '<thead><tr><th class="ready"></th><th class="skill">OS</th>' +
    '<th class="name">Player</th><th class="party"></th><th class="rating">' + (ADMIN_MODE ? 'LOS' : 'Rank') + '</th>' +
    '<th class="games" title="rated lava games played">Games</th></tr></thead>' +
    '<tbody>' +
    players.map((p, i) => playerRow(p, parties, palette ? palette[i % palette.length] : null)).join("") +
    '</tbody></table></div>';
}

// ---- In-progress clock ----
// The server reports the match's elapsed seconds at fetch time; the badge's clock
// keeps counting locally every second so it moves without a refresh.
let progressBaseSec = null; // server-reported elapsed seconds, or null
let progressAt = 0;         // Date.now() when that was received

// "[Nd ][H:]MM:SS" — the same short form Teiserver's own page uses.
function fmtElapsed(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
        m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = m < 10 ? "0" + m : String(m), ss = s < 10 ? "0" + s : String(s);
  return (d ? d + "d " : "") + (h ? h + ":" : "") + mm + ":" + ss;
}

function tickProgress() {
  const el = document.getElementById("progressTime");
  if (!el || progressBaseSec == null) return;
  el.textContent = fmtElapsed(progressBaseSec + (Date.now() - progressAt) / 1000);
}
setInterval(tickProgress, 1000);

// The green "in progress" badge in the lobby's title bar; the clock only renders
// when the source reported an elapsed time (the teiserver scrape does).
function progressBadge(l) {
  if (!l.inProgress) return "";
  const clock = l.inProgressSec != null ? ' · <span class="t" id="progressTime"></span>' : '';
  return '<span class="badge live" title="the match has launched">⚔️ in progress' + clock + '</span>';
}

// ---- Roster-view toggle (bot game-start upload vs live lobby) ----
//
// While a game runs the bot uploads the LAUNCH roster, and the server serves it
// in place of the live one (the lobby keeps changing during a game and stops
// matching who is playing). Which one the page asks for; "bot" is the default,
// and the server falls back to live on its own when no fresh upload exists.
// In-memory on purpose — a persisted choice would wrongly pin onto the NEXT game.
let rosterView = "bot";

// The toggle, rendered only when the response says an upload exists (l.botRoster
// is set on BOTH views, so the live view still offers the way back). The active
// segment marks what the tables actually carry (l.rosterSource).
function rosterToggle(l) {
  if (!l.botRoster) return "";
  const startAt = new Date(l.botRoster.gameStartAt).toLocaleTimeString();
  const seg = (view, label, title) =>
    '<button type="button" class="rt' + (l.rosterSource === view ? " active" : "") +
    '" data-roster="' + view + '" title="' + title + '">' + label + '</button>';
  return '<span class="roster-toggle">' +
    seg("bot", "📌 at game start",
      "the teams the bot recorded when the match launched (" + startAt +
      "); lobby changes during the game are hidden") +
    seg("live", "🛋️ live lobby",
      "the lobby as the server shows it right now, joins and leaves included") +
    '</span>';
}

// ---- Bosses / spectators / balance lines under the team tables ----

// Comma-separated names; a name LOS knows links to their player page.
function nameList(l, names) {
  const byName = new Map(l.players.map((p) => [p.name, p]));
  return names.map((n) => {
    const p = byName.get(n);
    return p && p.losUserId != null
      ? '<a href="/player/' + encodeURIComponent(p.losUserId) + '" ' +
        'title="LOS profile of ' + esc(n) + '">' + esc(n) + '</a>'
      : esc(n);
  }).join(", ");
}

// ---- Avoid lists (admin only) ----
//
// Who in this roster asked not to be teamed with whom (src/avoids.ts). The
// server only sends 'avoids' on the admin view (admin mode → includePrivate),
// so a normal visitor's response carries nothing to draw — an avoid list is
// between the player and the bot. Entries whose other side is also in the
// lobby are the ones the balancer actually weighed, so they are marked; the
// rest are shown muted, as list contents that did not apply this time.
function avoidLine(l) {
  const avoids = l.avoids || [];
  if (!avoids.length) return "";
  const present = new Set(l.players.filter((p) => !p.spectator).map((p) => p.name.toLowerCase()));
  const shown = avoids.slice().sort((a, b) =>
    a.owner.localeCompare(b.owner) || a.avoid.localeCompare(b.avoid));
  const pairs = shown.map((e) => {
    const live = present.has(e.owner.toLowerCase()) && present.has(e.avoid.toLowerCase());
    return '<span class="avoid-pair' + (live ? " live" : "") + '" title="' +
      (live
        ? "both are in this lobby — the balancer keeps them apart while the teams stay inside 40-60%"
        : "only one of them is in this lobby, so this request does not constrain these teams") +
      '">' + esc(e.owner) + " ⇢ " + esc(e.avoid) + "</span>";
  });
  return '<div class="line admin-only"><span class="k">🚫 Avoids</span>' +
    pairs.join(", ") + "</div>";
}

function footLists(l) {
  const lines = [];
  const bosses = l.bosses || [];
  if (bosses.length) {
    lines.push('<div class="line"><span class="k">👑 Bosses</span>' +
      nameList(l, bosses) + '</div>');
  }
  const specs = l.players.filter((p) => p.spectator);
  if (specs.length) {
    lines.push('<div class="line"><span class="k">👁️ Spectators (' + specs.length + ')</span>' +
      nameList(l, specs.map((p) => p.name)) + '</div>');
  }
  if (l.balanceMode) {
    // SPADS's own balanceMode, broadcast by the host (Dispatcher source only). It is
    // what the LOBBY balances by, and the one setting that changes the bot's split:
    // a mode naming "clan" keeps party members together, "skill"/"random" does not.
    // Mirrors honoursParties() in src/balance/balanceMode.ts — keep the rule in step.
    const keepsParties = String(l.balanceMode).split(";").some((m) => m.trim() === "clan");
    lines.push('<div class="line"><span class="k">🤝 Balance mode</span>' +
      '<span title="the SPADS balanceMode the host broadcasts. The bot always balances ' +
      'on LOS; this decides whether parties are kept together">' + esc(l.balanceMode) +
      ' <span class="muted">· ' + (keepsParties ? "parties kept together" : "parties ignored") +
      "</span></span></div>");
  }
  const avoids = avoidLine(l);
  if (avoids) lines.push(avoids);
  if (l.balanceAlgorithm) {
    // Teiserver's OWN consul setting ("auto", "loser_picks", …), scraped from the
    // lobby show page. Named in full because a bare "Balance algorithm: auto"
    // reads as SPADS's autoBalance being on, which is a different setting
    // entirely — and the one that decides whether the bot may set teams.
    lines.push('<div class="line"><span class="k">⚖️ Teiserver balance algorithm</span>' +
      '<span title="the Teiserver consul setting — NOT the SPADS autoBalance that ' +
      'decides whether the bot may set teams">' + esc(l.balanceAlgorithm) + '</span></div>');
  }
  return lines.length ? '<div class="foot-lists">' + lines.join("") + '</div>' : "";
}

// ---- Scouting report (OneTrickLava, src/scout.ts) ----
//
// The server's l.scouting: a LANE FORECAST — who on each team is likely to take
// which Supreme Isthmus lane, from each player's own lane history (one player
// per lane per team, solved server-side) — and per team the threats (badge
// holders) and the style mix. Null when OTL has no card for anyone here.

// A lane's expected player: name, the share of their games on it, their record there.
function lanePick(pk, cls, mirrored) {
  if (!pk) return '<span class="none" title="nobody on this team is known to play it">?</span>';
  const name = '<a class="' + cls + '" href="/player/' + encodeURIComponent(pk.userId) + '">' +
    esc(pk.name) + '</a>';
  const share = '<span class="share" title="share of their games played on this lane (' +
    esc(pk.games) + ' games)">' + pctTxt(pk.share) + '</span>';
  const wr = pk.winRate == null ? "" :
    '<span class="wr ' + wrClass(pk.winRate) + '" title="won ' + pctTxt(pk.winRate) +
    ' of their decided games on this lane">W ' + pctTxt(pk.winRate) + '</span>';
  return '<span class="pk">' + (mirrored ? wr + share + name : name + share + wr) + '</span>';
}

// From this share of a player's games, the lane is "theirs" — two of those facing
// each other is the matchup to watch (⚔).
const LANE_MAIN_SHARE = 0.3;

function laneTable(rows, teamCount) {
  if (teamCount === 2) {
    // Mirrored: Team 1 reads right-to-left into the lane name, Team 2 away from it.
    const body = rows.map((r) => {
      const a = r.picks[0], b = r.picks[1];
      const clash = a && b && a.share >= LANE_MAIN_SHARE && b.share >= LANE_MAIN_SHARE;
      let edgeA = "", edgeB = "";
      if (clash && a.winRate != null && b.winRate != null && Math.abs(a.winRate - b.winRate) >= 0.05) {
        const mark = '<span class="edge" title="the better record on this lane">▲</span>';
        if (a.winRate > b.winRate) edgeA = mark; else edgeB = mark;
      }
      return '<tr' + (clash ? ' class="clash"' : '') + '>' +
        '<td class="pick left">' + edgeA + lanePick(a, "tc0", true) + '</td>' +
        '<td class="lane"' + (clash ? ' title="both expected players main this lane"' : '') + '>' +
          (clash ? "⚔ " : "") + esc(r.lane) + '</td>' +
        '<td class="pick">' + lanePick(b, "tc1", false) + edgeB + '</td>' +
      '</tr>';
    }).join("");
    return '<table class="lanes mirror"><thead><tr><th class="left">Team 1</th>' +
      '<th class="lane">Lane</th><th>Team 2</th></tr></thead><tbody>' + body + '</tbody></table>';
  }
  const head = '<tr><th class="lane">Lane</th>' +
    Array.from({ length: teamCount }, (_, i) => '<th>Team ' + (i + 1) + '</th>').join("") + '</tr>';
  const body = rows.map((r) => '<tr><td class="lane">' + esc(r.lane) + '</td>' +
    r.picks.map((pk) => '<td class="pick">' + lanePick(pk, "", false) + '</td>').join("") +
    '</tr>').join("");
  return '<table class="lanes"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
}

function teamScoutBlock(t, label, cls) {
  const lines = ['<div><span class="k ' + cls + '">' + esc(label) + '</span>' +
    '<span class="muted">' + t.scouted + ' of ' + t.players + ' scouted</span></div>'];
  if (t.threats.length) {
    lines.push('<div><span class="k">Watch for</span>' + t.threats.map((th) =>
      '<span class="threat">' + esc(th.icon || "•") + ' <b>' + esc(th.label) + '</b>: ' +
      th.names.map(esc).join(", ") + '</span>').join("") + '</div>');
  } else if (t.scouted) {
    lines.push('<div><span class="k">Watch for</span><span class="muted">no known comm habits</span></div>');
  }
  if (t.styles.length) {
    lines.push('<div><span class="k">Style</span>' + t.styles.map((s) =>
      '<span class="arch">' + esc(s.archetype) + (s.count > 1 ? " ×" + s.count : "") + '</span>').join("") +
      '</div>');
  }
  if (t.aggression != null || t.ecoFocus != null) {
    lines.push('<div><span class="k">Lean</span>' +
      '<span title="mean OTL aggression of the scouted players">aggression ' + pctTxt(t.aggression) +
      '</span> · <span title="mean OTL eco focus of the scouted players">eco ' + pctTxt(t.ecoFocus) +
      '</span></div>');
  }
  return '<div class="scout-team">' + lines.join("") + '</div>';
}

function scoutReport(l) {
  const sc = l.scouting;
  if (!sc || !sc.teams || !sc.teams.length) return "";
  const two = sc.teams.length === 2;
  const scouted = sc.teams.reduce((n, t) => n + t.scouted, 0);
  const total = sc.teams.reduce((n, t) => n + t.players, 0);
  const lanes = sc.lanes && sc.lanes.lanes && sc.lanes.lanes.length
    ? '<div class="lanes-wrap">' + laneTable(sc.lanes.lanes, sc.teams.length) + '</div>' : "";
  const teams = '<div class="scout-teams">' + sc.teams.map((t, i) =>
    teamScoutBlock(t, "Team " + (t.ally + 1), two ? "tc" + i : "")).join("") + '</div>';
  return '<div class="scout-report">' +
    '<h3>🔭 Scouting report <span class="sub">' + scouted + ' of ' + total +
      ' players scouted by OneTrickLava replay analysis</span>' +
      '<a class="more" href="/scouting">watch list →</a></h3>' +
    lanes + teams +
    (lanes
      ? '<div class="scout-foot">Lane forecast: each player’s most-played Supreme Isthmus lanes, ' +
        'one player per lane per team. ⚔ = both sides main that lane, ▲ = the better record there.</div>'
      : '') +
  '</div>';
}

function lobbyCard(l) {
  // Each team's roster strongest-first — the order the assumed in-game colours
  // are handed out in.
  const teams = teamsOf(l).map(([a, players]) => [a, byLosDescLobby(players)]);
  // Averages and win chance only make sense head-to-head, so they move into the
  // matchup strip for a straight two-team lobby; FFA or an unsplit lobby keeps the per-team
  // average badge and gets no odds.
  // Per-ally aggregates from the server (mean LOS + the OpenSkill win probability, which
  // needs every player's mu/sigma and so can only come from the server). Absent on a
  // response without stats — teamAvg then falls back to averaging what's on screen.
  const stats = new Map((l.teamStats || []).map((t) => [t.ally, t]));
  const statFor = (ally) => stats.get(ally);
  const headToHead = teams.length === 2;
  const matchup = headToHead ? matchupBar(teams, statFor) : "";
  const parties = partyIndex(l);
  let tables = teams
    .map(([a, players], i) => teamTable("Team " + (a + 1), players, !matchup, statFor(a),
      headToHead ? (i === 0 ? "t1" : "t2") : "", parties,
      headToHead ? TEAM_COLORS[i] : null))
    .join("");
  if (!tables) tables = '<div class="empty">no players</div>';

  const lockBadge = l.locked ? '<span class="badge locked">🔒 locked</span>' : '';
  const playerCount = l.players.filter((p) => !p.spectator).length;

  return '<section class="lobby">' +
    '<div class="head">' +
      progressBadge(l) +
      rosterToggle(l) +
      '<span class="title">' + esc(l.title || (l.founder ? l.founder + "'s lobby" : "battle")) + '</span>' +
      '<span class="id">#' + esc(l.battleId) + '</span>' +
      lockBadge +
      '<span class="badge">👤 ' + playerCount + '</span>' +
    '</div>' +
    matchup +
    '<div class="teams">' + tables + '</div>' +
    scoutReport(l) +
    footLists(l) +
  '</section>';
}

// Draw the lobby (or the "not open" note).
function render(lobby) {
  // The upload is gone (game over / none yet): back to the default so the NEXT
  // game opens on the bot view again rather than a leftover "live" choice.
  if (lobby && !lobby.botRoster) rosterView = "bot";
  // Re-base the in-progress clock on every response, so the local tick never drifts
  // far from the server's elapsed time.
  progressBaseSec =
    lobby && lobby.inProgress && lobby.inProgressSec != null ? lobby.inProgressSec : null;
  progressAt = Date.now();
  document.getElementById("root").innerHTML = lobby
    ? lobbyCard(lobby)
    : '<div class="empty">Lobby #' + esc(LOBBY_ID) + ' is not currently open.' +
      '<br /><a class="pick" href="/lobbies' + SRC_QUERY + '">Select a lobby</a></div>';
  tickProgress();
}

async function refresh() {
  const meta = document.getElementById("meta");
  try {
    // ?roster=live asks for the live lobby instead of the bot's game-start
    // upload; built dynamically since LOBBY_URL may already carry a query.
    const url = LOBBY_URL +
      (rosterView === "live" ? (LOBBY_URL.indexOf("?") >= 0 ? "&" : "?") + "roster=live" : "");
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const lobby = await res.json(); // single lobby object, or null when not open
    meta.textContent = "updated " + new Date().toLocaleTimeString();
    render(lobby);
  } catch (e) {
    meta.textContent = "";
    document.getElementById("root").innerHTML =
      '<div class="error">Failed to load lobby: ' + esc(e.message) + '</div>';
  }
}

// The roster toggle lives inside #root (re-rendered wholesale), so its clicks
// are delegated; switching views is a refetch — team stats stay server-computed.
document.getElementById("root").addEventListener("click", (e) => {
  const btn = e.target.closest ? e.target.closest(".roster-toggle .rt") : null;
  if (!btn) return;
  const view = btn.getAttribute("data-roster");
  if (view && view !== rosterView) {
    rosterView = view;
    refresh();
  }
});

refresh();
applyAuto();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Ranking page (GET /ranking): the paged LOS leaderboard.
// ---------------------------------------------------------------------------
export const RANKING_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lavabalance · ranking</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell">
${sidebar("ranking")}
<div class="main">
<header class="top">
  <h1>Ranking</h1>
  <span class="meta" id="meta">loading…</span>
</header>
<main>
<div class="card ranking">
  <h2>🏆 Ranking <span class="sub" id="sub">OpenSkill over lava games only</span></h2>
  <div class="toolbar">
    <button class="btn" id="prev" type="button" disabled>‹ Prev</button>
    <span id="pageLabel">loading…</span>
    <button class="btn" id="next" type="button" disabled>Next ›</button>
    <input class="ctl search" id="q" type="search" placeholder="Search player…"
           autocomplete="off" spellcheck="false" aria-label="Search player by name prefix" />
    <span class="spacer"></span>
    <button class="btn admin-only" id="rebuild" type="button"
            title="Delete the last 8 days of recorded ranks and redraw them from the game log">↻ Rebuild history</button>
    <label>Per page <select class="ctl" id="pgPer">
      <option value="10">10</option><option value="20">20</option>
      <option value="50">50</option><option value="100">100</option>
    </select></label>
  </div>
  <div id="root" class="games-table"><div class="empty">loading…</div></div>
</div>
</main>
</div>
</div>

<script>
${SHARED_JS}

// Leaderboard state. Every rated player is listed (no games filter — the API's
// default includes anyone with at least one rated game). An optional name
// PREFIX filter (the search box, ?q= in the URL) narrows the list server-side —
// the API keeps each row's GLOBAL rank, so a filtered row still shows its real
// leaderboard position.
const DEFAULT_PER_PAGE = 50;
const SEARCH_DEBOUNCE_MS = 500;
let perPage = perPageFromUrl(DEFAULT_PER_PAGE);
let page = Math.max(1, Number(PAGE_PARAMS.get("page")) || 1);
let totalPages = 1;
let query = (PAGE_PARAMS.get("q") || "").trim();
let INACTIVE_DAYS = 35; // replaced by the API's own value on the first response
let CHANGE_DAYS = 7;    // ditto — the window the movement columns are measured over
let requestSeq = 0; // stale-response guard: only the latest request may render

// ---- Sorting. The ORDER is the server's — it has to be: sorting the page in
// hand would only order the 50 rows already fetched — so changing it is a
// refetch.
//
// The sortable columns, and the direction a FIRST click on each gives: the one
// that puts what the column is interesting FOR at the top — best position, best
// rating, biggest gain. Clicking the column already sorted flips it instead.
// A visitor's list is only ever the TIER board (tier, then games played): every
// other order is the hidden LOS's, and the API ignores a visitor's ?sort= anyway.
const SORTS = ADMIN_MODE ? ["rank", "rankChange", "los", "losChange", "tier"] : ["tier"];
const SORT_DEFAULT_DIR = { rank: "asc", los: "desc", rankChange: "desc", losChange: "desc", tier: "desc" };
const DEFAULT_SORT = ADMIN_MODE ? "rank" : "tier";

function sortFromUrl() {
  const key = PAGE_PARAMS.get("sort");
  if (SORTS.indexOf(key) < 0) return { sort: DEFAULT_SORT, dir: SORT_DEFAULT_DIR[DEFAULT_SORT] };
  const d = PAGE_PARAMS.get("dir");
  return { sort: key, dir: d === "asc" || d === "desc" ? d : SORT_DEFAULT_DIR[key] };
}
let { sort, dir } = sortFromUrl();

// The card shell (title, the toolbar with the pager and the search box) is static
// markup; only the table body (#root) and the pager's state re-render, so typing
// in the box never loses focus. Trailing debounce: a keystroke (re)starts the timer,
// so a burst of typing costs one request per SEARCH_DEBOUNCE_MS at most and the
// final value always fires; a change resets to page 1.
const searchBox = document.getElementById("q");
searchBox.value = query;
let searchTimer = null;
searchBox.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const next = searchBox.value.trim();
    if (next === query) return;
    query = next;
    page = 1;
    refresh();
  }, SEARCH_DEBOUNCE_MS);
});

function fmtDate(iso) {
  return String(iso || "").slice(0, 10);
}

// One movement, as a coloured arrow and its size. Three outcomes, and they are
// three different statements: a rise or a fall; NO CHANGE; and nothing to
// compare with, which is what a player who was not on the board that long ago
// gets — and what everyone gets until the store is CHANGE_DAYS old. The last two
// both draw a dash, since neither is a movement, and the tooltip says which.
//
// A change too small to print at this precision is folded into "unchanged": a
// row reading "▲ 0.0" claims a rise nobody made.
function changeMark(v, decimals, what) {
  if (v == null) {
    return '<span class="chg flat" title="Nothing from ' + CHANGE_DAYS +
      ' days ago to compare against">–</span>';
  }
  const size = Math.abs(v).toFixed(decimals);
  if (Number(size) === 0) {
    return '<span class="chg flat" title="' + what + ' unchanged over the last ' +
      CHANGE_DAYS + ' days">–</span>';
  }
  const up = v > 0;
  return '<span class="chg ' + (up ? "up" : "down") + '" title="' + what + " " +
    (up ? "up " : "down ") + size + ' over the last ' + CHANGE_DAYS + ' days">' +
    (up ? "\u25B2" : "\u25BC") + " " + size + '</span>';
}

// ---- The cells both views share. A row is the same player either way; only
// what is being SAID about them changes, so the identity columns are one
// definition and the two builders differ in the columns that judge.

// The leaderboard position. NOT the row's place in the list: under any sort but
// the leaderboard's own the two are different numbers, and the one worth showing
// is where the player stands.
function rankText(p) {
  // A visitor's search match is ranked but carries no number (its place on the
  // tier board would need a count of everyone above it): blank, not a dash.
  if (p.rank == null && !ADMIN_MODE && !p.privateProfile && !p.inactive) return "";
  return p.rank == null ? '<span class="muted">–</span>' : String(p.rank);
}

// That position's movement, in the column beside it. A rankless row (private,
// lapsed) has no position for this to be a change IN, so it gets nothing.
function moveMark(p) {
  return p.rank == null ? "" : changeMark(p.rankChange7d, 0, "Position");
}

function nameCell(p) {
  // Two reasons a row can be off the leaderboard, and they are not the same.
  // PRIVATE: an admin hid it — no position and no rating (the API sends both as
  // null). INACTIVE: nobody hid anything, the player just has not played in a
  // while — no position, but the rating and the record are as public as ever.
  // Both are LISTED, in a tail after the ranked players; the admin view gets
  // them in their true places and the badges only say which rows a visitor sees
  // differently.
  const badge = p.privateProfile
    ? '<span class="privbadge" title="Private profile: not ranked, and its rating is not public">private</span>'
    : p.inactive
      ? '<span class="idlebadge" title="No rated game in the last ' + INACTIVE_DAYS +
        ' days — not ranked until they play again">inactive</span>'
      : '';
  // The column is fixed-width now, so a long name is ellipsed rather than
  // widening the table — the title is where the whole of it stays readable.
  return '<a class="plink" title="' + esc(p.name) + '" href="' +
    playerHref(p.userId) + '">' + esc(p.name) + '</a>' + badge;
}

// The rank tier with its name — the visitors' rating column, and the admin's
// own sortable column beside LOS.
function tierCell(p) {
  return p.tier == null ? '<span class="pill none">–</span>' : rankBadge(p.tier, p.games, { size: 28, text: true });
}

function losPill(p) {
  // The blank rides in a pill box too (see .pill.none) so the LOS column reads
  // straight down past the private tail instead of stepping sideways at it.
  return (p.los == null
    ? '<span class="pill none">–</span>'
    : '<span class="pill ' + ratingClass(p.los) + '">' + fmtLos(p.los) + '</span>');
}

function rowActionsCell(p) {
  return rowMenuCell(
    { id: p.userId, name: p.name, private: p.privateProfile ? "1" : "0" },
    "Player actions",
  );
}

// A row is built from the SAME column list the header is, so a column cannot be
// in one and not the other — and, since every cell carries its column's
// col-<key>, hiding a column on a narrow card is one rule rather than two.
function rankRow(p, columns) {
  const cells = columns
    .map((col) => '<td class="col-' + col.key + (col.td ? " " + col.td : "") + '">' + col.cell(p) + '</td>')
    .join("");
  const unranked = ADMIN_MODE ? p.rank == null : !!(p.privateProfile || p.inactive);
  return '<tr' + (unranked ? ' class="unranked"' : '') + '>' +
    cells + rowActionsCell(p) + '</tr>';
}

// What each view puts in its header and its rows. Columns are described rather
// than written out as markup because a header is now a control: the sort key is
// what makes one clickable, and the same list gives the colspan the empty-state
// message needs. The admin action column is in both views and is counted here,
// hidden or not — colspan is markup, not display.
// The table's columns, in order. Each MOVEMENT sits directly against the column
// it is a movement of — the rank's after #, the rating's after LOS — which is
// what lets both wear the same "Δ (7d)" label without ambiguity: one is a whole
// number of places, the other a rating to one decimal, and they are read next to
// the thing they moved. Described rather than written out as markup because a
// header is a control: the sort key is what makes one clickable, and the same
// list gives the colspan the empty-state message needs.
function tableColumns() {
  const over = " over the last " + CHANGE_DAYS + " days";
  // A visitor's "#" is the place on the tier board the list is in, so it is
  // not a sort of its own and has no movement column: both would be the LOS
  // order again. The admin keeps the leaderboard and both movements, with the
  // tier board one click away on the Rank column.
  if (!ADMIN_MODE) {
    return [
      { key: "rank", th: "num rankhead", td: "rankno", label: "#", cell: rankText },
      { key: "player", td: "name", label: "Player", cell: nameCell },
      { key: "tier", th: "rating", td: "rating", label: "Rank", sort: "tier",
        title: "Rank, then games played", cell: tierCell },
    ].concat(statColumns());
  }
  return [
    { key: "rank", th: "num rankhead", td: "rankno", label: "#", sort: "rank",
      title: "Position on the leaderboard", cell: rankText },
    { key: "rankchg", th: "chgcol", td: "chgcol", label: "\u0394 (7d)", sort: "rankChange",
      title: "Positions gained or lost" + over, cell: moveMark },
    { key: "player", td: "name", label: "Player", cell: nameCell },
    { key: "tier", th: "rating", td: "rating", label: "Rank", sort: "tier",
      title: "Rank, then games played", cell: tierCell },
    { key: "los", th: "rating", td: "rating", label: "LOS", sort: "los", cell: losPill },
    { key: "loschg", th: "chgcol", td: "chgcol", label: "\u0394 (7d)", sort: "losChange",
      title: "LOS gained or lost" + over, cell: (p) => changeMark(p.losChange7d, 1, "LOS") },
  ].concat(statColumns());
}

function statColumns() {
  return [
    { key: "games", th: "num", td: "num", label: "Games", cell: (p) => p.games },
    { key: "wl", th: "num", td: "num", label: "W–L",
      cell: (p) => '<span class="res-w">' + p.wins + '</span><span class="muted">–</span>' +
        '<span class="res-l">' + p.losses + '</span>' },
    { key: "win", th: "num", td: "num", label: "Win%",
      cell: (p) => (p.games > 0 ? Math.round((p.wins / p.games) * 100) + "%" : "") },
    { key: "last", th: "num", td: "num muted", label: "Last game",
      cell: (p) => esc(fmtDate(p.lastPlayed)) },
  ];
}

// One header. A sortable one is a real control — focusable, activated by
// Enter/Space as well as a click, and carrying aria-sort — rather than a <th>
// that merely happens to react to a pointer.
function headerCell(col) {
  // col-<key> is what the fixed layout's widths hang off — see the table-layout
  // note in the styles. Only the header row's cells decide a column's width.
  const cls = "col-" + col.key + " " + (col.th ? col.th + " " : "") +
    (col.sort ? "sortable " : "") + (col.sort === sort ? "sorted" : "");
  if (!col.sort) {
    return '<th' + (cls.trim() ? ' class="' + cls.trim() + '"' : '') + '>' + col.label + '</th>';
  }
  const active = col.sort === sort;
  const way = active ? (dir === "asc" ? "ascending" : "descending") : "none";
  // The arrow points the way the list actually reads: up for ascending.
  const mark = active ? (dir === "asc" ? "\u25B2" : "\u25BC") : "";
  const hint = (col.title || col.label) +
    (active ? " — sorted " + (dir === "asc" ? "ascending" : "descending") + ", click to reverse"
            : " — click to sort");
  return '<th class="' + cls.trim() + '" data-sort="' + col.sort + '" role="button" tabindex="0"' +
    ' aria-sort="' + way + '" title="' + esc(hint) + '">' + col.label +
    '<span class="sortmark">' + mark + '</span></th>';
}

// ---- The ranking's row actions (the shared "\u22ef" menu, SHARED_JS): one
// per-player toggle. The whole column is hidden by CSS unless admin mode
// marked <body>, exactly like the games table's own menu.
rowMenuActions = (btn) => {
  const userId = Number(btn.getAttribute("data-id"));
  const name = btn.getAttribute("data-name") || String(userId);
  const isPrivate = btn.getAttribute("data-private") === "1";
  return [
    {
      label: isPrivate ? "\uD83D\uDD13 Make public" : "\uD83D\uDD12 Make private",
      title: isPrivate
        ? "Show this player on the ranking and their full profile again"
        : "Hide this player from the ranking; their profile page shows no rating",
      onClick: (item) => setPrivate(userId, name, !isPrivate, item),
    },
  ];
};

// POST the toggle, then reload the page of the leaderboard: hiding or showing a
// player shifts every rank below them, so nothing on screen is still right.
async function setPrivate(userId, name, isPrivate, btn) {
  btn.disabled = true;
  btn.textContent = "\u2026";
  try {
    await postJson("/api/players/" + encodeURIComponent(userId) + "/private",
      { private: isPrivate });
    closeRowMenu();
    refresh();
  } catch (e) {
    closeRowMenu();
    noticeDialog({
      title: "Could not change the profile",
      message: name + "\u2019s profile visibility was not changed: " + (e.message || e),
      tone: "error",
    });
  }
}

// Only the table and the pager's state re-render; the shell around them stays.
function renderRanking(data) {
  if (data.inactiveDays) INACTIVE_DAYS = data.inactiveDays;
  if (data.changeDays) CHANGE_DAYS = data.changeDays;
  // What the server actually ordered by, which is not always what was asked:
  // an unrecognized key falls back there rather than erroring, and the header
  // must mark the column the rows are really in.
  if (data.sort) sort = data.sort;
  if (data.dir) dir = data.dir;
  const columns = tableColumns();
  totalPages = Math.max(1, Math.ceil(data.total / data.perPage));
  const rows = data.players.map((p) => rankRow(p, columns)).join("");
  document.getElementById("pageLabel").textContent = "Page " + data.page + " of " + totalPages +
    " · " + data.total + " player" + (data.total === 1 ? "" : "s");
  document.getElementById("sub").innerHTML = query
    ? data.total + ' player' + (data.total === 1 ? '' : 's') + ' starting with “' + esc(query) + '” · # = overall rank'
    : 'OpenSkill over lava games only';
  const emptyMsg = query ? 'no players match “' + esc(query) + '”' : 'no rated players yet';
  closeRowMenu(); // the rows it hung off are about to be replaced
  document.getElementById("root").innerHTML =
    '<table>' +
    '<thead><tr>' + columns.map(headerCell).join("") +
      '<th class="admin-col rowacts"></th></tr></thead>' +
    '<tbody>' + (rows ||
      '<tr><td colspan="' + (columns.length + 1) + '" class="empty">' + emptyMsg + '</td></tr>') +
    '</tbody></table>';
  const prev = document.getElementById("prev"), next = document.getElementById("next");
  prev.disabled = data.page <= 1;
  next.disabled = data.page >= totalPages;
}

// Clicking a sortable header sorts by it, in that column's own default
// direction; clicking the one already sorted reverses it. Either way the list
// starts again at page 1 — "page 3" of a differently ordered list is a
// different set of players, not the same one moved.
//
// Delegated from #root, since the header is rebuilt on every render.
function sortBy(key) {
  if (SORTS.indexOf(key) < 0) return;
  if (key === sort) dir = dir === "asc" ? "desc" : "asc";
  else { sort = key; dir = SORT_DEFAULT_DIR[key]; }
  page = 1;
  refresh();
}
document.getElementById("root").addEventListener("click", (e) => {
  const th = e.target.closest("th.sortable");
  if (th) sortBy(th.getAttribute("data-sort"));
});
document.getElementById("root").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const th = e.target.closest("th.sortable");
  if (!th) return;
  e.preventDefault(); // Space would scroll the page
  sortBy(th.getAttribute("data-sort"));
});

// Redraw the last 8 days of recorded ranks from the game log (POST
// /api/rank-history/rebuild). The repair for the days the once-a-day recorder
// could only approximate or never ran on — see LosDO.rebuildRankHistory. It
// is maintenance rather than something a visitor came for, so the button
// carries the admin-only class the sidebar's admin entries use: CSS-hidden
// unless SHARED_JS found admin mode.
const rebuildBtn = document.getElementById("rebuild");
rebuildBtn.onclick = async () => {
  const label = rebuildBtn.textContent;
  rebuildBtn.disabled = true;
  rebuildBtn.textContent = "rebuilding…";
  try {
    const res = await fetch("/api/rank-history/rebuild", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
    // The change columns were rewritten with it, so nothing on screen is still
    // right — including the rows this page is not showing.
    await refresh();
  } catch (e) {
    noticeDialog({
      title: "Could not rebuild the rank history",
      message: String(e.message || e),
      tone: "error",
    });
  } finally {
    rebuildBtn.disabled = false;
    rebuildBtn.textContent = label;
  }
};
document.getElementById("prev").onclick = () => { if (page > 1) { page--; refresh(); } };
document.getElementById("next").onclick = () => { if (page < totalPages) { page++; refresh(); } };
const perSelect = document.getElementById("pgPer");
perSelect.value = String(perPage);
perSelect.onchange = () => { perPage = Number(perSelect.value); page = 1; refresh(); };

async function refresh() {
  const meta = document.getElementById("meta");
  const seq = ++requestSeq;
  try {
    // withAdmin: in admin mode the hidden profiles are listed too, marked with
    // the "private" badge and toggleable from the row menu.
    const url = withAdmin("/api/ranking?page=" + page + "&perPage=" + perPage +
      "&sort=" + sort + "&dir=" + dir +
      (query ? "&q=" + encodeURIComponent(query) : ""));
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (seq !== requestSeq) return; // a newer request is in flight; drop this one
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (seq !== requestSeq) return;
    // Keep the view in the URL (?q=, ?page=, ?per=) so a refresh / back lands on it.
    syncPagingUrl(page, perPage, DEFAULT_PER_PAGE);
    const u = new URL(location.href);
    if (query) u.searchParams.set("q", query); else u.searchParams.delete("q");
    // Only a non-default order is worth carrying; the leaderboard's own is what
    // a bare /ranking already means.
    if (sort === DEFAULT_SORT && dir === SORT_DEFAULT_DIR[DEFAULT_SORT]) {
      u.searchParams.delete("sort");
      u.searchParams.delete("dir");
    } else {
      u.searchParams.set("sort", sort);
      u.searchParams.set("dir", dir);
    }
    history.replaceState(null, "", u);
    meta.textContent = "updated " + new Date().toLocaleTimeString();
    renderRanking(data);
  } catch (e) {
    if (seq !== requestSeq) return;
    meta.textContent = "";
    document.getElementById("root").innerHTML =
      '<div class="error">Failed to load ranking: ' + esc(e.message) + '</div>';
  }
}

refresh();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Player page (GET /player/:userId): profile, LOS-over-time chart, last 20 games.
// ---------------------------------------------------------------------------
export const PLAYER_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lavabalance · player</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell">
${sidebar("ranking")}
<div class="main">
<header class="top">
  <h1>Player</h1>
  <span class="meta" id="meta">loading…</span>
  <a class="back" href="/ranking">← ranking</a>
</header>
<main id="root"><div class="empty">loading…</div></main>
</div>
</div>

<script>
${SHARED_JS}

// The BAR account id from the URL path (/player/:userId).
const USER_ID = Number(decodeURIComponent(location.pathname.split("/")[2] || ""));

function fmtDate(iso) {
  return String(iso || "").slice(0, 10);
}

function stat(k, v) {
  return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
}

function profileCard(p) {
  const winRate = p.games > 0 ? Math.round((p.wins / p.games) * 100) + "%" : "–";
  // The same position the ranking page the reader came from shows: a visitor's
  // rank among the players that list numbers, an admin's TRUE one over everyone
  // (so an admin does see a private profile's real place). The dash is the
  // guard for a profile the API sent no rank for.
  const rank = p.rank == null
    ? '<span class="muted" title="' +
      (p.inactive ? 'Not ranked: no rated game in the last ' + (p.inactiveDays || 35) + ' days'
                  : 'Not ranked') + '">–</span>'
    : "#" + p.rank + " of " + p.rankedOf;
  // Only an admin ever gets a private profile's card at all (a normal visitor
  // gets the notice instead), so that badge is a reminder of what they are
  // seeing. The inactive one is for everybody: it is what explains the dash
  // where the rank goes on a profile that is otherwise completely public.
  const badge = (p.privateProfile
    ? '<span class="privbadge" title="Hidden from the public ranking and player page">private</span>'
    : '') +
    (p.inactive
      ? '<span class="idlebadge" title="No rated game in the last ' + (p.inactiveDays || 35) +
        ' days — not ranked until they play again">inactive</span>'
      : '');
  return '<div class="card"><div class="profile">' +
    '<div class="who">' +
      (p.tier ? rankBadge(p.tier, p.games, { size: 72, text: true }) : '') +
      '<span class="pname2">' + esc(p.name) + '</span>' + badge +
      (p.los == null ? '' :
      '<span class="pill big ' + ratingClass(p.los) + '" title="' + (p.games < 35 ? 'LOS = max(μ − rookie handicap − σ, 0); the handicap fades out over the first 35 rated games' : 'LOS = max(μ − σ, 0)') + '">' +
        fmtLos(p.los) + '</span>') +
    '</div>' +
    '<div class="stats">' +
      // The leaderboard position is the LOS order, so only an admin sees it.
      (ADMIN_MODE ? stat("Rank", rank) : "") +
      stat("Games", String(p.games)) +
      stat("W–L", '<span class="res-w">' + p.wins + '</span><span class="muted">–</span>' +
        '<span class="res-l">' + p.losses + '</span> <span class="muted">(' + winRate + ')</span>') +
      (p.mu != null ? stat("μ / σ", p.mu.toFixed(2) + " / " + p.sigma.toFixed(2)) : "") +
      stat("First game", esc(fmtDate(p.firstPlayed))) +
      stat("Last game", esc(fmtDate(p.lastPlayed))) +
      (p.barOs != null ? stat("BAR OS", fmtLos(p.barOs)) : "") +
    '</div>' +
  '</div></div>';
}

// ---- LOS-over-time chart (canvas, no library) ----
// Two X-axis modes, toggled under the axis (preference persisted):
//   • "time"  — x = the game's start timestamp, linear from the first rated game to
//               the END OF THE CURRENT DAY (point density reflects how often the
//               player actually played; a break is a flat gap; time since the last
//               game is empty space on the right).
//   • "games" — x = the game's ordinal (1..N), equidistant.
// y = LOS after that game, on a FIXED 0–60 axis shared by every player's chart so
// two charts compare at a glance. Dots are colored by that game's result.
// ZOOM (X only): drag a range with the mouse to zoom into it; double-click or the
// "reset zoom" control restores the full axis. Switching modes resets the zoom.

const PAD_L = 46, PAD_R = 14, PAD_T = 12, PAD_B = 26;
const Y_MIN = 0, Y_MAX = 60;
let chartPoints = [];
let chartTimes = []; // Date.parse of each point's startTime, index-aligned
let chartMode = localStorage.getItem("chartAxis") === "games" ? "games" : "time";
let chartZoom = null;   // [lo, hi] in axis units (ms in time mode, game ordinal in games mode)
let chartSel = null;    // [x0, x1] CSS px while a range is being dragged

// Axis value of point i in the current mode (time mode: its timestamp; games: 1-based ordinal).
function axisValue(i) {
  return chartMode === "games" ? i + 1 : chartTimes[i];
}

// The FULL axis domain (before zoom) for the current mode.
function fullDomain() {
  const n = chartPoints.length;
  if (!n) return [0, 0];
  if (chartMode === "games") return [1, n];
  const t0 = chartTimes[0];
  // The axis runs to the end of TODAY (UTC, matching the UTC date labels), not to
  // the last game — clamped so a game somehow timestamped later still fits.
  const now = new Date();
  const endOfToday =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - 1;
  return [t0, Math.max(endOfToday, chartTimes[n - 1])];
}

function chartScale(canvas) {
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  const W = cssW - PAD_L - PAD_R, H = cssH - PAD_T - PAD_B;
  const dom = chartZoom || fullDomain();
  const d0 = dom[0], dSpan = dom[1] - dom[0];
  const xOf = (v) => PAD_L + (dSpan <= 0 ? W / 2 : ((v - d0) / dSpan) * W);
  const valueAt = (x) => (dSpan <= 0 ? d0 : d0 + ((x - PAD_L) / W) * dSpan);
  return {
    cssW, cssH, W, H,
    d0, dSpan, xOf, valueAt,
    x: (i) => xOf(axisValue(i)),
    y: (v) => PAD_T + (1 - (v - Y_MIN) / (Y_MAX - Y_MIN)) * H,
    min: Y_MIN, max: Y_MAX,
    // Is point i inside the (possibly zoomed) domain?
    visible: (i) => axisValue(i) >= d0 && axisValue(i) <= d0 + dSpan,
  };
}

// X ticks for the visible domain: as many as fit (~one per 70px) at "nice" steps.
// Games mode: whole ordinals at 1/2/5×10^k steps. Time mode: calendar-aligned
// UTC steps — hours, days, weeks (Mondays), months, years — labelled by the
// finest unit the step needs. Returns [{v, label}] in axis units.
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
function chartTicks(sc) {
  const out = [];
  if (sc.dSpan <= 0) return [{ v: sc.d0, label: axisLabel(sc.d0) }];
  const want = Math.max(2, Math.floor(sc.W / 70));
  const lo = sc.d0, hi = sc.d0 + sc.dSpan;
  if (chartMode === "games") {
    const raw = sc.dSpan / want;
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((st) => st >= raw) || 10 * pow;
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push({ v, label: "#" + v });
    return out;
  }
  // Time: candidate steps, coarsest that still yields at least the wanted ticks — else the finest.
  const steps = [
    { ms: HOUR, unit: "hour" }, { ms: 3 * HOUR, unit: "hour" }, { ms: 6 * HOUR, unit: "hour" },
    { ms: 12 * HOUR, unit: "hour" }, { ms: DAY, unit: "day" }, { ms: 2 * DAY, unit: "day" },
    { ms: 7 * DAY, unit: "week" }, { ms: 14 * DAY, unit: "week" },
    { ms: 30 * DAY, unit: "month", n: 1 }, { ms: 61 * DAY, unit: "month", n: 2 },
    { ms: 91 * DAY, unit: "month", n: 3 }, { ms: 183 * DAY, unit: "month", n: 6 },
    { ms: 365 * DAY, unit: "year", n: 1 }, { ms: 730 * DAY, unit: "year", n: 2 },
    { ms: 1826 * DAY, unit: "year", n: 5 },
  ];
  let step = steps[steps.length - 1];
  for (const st of steps) { if (sc.dSpan / st.ms <= want) { step = st; break; } }
  const d = new Date(lo);
  const label = (t) => {
    const x = new Date(t);
    if (step.unit === "hour") return x.toISOString().slice(5, 16).replace("T", " ");
    if (step.unit === "year") return String(x.getUTCFullYear());
    if (step.unit === "month") return x.toISOString().slice(0, 7);
    return x.toISOString().slice(5, 10);
  };
  if (step.unit === "hour") {
    const stepH = step.ms / HOUR;
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
      Math.ceil(d.getUTCHours() / stepH) * stepH);
    for (; t <= hi; t += step.ms) if (t >= lo) out.push({ v: t, label: label(t) });
  } else if (step.unit === "day") {
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    if (t < lo) t += DAY;
    for (; t <= hi; t += step.ms) out.push({ v: t, label: label(t) });
  } else if (step.unit === "week") {
    // Align to Monday 00:00 UTC.
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    t -= ((new Date(t).getUTCDay() + 6) % 7) * DAY;
    while (t < lo) t += step.ms;
    for (; t <= hi; t += step.ms) out.push({ v: t, label: label(t) });
  } else if (step.unit === "month") {
    let y = d.getUTCFullYear(), m = Math.ceil(d.getUTCMonth() / step.n) * step.n;
    for (;;) {
      const t = Date.UTC(y, m, 1);
      if (t > hi) break;
      if (t >= lo) out.push({ v: t, label: label(t) });
      m += step.n; if (m >= 12) { m -= 12; y++; }
    }
  } else {
    let y = Math.ceil(d.getUTCFullYear() / step.n) * step.n;
    for (;; y += step.n) {
      const t = Date.UTC(y, 0, 1);
      if (t > hi) break;
      if (t >= lo) out.push({ v: t, label: label(t) });
    }
  }
  // A degenerate window (shorter than one step) still gets its endpoints.
  if (out.length < 2) return [{ v: lo, label: axisLabel(lo) }, { v: hi, label: axisLabel(hi) }];
  return out;
}

// A full label for an axis value (tooltip-style; used for the degenerate tick case).
function axisLabel(v) {
  if (chartMode === "games") return "#" + Math.round(v);
  const d = new Date(v);
  return (chartZoom && chartZoom[1] - chartZoom[0] < 3 * DAY)
    ? d.toISOString().slice(0, 16).replace("T", " ")
    : d.toISOString().slice(0, 10);
}

function drawChart(hoverIdx) {
  const canvas = document.getElementById("chart");
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const sc = chartScale(canvas);
  canvas.width = Math.round(sc.cssW * dpr);
  canvas.height = Math.round(sc.cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, sc.cssW, sc.cssH);
  const pts = chartPoints;
  if (!pts.length || sc.W <= 0) return;

  // Horizontal grid + y labels: one line every 10 LOS on the fixed 0–60 axis.
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  for (let v = sc.min; v <= sc.max; v += 10) {
    const yy = sc.y(v);
    ctx.strokeStyle = "#20242c";
    ctx.beginPath(); ctx.moveTo(PAD_L, yy); ctx.lineTo(sc.cssW - PAD_R, yy); ctx.stroke();
    ctx.fillStyle = "#6b7480"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(String(v), PAD_L - 7, yy);
  }
  // X ticks over the visible DOMAIN (axis positions, not particular games): faint
  // vertical grid lines plus a label under each, as many as the width fits.
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (const tk of chartTicks(sc)) {
    const tx = sc.xOf(tk.v);
    if (tx < PAD_L - 0.5 || tx > sc.cssW - PAD_R + 0.5) continue;
    ctx.strokeStyle = "#1b1f26";
    ctx.beginPath(); ctx.moveTo(tx, PAD_T); ctx.lineTo(tx, sc.cssH - PAD_B); ctx.stroke();
    ctx.fillStyle = "#6b7480";
    const lx = Math.min(Math.max(tx, PAD_L + 18), sc.cssW - PAD_R - 18);
    ctx.fillText(tk.label, lx, sc.cssH - PAD_B + 8);
  }
  // Everything data-bound is clipped to the plot area so a zoomed line/dots stop at
  // the axes instead of spilling over the labels.
  ctx.save();
  ctx.beginPath(); ctx.rect(PAD_L, 0, sc.W, sc.cssH - PAD_B); ctx.clip();
  // The LOS line.
  ctx.strokeStyle = "#4d9fff"; ctx.lineWidth = 2; ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(sc.x(i), sc.y(p.los)) : ctx.moveTo(sc.x(i), sc.y(p.los))));
  ctx.stroke();
  // Win/loss dots (shrink when many are visible).
  let shown = 0;
  for (let i = 0; i < pts.length; i++) if (sc.visible(i)) shown++;
  const r = shown > 150 ? 1.6 : shown > 60 ? 2.2 : 3;
  pts.forEach((p, i) => {
    if (!sc.visible(i)) return;
    ctx.fillStyle = p.won ? "#5cc274" : "#e06c6c";
    ctx.beginPath(); ctx.arc(sc.x(i), sc.y(p.los), r, 0, Math.PI * 2); ctx.fill();
  });
  // Hover crosshair + emphasized point.
  if (hoverIdx != null && pts[hoverIdx]) {
    const hx = sc.x(hoverIdx), hy = sc.y(pts[hoverIdx].los);
    ctx.strokeStyle = "#3a414c";
    ctx.beginPath(); ctx.moveTo(hx, PAD_T); ctx.lineTo(hx, sc.cssH - PAD_B); ctx.stroke();
    ctx.fillStyle = pts[hoverIdx].won ? "#5cc274" : "#e06c6c";
    ctx.beginPath(); ctx.arc(hx, hy, r + 2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(hx, hy, r + 2, 0, Math.PI * 2); ctx.stroke();
  }
  // The range being dragged (zoom selection).
  if (chartSel) {
    const a = Math.min(chartSel[0], chartSel[1]), b = Math.max(chartSel[0], chartSel[1]);
    ctx.fillStyle = "rgba(77, 159, 255, .15)";
    ctx.fillRect(a, PAD_T, b - a, sc.H);
    ctx.strokeStyle = "rgba(77, 159, 255, .6)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a, PAD_T); ctx.lineTo(a, PAD_T + sc.H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(b, PAD_T); ctx.lineTo(b, PAD_T + sc.H); ctx.stroke();
  }
  ctx.restore();
}

// Apply/reset the X zoom and reflect it in the axis controls.
function setChartZoom(z) {
  chartZoom = z;
  const reset = document.getElementById("chartReset");
  if (reset) reset.hidden = !z;
  drawChart(null);
}

function setChartMode(mode) {
  chartMode = mode === "games" ? "games" : "time";
  try { localStorage.setItem("chartAxis", chartMode); } catch (e) { /* private mode */ }
  document.querySelectorAll("#chartModes button").forEach((b) => {
    b.classList.toggle("on", b.getAttribute("data-mode") === chartMode);
  });
  setChartZoom(null); // a zoom range is meaningless across modes
}

function wireChartHover() {
  const canvas = document.getElementById("chart");
  const tip = document.getElementById("chartTip");
  if (!canvas || !tip) return;
  const mouseX = (e) => e.clientX - canvas.getBoundingClientRect().left;
  let dragStart = null; // CSS px where a mousedown happened (null while not dragging)

  canvas.addEventListener("mousemove", (e) => {
    const pts = chartPoints;
    if (!pts.length) return;
    const rect = canvas.getBoundingClientRect();
    const sc = chartScale(canvas);
    const mx = mouseX(e);
    // While dragging a range: extend the selection, no tooltip.
    if (dragStart != null) {
      chartSel = [dragStart, Math.min(Math.max(mx, PAD_L), sc.cssW - PAD_R)];
      canvas.classList.add("selecting");
      tip.hidden = true;
      drawChart(null);
      return;
    }
    // Nearest VISIBLE point by pixel distance on the axis (points are unevenly
    // spaced in time mode, so a linear index guess would snap to the wrong game).
    let i = -1, best = Infinity;
    for (let j = 0; j < pts.length; j++) {
      if (!sc.visible(j)) continue;
      const d = Math.abs(sc.x(j) - mx);
      if (d < best) { best = d; i = j; }
    }
    if (i < 0) { tip.hidden = true; drawChart(null); return; }
    drawChart(i);
    const p = pts[i];
    const prev = i > 0 ? pts[i - 1].los : null;
    const delta = prev != null ? p.los - prev : null;
    const deltaTxt = delta == null ? "" :
      ' · <span class="' + (delta >= 0 ? "delta-up" : "delta-down") + '">' +
      (delta >= 0 ? "+" : "") + delta.toFixed(2) + '</span>';
    tip.innerHTML = "game #" + p.gameNumber + " · " + esc(fmtDate(p.startTime)) +
      " · " + (p.won ? '<span class="res-w">W</span>' : '<span class="res-l">L</span>') +
      " · LOS " + fmtLos(p.los) + deltaTxt;
    tip.hidden = false;
    const tipX = Math.min(Math.max(sc.x(i) + 10, 4), rect.width - tip.offsetWidth - 4);
    tip.style.left = tipX + "px";
    tip.style.top = Math.max(sc.y(p.los) - 34, 2) + "px";
  });
  // Drag-to-zoom on the X axis: mousedown starts a range, mouseup applies it (a
  // sub-4px drag is treated as a click and ignored). The mouseup is on window so
  // releasing outside the canvas still finishes the selection.
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !chartPoints.length) return;
    e.preventDefault();
    const sc = chartScale(canvas);
    dragStart = Math.min(Math.max(mouseX(e), PAD_L), sc.cssW - PAD_R);
  });
  window.addEventListener("mouseup", (e) => {
    if (dragStart == null) return;
    const sc = chartScale(canvas);
    const end = Math.min(Math.max(mouseX(e), PAD_L), sc.cssW - PAD_R);
    const a = Math.min(dragStart, end), b = Math.max(dragStart, end);
    dragStart = null;
    chartSel = null;
    canvas.classList.remove("selecting");
    if (b - a < 4) { drawChart(null); return; }
    let lo = sc.valueAt(a), hi = sc.valueAt(b);
    if (chartMode === "games") {
      // Snap to whole games, keeping at least two so the range is a range.
      lo = Math.max(1, Math.round(lo)); hi = Math.min(chartPoints.length, Math.round(hi));
      if (hi <= lo) hi = Math.min(chartPoints.length, lo + 1);
      if (hi <= lo) return;
    }
    setChartZoom([lo, hi]);
  });
  canvas.addEventListener("dblclick", () => setChartZoom(null));
  canvas.addEventListener("mouseleave", () => { tip.hidden = true; if (dragStart == null) drawChart(null); });
  window.addEventListener("resize", () => drawChart(null));

  // The axis controls under the chart.
  document.querySelectorAll("#chartModes button").forEach((b) => {
    b.addEventListener("click", () => setChartMode(b.getAttribute("data-mode")));
  });
  const reset = document.getElementById("chartReset");
  if (reset) reset.addEventListener("click", () => setChartZoom(null));
  setChartMode(chartMode);
}

// ---- Games table (every game, newest first, paged) — the /games layout, seen
// from this player: their result, THEIR side's pre-game win chance, their LOS
// before the game and the change it caused, and both rosters with them leading
// their side. Rows open the game page. Paged over /api/players/:id/games with
// the page and per-page in the URL (?page=, ?per=), like the Games tab.
const DEFAULT_PER_PAGE = 10;
let perPage = perPageFromUrl(DEFAULT_PER_PAGE);
let page = Math.max(1, Number(PAGE_PARAMS.get("page")) || 1);
let totalPages = 1;

// A private profile still lists its games — the API just serves no rating with
// them (nulls throughout, plus privateProfile: true), so the two LOS columns are
// dropped rather than filled with dashes. The win-chance column stays: it is the
// GAME's pre-game prediction, public on /games whoever is looking.
let hideLos = false;

function gameRow(g) {
  const res = g.won ? '<span class="res-w">W</span>' : '<span class="res-l">L</span>';
  const before = g.losBefore == null
    ? '<span class="muted">–</span>'
    : '<span class="pill ' + ratingClass(g.losBefore) + '">' + fmtLos(g.losBefore) + '</span>';
  const delta = g.losDelta == null
    ? '<span class="muted">–</span>'
    : '<span class="' + (g.losDelta >= 0 ? "delta-up" : "delta-down") + '">' +
      (g.losDelta >= 0 ? "+" : "") + g.losDelta.toFixed(2) + '</span>';
  // Their rank going into the game: the emblem alone for a visitor, beside the
  // LOS pill for an admin.
  const rank = g.tier ? rankBadge(g.tier, g.gameNumber != null ? g.gameNumber - 1 : 0, { size: ADMIN_MODE ? 24 : 30 }) : '';
  const losCells = hideLos ? ''
    : ADMIN_MODE ? '<td class="rating">' + rank + before + '</td><td class="delta">' + delta + '</td>'
    : '<td class="rating">' + (rank || '<span class="muted">–</span>') + '</td>';
  return '<tr class="game-row" data-href="' + esc(gameHref(g.id)) + '">' +
    '<td class="when">' + rowLink(gameHref(g.id), fmtWhen(g.startTime)) + '</td>' +
    '<td class="dur">' + esc(fmtDur(g.durationMs)) + '</td>' +
    '<td class="result">' + res + '</td>' +
    '<td class="num pct">' + resultChanceCell(g, g.team, g.won) + '</td>' +
    losCells +
    '<td class="roster">' + rostersCell(g, USER_ID) + '</td>' +
    replayCell(g) +
    '</tr>';
}

function renderGames(data) {
  hideLos = data.privateProfile === true;
  totalPages = Math.max(1, Math.ceil(data.total / data.perPage));
  const games = data.games.map(gameRow).join("");
  const losHeaders = hideLos ? ''
    : ADMIN_MODE ? '<th class="rating">LOS before</th><th class="num">Δ LOS</th>'
    : '<th class="rating" title="rank going into the game">Rank</th>';
  const cols = hideLos ? 6 : ADMIN_MODE ? 8 : 7;
  document.getElementById("gamesCard").innerHTML =
    '<h2>🎮 Games <span class="sub">' + data.total + ' game' + (data.total === 1 ? "" : "s") +
      (hideLos ? ' · ratings hidden' : '') + '</span></h2>' +
    pagerBar(data, totalPages, perPage) +
    '<table class="games-table">' +
    '<thead><tr><th>Started</th><th>Duration</th><th>Result</th>' +
    winChanceHeader("Win chance", "This player\u2019s side\u2019s chance to win, predicted before the game from the ratings of everyone playing. The colour is the chance of the result they actually got \u2014 gray when the likely thing happened, green for an upset they won and red for one they lost (under 25%), bold under 15%.") +
    losHeaders + '<th>Players</th>' +
    '<th class="links">Links</th></tr></thead>' +
    '<tbody id="rows">' + (games || '<tr><td colspan="' + cols + '" class="empty">no games</td></tr>') +
    '</tbody></table>';
  wirePager(page, totalPages,
    (n) => { page = n; loadGames(); },
    (n) => { perPage = n; page = 1; loadGames(); });
  if (games) wireRowClicks("rows");
}

async function loadGames() {
  const card = document.getElementById("gamesCard");
  try {
    // replays=true: the worker resolves each row's barreplay status before it
    // answers, so the Links column is right the first time it is drawn.
    const res = await fetch(withAdmin("/api/players/" + USER_ID + "/games?page=" + page +
      "&limit=" + perPage + "&replays=true"),
      { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    syncPagingUrl(page, perPage, DEFAULT_PER_PAGE);
    renderGames(data);
  } catch (e) {
    card.innerHTML = '<div class="error">Failed to load games: ' + esc(e.message) + '</div>';
  }
}

// ---- Play style (OneTrickLava's scouting card, GET /api/scout/:userId) ----
//
// Behaviour mined from the player's replays by onetricklava: archetypes, the
// warning badges, the lanes they start on and how they do there, trait means and
// commander habits. Absent (404) for a player OTL has no card for, and never
// served for a private profile to a visitor.

// The trait bars: each is scaled so OTL's own "this is high" threshold (the one
// its archetype tags use) sits at 60% of the bar.
const TRAITS = [
  ["aggression", "Aggression", 0.12, "share of their actions that are attacks"],
  ["ecoFocus", "Eco focus", 0.45, "share of their build spent on economy"],
  ["defenseFocus", "Defense", 0.30, "share of their build spent on defenses"],
  ["forwardness", "Forwardness", 0.10, "how far forward they build and fight"],
];

function traitRow(t, key, label, high, tip) {
  const v = t[key];
  if (v == null) return "";
  const w = Math.min(100, Math.round((v / high) * 60));
  return '<div class="trait-row" title="' + esc(tip) + '"><span class="tn">' + esc(label) + '</span>' +
    '<div class="bar' + (v >= high ? " warm" : "") + '"><span style="width:' + w + '%"></span></div>' +
    '<span class="tv">' + pctTxt(v) + '</span></div>';
}

function playStyleCard(card) {
  const lanes = (card.lanes || []).map((l) =>
    '<div class="lane-row"><span class="ln">' + esc(l.name) + '</span>' +
      '<div class="bar"><span style="width:' + Math.round(Math.min(1, l.share) * 100) + '%"></span></div>' +
      '<span class="g" title="games started on this lane">' + esc(l.games) + 'g</span>' +
      '<span class="wr ' + wrClass(l.winRate) + '" title="win rate on this lane (decided games)">' +
        pctTxt(l.winRate) + '</span></div>').join("");
  const badges = (card.badges || []).map((b) =>
    '<div class="badge-line"><span class="ic">' + esc(b.icon || "•") + '</span><div><b>' + esc(b.label) +
      '</b><span>' + esc(b.caption || "") + '</span></div></div>').join("");
  const c = card.commander || {}, t = card.traits || {};
  const habits = [];
  if (c.bombRate != null) habits.push(["Comm bombs", pctTxt(c.bombRate) + " of games"]);
  if (c.dropRate != null) habits.push(["Comm drops", pctTxt(c.dropRate) + " of games"]);
  if (c.walkRate != null) habits.push(["Comm walks", pctTxt(c.walkRate) + " of games"]);
  if (c.firstDgunS != null) habits.push(["First D-gun", "~" + fmtMinSec(c.firstDgunS)]);
  if (t.firstOffenseS != null) habits.push(["First attack", "~" + fmtMinSec(t.firstOffenseS)]);
  if (t.apm != null) habits.push(["APM", String(Math.round(t.apm))]);
  if (card.faction) habits.push(["Faction", card.faction]);
  const kv = habits.map((h) => '<div><span class="k">' + esc(h[0]) + '</span><span class="v">' +
    esc(h[1]) + '</span></div>').join("");
  return '<div class="card">' +
    '<h2>🔭 Play style <span class="sub">' + esc(card.games) + ' games parsed · won ' +
      pctTxt(card.winRate) + '</span></h2>' +
    '<div class="style-body">' +
      '<div><h4>Archetypes</h4><div class="archs">' +
        (card.archetypes && card.archetypes.length ? archChips(card.archetypes) : '<span class="muted">–</span>') +
        '</div>' + (badges ? '<h4 style="margin-top:14px">Warnings</h4>' + badges : '') + '</div>' +
      (lanes ? '<div><h4>Lanes (Supreme Isthmus)</h4>' + lanes + '</div>' : '') +
      '<div><h4>Traits</h4>' + TRAITS.map((x) => traitRow(t, x[0], x[1], x[2], x[3])).join("") +
        (kv ? '<div class="kv" style="margin-top:10px">' + kv + '</div>' : '') + '</div>' +
    '</div>' +
    '<div class="src-note">From OneTrickLava’s analysis of this player’s lava replays' +
      (card.lastSeen ? ' · last seen ' + esc(String(card.lastSeen).slice(0, 10)) : '') + '.</div>' +
  '</div>';
}

// The card, or nothing (no card / private / the lookup failed — never an error box:
// the LOS profile is the page, this is a bonus on it).
async function loadPlayStyle() {
  try {
    const res = await fetch(withAdmin("/api/scout/" + USER_ID), { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.card ? body.card : null;
  } catch (e) {
    return null;
  }
}

// What a hidden profile shows a normal visitor in place of the profile card and
// the LOS chart. The games table below it still loads — without the ratings.
function privateNote(p) {
  return '<div class="card"><div class="private-note">' +
    '<span class="lock">\uD83D\uDD12</span>' +
    '<strong>' + esc(p.name) + '</strong>\u2019s profile is private.' +
    '<span class="sub">Their rating and rating history are not shown. ' +
      'Their games are listed below.</span>' +
    '</div></div>';
}

function renderPrivate(p) {
  document.getElementById("root").innerHTML =
    privateNote(p) +
    '<div class="card wide" id="gamesCard"><div class="empty">loading…</div></div>';
  loadGames();
}

function render(p, history, style) {
  chartPoints = history.points;
  chartTimes = chartPoints.map((pt) => Date.parse(pt.startTime));
  // The LOS chart is admin-only, like LOS itself.
  const chart = !ADMIN_MODE ? '' :
    '<div class="card">' +
      '<h2>📈 LOS over time <span class="sub">' + chartPoints.length +
        ' rated games · dot color = result</span></h2>' +
      '<div class="chartwrap"><canvas id="chart"></canvas>' +
      '<div class="chart-tip" id="chartTip" hidden></div>' +
      '<div class="chart-axis">' +
        '<span title="Drag a range on the chart to zoom the X axis; double-click to reset">X axis</span>' +
        '<span class="seg" id="chartModes">' +
          '<button type="button" data-mode="time">Time</button>' +
          '<button type="button" data-mode="games">Games</button>' +
        '</span>' +
        '<button type="button" class="reset" id="chartReset" hidden>reset zoom</button>' +
      '</div></div>' +
    '</div>';
  document.getElementById("root").innerHTML =
    profileCard(p) +
    (style ? playStyleCard(style) : "") +
    chart +
    '<div class="card wide" id="gamesCard"><div class="empty">loading…</div></div>';
  if (ADMIN_MODE) wireChartHover(); // also applies the persisted axis mode and draws
  loadGames();
}

async function load() {
  const meta = document.getElementById("meta");
  const root = document.getElementById("root");
  if (!Number.isFinite(USER_ID)) {
    meta.textContent = "";
    root.innerHTML = '<div class="error">Invalid player id.</div>';
    return;
  }
  try {
    const [pRes, hRes, style] = await Promise.all([
      fetch(withAdmin("/api/players/" + USER_ID), { headers: { accept: "application/json" } }),
      fetch(withAdmin("/api/players/" + USER_ID + "/history"),
        { headers: { accept: "application/json" } }),
      loadPlayStyle(),
    ]);
    if (pRes.status === 404) {
      meta.textContent = "";
      // No rated game here, but OneTrickLava may still know how they play.
      if (style) document.querySelector("header.top h1").textContent = style.name;
      root.innerHTML = '<div class="empty">This player has no rated lava games yet.</div>' +
        (style ? playStyleCard(style) : "");
      return;
    }
    if (!pRes.ok) throw new Error("HTTP " + pRes.status);
    if (!hRes.ok) throw new Error("HTTP " + hRes.status);
    const p = await pRes.json();
    const history = await hRes.json();
    document.title = "lavabalance · " + p.name;
    document.querySelector("header.top h1").textContent = p.name;
    meta.textContent = "updated " + new Date().toLocaleTimeString();
    // An admin (admin mode → ?includePrivate=true) gets the whole profile even
    // when it is private; everyone else gets the name and the flag, and the
    // notice takes the place of the card and the chart.
    if (p.privateProfile && p.los == null) { renderPrivate(p); return; }
    render(p, history, style);
  } catch (e) {
    meta.textContent = "";
    root.innerHTML = '<div class="error">Failed to load player: ' + esc(e.message) + '</div>';
  }
}

load();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Games page (GET /games): the paged games table, newest first, 20 per page by default.
// ---------------------------------------------------------------------------
export const GAMES_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lavabalance · games</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell">
${sidebar("games")}
<div class="main">
<header class="top">
  <h1>Games</h1>
  <span class="meta" id="meta">loading…</span>
</header>
<main id="root"><div class="empty">loading…</div></main>
</div>
</div>

<script>
${SHARED_JS}

// Numbered paging over /api/games?page=N&limit=M. The current page and per-page
// live in the URL (?page=, ?per=) so a refresh or a back-navigation lands on the
// same view.
const DEFAULT_PER_PAGE = 20;
let perPage = perPageFromUrl(DEFAULT_PER_PAGE);
let page = Math.max(1, Number(PAGE_PARAMS.get("page")) || 1);
let totalPages = 1;

function gameRow(g) {
  return '<tr class="game-row" data-href="' + esc(gameHref(g.id)) + '">' +
    '<td class="when">' + rowLink(gameHref(g.id), fmtWhen(g.startTime)) + '</td>' +
    '<td class="dur">' + esc(fmtDur(g.durationMs)) + '</td>' +
    (ADMIN_MODE ? '<td class="los">' + losCell(g) + '</td>' : '') +
    '<td class="num pct">' + winChanceCell(g, g.winnerTeam) + '</td>' +
    '<td class="roster">' + rostersCell(g, null) + '</td>' +
    linksCell(g) +
    rowMenuCell({ id: g.id, start: g.startTime, ignored: g.excluded ? "1" : "0" }, "Game actions") +
    '</tr>';
}

// ---- The games table's row actions (the shared "\u22ef" menu, SHARED_JS).
// The whole column rides admin mode, as the bare rebase button it
// replaced did.
//
// The two are deliberately separate things. Ignoring a game writes a marker
// and recalculates NOTHING; re-running LOS is what re-rates, and it honours
// every marker it passes. So the way to drop a game is: ignore it, then re-run
// from it — or ignore several and re-run once from the earliest.
rowMenuActions = (btn) => {
  const id = btn.getAttribute("data-id");
  const start = btn.getAttribute("data-start");
  const ignored = btn.getAttribute("data-ignored") === "1";
  return [
    {
      label: "\u27F3 Re-run LOS from here\u2026",
      title: "Re-rate this game in its chronological place, and every game after it",
      onClick: (item) => rebaseFrom(id, start, item),
    },
    {
      label: ignored ? "\u21A9 Un-ignore game" : "\uD83D\uDEAB Ignore game",
      title: ignored
        ? "Let LOS rate this game again — on the next re-run from it"
        : "Have the next LOS re-run leave this game unrated. Nothing is recalculated now",
      onClick: (item) => setIgnored(id, start, !ignored, item),
    },
  ];
};

// The note above the table after a marker was set or cleared: the toggle wrote
// a flag, so the ratings on screen have not moved and saying so is the whole
// point of the line. It survives the refresh that follows the toggle, which is
// why it lives out here rather than in the DOM.
//
// EVERY outstanding marker is kept, not just the last one, keyed by game id:
// the fold runs from one game's (start_time, id) FORWARD, so a re-run started
// at a LATER game leaves an earlier marker exactly as it was. The note points
// at the EARLIEST of them — a re-run from there covers all the rest — and a
// re-run only settles the markers it actually reached.
const pending = new Map();

/** Is fold position a at or after b? The fold orders by (start_time, id). */
function foldAtOrAfter(aStart, aId, bStart, bId) {
  return aStart !== bStart ? aStart > bStart : aId >= bId;
}

function earliestPending() {
  let best = null;
  for (const [id, p] of pending) {
    if (!best || !foldAtOrAfter(p.start, id, best.start, best.id)) {
      best = { id: id, start: p.start, text: p.text };
    }
  }
  return best;
}

function noteBar() {
  const note = earliestPending();
  if (!note) return "";
  const more = pending.size - 1;
  const rest = more > 0
    ? " " + more + " later marked game" + (more === 1 ? "" : "s") + " settles with it."
    : "";
  return '<div class="rownote" id="rownote"><span>' + esc(note.text + rest) + '</span>' +
    '<span class="spacer"></span>' +
    '<button type="button" id="noteRun">⟳ Re-run LOS from that game</button>' +
    '<button type="button" class="x" id="noteX" title="Dismiss">×</button></div>';
}

function wireNote() {
  const bar = document.getElementById("rownote");
  if (!bar) return;
  const note = earliestPending();
  document.getElementById("noteRun").onclick = (e) => rebaseFrom(note.id, note.start, e.currentTarget);
  // Dismissing is about the LINE, not the markers: every marked row keeps its
  // badge, which is where the durable truth is.
  document.getElementById("noteX").onclick = () => { pending.clear(); bar.remove(); };
}

// Mark a game ignored, or unmark it (POST /api/games/:id/ignored). No rating
// moves — see the note bar — so the reload is only there to redraw the badge
// and flip the menu entry.
async function setIgnored(id, start, ignored, item) {
  item.disabled = true;
  item.textContent = "\u2026";
  try {
    const body = await postJson("/api/games/" + encodeURIComponent(id) + "/ignored", { ignored: ignored });
    closeRowMenu();
    // Outstanding only while the marker and the stored ratings disagree: a game
    // that is already unrated needs no re-run to become unrated, and one whose
    // marker was just cleared back to what the fold already did is settled.
    if (body.needsRebase) {
      pending.set(id, {
        start: start,
        text: ignored
          ? "Marked ignored. Its ratings still stand \u2014 re-run LOS from it to drop them."
          : "No longer ignored. It is still unrated \u2014 re-run LOS from it to rate it.",
      });
    } else {
      pending.delete(id);
    }
    refresh();
  } catch (e) {
    closeRowMenu();
    noticeDialog({
      title: ignored ? "Could not ignore the game" : "Could not un-ignore the game",
      message: String(e.message || e),
      tone: "error",
    });
  }
}

// Re-run the LOS fold from one game onward: what it does is worth reading
// before it happens, and the off-map question rides in the same dialog rather
// than a second one. Then reload — every row after the rebase point may have
// changed.
async function rebaseFrom(id, start, item) {
  const choice = await confirmDialog({
    title: "Re-run LOS from this game?",
    message: "This game is rated in its chronological place and every later game re-rates on top " +
      "of it. Games marked ignored are left unrated.",
    confirmLabel: "Re-run LOS",
    option: {
      label: "Also rate games played off Supreme Isthmus",
      hint: "Leave this off unless you mean it \u2014 off-map games are normally left unranked.",
    },
  });
  if (!choice) return;
  // The menu it was opened from has served its purpose, and the fold can take a
  // while: the header carries the only thing there is to say until it answers.
  closeRowMenu();
  const meta = document.getElementById("meta");
  meta.textContent = "re-running LOS\u2026";
  item.disabled = true;
  try {
    const body = await postJson("/api/games/" + encodeURIComponent(id) + "/rebase",
      { includeOffMap: choice.option });
    // Only the markers this fold REACHED are settled by it: it ran from this
    // game's position forward, so anything marked earlier is still waiting.
    for (const [pid, p] of [...pending]) {
      if (foldAtOrAfter(p.start, pid, start, id)) pending.delete(pid);
    }
    refresh();
    noticeDialog({
      title: "LOS re-run",
      message: body.rated + " game" + (body.rated === 1 ? "" : "s") + " rated and " +
        body.ignored + " left unrated, over " + body.games + " re-folded.\\n" +
        body.players + " player" + (body.players === 1 ? "" : "s") + " rebuilt.",
    });
  } catch (e) {
    item.disabled = false;
    meta.textContent = "";
    noticeDialog({ title: "Re-run failed", message: String(e.message || e), tone: "error" });
  }
}

function renderGames(data) {
  totalPages = Math.max(1, Math.ceil(data.total / data.perPage));
  const rows = data.games.map(gameRow).join("");
  closeRowMenu(); // the rows it hung off are about to be replaced
  document.getElementById("root").innerHTML =
    '<div class="card wide">' +
    '<h2>🎮 Games <span class="sub">lava lobby games' + (ADMIN_MODE ? ' · LOS = team average before the game, gold ring = winner' : '') + '</span></h2>' +
    noteBar() +
    pagerBar(data, totalPages, perPage) +
    '<table class="games-table">' +
    '<thead><tr><th>Started</th><th>Duration</th>' + (ADMIN_MODE ? '<th class="los">LOS</th>' : '') +
    winChanceHeader("%", "Win chance of the team that won, predicted before the game from the ratings of everyone playing.") +
    '<th>Players</th><th class="links">Links</th><th class="admin-col rowacts"></th></tr></thead>' +
    '<tbody id="rows">' + (rows || '<tr><td colspan="7" class="empty">no games yet</td></tr>') +
    '</tbody></table>' +
    '</div>';

  wirePager(page, totalPages,
    (n) => { page = n; refresh(); },
    (n) => { perPage = n; page = 1; refresh(); });
  wireRowClicks("rows");
  wireNote();
}

async function refresh() {
  const meta = document.getElementById("meta");
  try {
    // replays=true has the worker resolve each row's barreplay status before it
    // answers, so the Links column is right the first time it is drawn.
    const url = withAdmin("/api/games?page=" + page + "&limit=" + perPage + "&replays=true");
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    syncPagingUrl(page, perPage, DEFAULT_PER_PAGE);
    meta.textContent = "updated " + new Date().toLocaleTimeString();
    renderGames(data);
  } catch (e) {
    meta.textContent = "";
    document.getElementById("root").innerHTML =
      '<div class="error">Failed to load games: ' + esc(e.message) + '</div>';
  }
}

refresh();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Game page (GET /game/:id): matchup strip, facts, and both rosters with each
// player's LOS before the game and the change it caused.
// ---------------------------------------------------------------------------
export const GAME_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lavabalance · game</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell">
${sidebar("games")}
<div class="main">
<header class="top">
  <h1>Game</h1>
  <span class="meta" id="meta">loading…</span>
  <a class="back" href="/games">← games</a>
</header>
<main id="root"><div class="empty">loading…</div></main>
</div>
</div>

<script>
${SHARED_JS}

// The replay id from the URL path (/game/:id).
const GAME_ID = decodeURIComponent(location.pathname.split("/")[2] || "");

function stat(k, v, plain) {
  return '<div class="stat"><div class="k">' + k + '</div><div class="v' + (plain ? " plain" : "") + '">' + v + '</div></div>';
}

// "– ?" — a rating withheld because the player's profile is private. The dash
// goes in a PILL box (same min-width and centring, just no colour) so it lands
// exactly where every other row's number is and the column reads straight down;
// the (?) is the usual pill-hint, hung in the cell's right padding so it costs
// the dash no width and sits on the pills' centre line.
function privateDash() {
  return '<span class="pill none">–</span>' +
    '<span class="hint pill-hint">?<span class="hint-tip">This player\u2019s profile is private</span></span>';
}

function deltaTxt(d) {
  if (d == null) return '<span class="muted">–</span>';
  return '<span class="' + (d >= 0 ? "delta-up" : "delta-down") + '">' + (d >= 0 ? "+" : "") + d.toFixed(2) + '</span>';
}

function playerRow(p, team, tint, parties) {
  // A private profile arrives with its LOS before and after blanked (Δ LOS
  // stays — a change says nothing about the rating it moved). The dash carries
  // a (?) saying why, so it does not read as the plain dash an unrated game
  // gives everyone.
  const before = p.privateProfile
    ? privateDash()
    : p.losBefore == null
      ? '<span class="muted">–</span>'
      : '<span class="pill ' + ratingClass(p.losBefore) + '">' + fmtLos(p.losBefore) + '</span>';
  // The slot is ALWAYS rendered, empty when there is no "after" to show (a
  // private profile, an unrated game). td.delta is right-aligned, so an absent
  // suffix would let the delta slide to the cell edge and break the column —
  // and a shorter one ("→ 9.0" vs "→ 27.0") would shift it by the difference.
  const after = '<span class="after"' +
    (p.privateProfile || p.losAfter == null
      ? '></span>'
      : ' title="LOS after the game">→ ' + fmtLos(p.losAfter) + '</span>');
  // The rank going into the game: the emblem alone for a visitor (its name is
  // the tooltip), beside the LOS pill for an admin.
  const games = p.gameNumber != null ? p.gameNumber - 1 : 0;
  const rank = p.privateProfile ? privateDash()
    : p.tier ? rankBadge(p.tier, games, { size: ADMIN_MODE ? 24 : 30 })
    : '<span class="muted">–</span>';
  return '<tr>' +
    '<td class="name"><a class="pname tc' + team + '"' + (tint ? ' style="color:' + tint + '"' : '') +
      ' href="' + playerHref(p.userId) + '">' + esc(p.name) + '</a>' +
      (p.faction ? '<span class="faction">' + esc(p.faction) + '</span>' : '') +
    '</td>' +
    '<td class="party">' + partyPill(p, parties) + '</td>' +
    (ADMIN_MODE
      ? '<td class="rating">' + (p.tier && !p.privateProfile ? rank : '') + before + '</td>' +
        '<td class="delta">' + deltaTxt(p.losDelta) + after + '</td>'
      : '<td class="rating">' + rank + '</td>') +
    '<td class="num games" title="rated lava games played, this one included">' +
      (p.gameNumber != null ? p.gameNumber : '<span class="muted">–</span>') + '</td>' +
    '</tr>';
}

// Who was partied with whom, from the lobby roster barreplay's lava sync
// stored with the game (lobby.lobbyDetails.players[].party: Teiserver's party
// colour, null when solo). Each player gets a .party key, matched by name;
// only a party with 2+ of its members in this game counts (a lone member
// says nothing). Parties are numbered in the order their first member shows
// up down the two rosters. A game with no lobby info just has no pills.
function attachParties(g) {
  const roster = g.lobby && g.lobby.lobbyDetails && Array.isArray(g.lobby.lobbyDetails.players)
    ? g.lobby.lobbyDetails.players : [];
  const byName = new Map();
  for (const r of roster) {
    if (r && typeof r.name === "string" && typeof r.party === "string" && r.party) {
      byName.set(r.name.toLowerCase(), r.party);
    }
  }
  const counts = new Map();
  for (const team of g.teams) for (const p of team) {
    p.party = byName.get(String(p.name).toLowerCase()) || null;
    if (p.party) counts.set(p.party, (counts.get(p.party) || 0) + 1);
  }
  const parties = new Map();
  for (let i = 0; i < g.teams.length; i++) for (const p of byLosDesc(g.teams[i])) {
    if (p.party && counts.get(p.party) >= 2 && !parties.has(p.party)) parties.set(p.party, parties.size + 1);
  }
  return parties;
}

function teamTable(g, i, parties) {
  const team = byLosDesc(g.teams[i]);
  const won = g.winnerTeam === i;
  const avg = teamAvgLos(g, i);
  const avgPill = avg == null ? "" : '<span class="pill ' + ratingClass(avg) + '">Avg ' + fmtLos(avg) + '</span>';
  return '<div class="team">' +
    '<h3><span class="who"><span class="tname tc' + i + '">Team ' + (i + 1) + '</span>' +
      (won ? '<span class="badge won">🏆 won</span>' : '') + '</span>' + avgPill + '</h3>' +
    '<table><thead><tr><th>Player</th><th class="party"></th>' +
    (ADMIN_MODE ? '<th class="rating">LOS before</th><th class="num">Δ LOS</th>'
      : '<th class="rating" title="rank going into this game">Rank</th>') +
    '<th class="num games">Games</th></tr></thead>' +
    '<tbody>' + (team.map((p, j) => playerRow(p, i, teamTint(i, j), parties)).join("") ||
      '<tr><td colspan="5" class="empty">nobody</td></tr>') + '</tbody></table>' +
    '</div>';
}

// The head-to-head strip: team averages, the LOS gap, and the pre-game predicted
// win chance the fold rated with (server-computed; absent on ignored games).
function matchup(g) {
  const a = teamAvgLos(g, 0), b = teamAvgLos(g, 1);
  const pw = g.predictedWin;
  const side = (i, avg, cls) => {
    const winLine = pw ? '<div class="line"><span class="wp">' + (pw[i] * 100).toFixed(1) + '% predicted</span></div>' : '';
    return '<div class="side ' + cls + '">' +
      '<div class="line"><span class="tname tc' + i + '">Team ' + (i + 1) + '</span>' +
        (g.winnerTeam === i ? '<span class="badge won">🏆 won</span>' : '') +
        (avg == null ? '' : '<span class="pill ' + ratingClass(avg) + '">Avg ' + fmtLos(avg) + '</span>') +
      '</div>' + winLine + '</div>';
  };
  const probbar = pw
    ? '<div class="probbar"><span class="a" style="width:' + (pw[0] * 100).toFixed(1) + '%"></span>' +
      '<span class="b" style="width:' + (pw[1] * 100).toFixed(1) + '%"></span></div>'
    : '';
  const gap = a != null && b != null ? '<span class="gap" title="LOS gap between the team averages">Δ ' + fmtLos(Math.abs(a - b)) + '</span>' : '';
  return '<div class="matchup">' + side(0, a, "left") +
    '<div class="mid"><span class="vs">vs</span>' + gap + '</div>' +
    side(1, b, "right") + probbar + '</div>';
}

// Same mapping as the games list's unratedTitle (each page carries its own
// inline script): known reasons get their sentence, anything else the
// generic truth — the map doubles as the sanitizer, so the raw value never
// reaches the markup.
function unratedTitle(g) {
  return {
    "off-map": "played off the rated map (not Supreme Isthmus) — stored, never rated",
    "uploaded too late": "uploaded after later games were already rated — stored, never rated",
    "start metal storage": "start metal storage was not 4000 (required from 1 Oct 2026) — stored, never rated",
    "excluded": "an admin had this game ignored when LOS was last re-run — stored, never rated",
  }[g.unrankedReason] || "stored, never rated";
}

function facts(g) {
  // Only a game that is unrated, or that an admin marked ignored, needs a
  // rating note; a plain rated one is the normal case. Same badge the list
  // draws (gameBadges, SHARED_JS).
  const badge = gameBadges(g);
  const rated = badge ? stat(ADMIN_MODE ? "LOS" : "Rating", badge, true) : "";
  const links = '<span class="ext">' +
    '<a href="' + esc(otlHref(g.id)) + '" target="_blank" rel="noopener noreferrer">OTL</a>' +
    '<a href="' + esc(barHref(g.id)) + '" target="_blank" rel="noopener noreferrer">BAR</a>' +
    replaySlot(g, false) + '</span>';
  return '<div class="facts">' +
    stat("Started", esc(fmtWhen(g.startTime))) +
    stat("Duration", esc(fmtDur(g.durationMs))) +
    stat("Map", esc(g.map || "?"), true) +
    rated +
    stat("Links", links, true) +
    '</div>';
}

function render(g) {
  const parties = attachParties(g);
  document.getElementById("root").innerHTML =
    '<div class="lobby">' +
      '<div class="head"><span class="title">' + esc(fmtWhen(g.startTime)) + ' · ' + esc(fmtDur(g.durationMs)) +
        ' · ' + esc(g.map || "") + '</span><span class="id">' + esc(g.id) + '</span></div>' +
      matchup(g) + facts(g) +
      '<div class="teams">' + teamTable(g, 0, parties) + teamTable(g, 1, parties) + '</div>' +
      '<div class="summary-slot" id="summary"></div>' +
    '</div>';
  showSummary(g);
}

// barreplay's game summary (who was winning, battles, awards, per-player
// reports) under the teams, for a game barreplay has published. The module is
// barreplay's own code, imported at view time from barreplay's deployment: a
// stable no-cache URL that forwards to its current build, so a barreplay deploy
// reaches this page with nothing to bump here. It finds the replay's summary on
// barreplay and draws it, and a click on a moment opens the replay there in a new tab. Its
// data is large (megabytes on a long game), so nothing is fetched until the
// (empty, zero-height) slot is close to scrolling into view. A game without a
// summary yet leaves no trace: the slot is removed, and a module that fails to
// load or mount only says so inside the slot.
const SUMMARY_JS = "https://replay.fogofwar.dev/embed/summary.js";

function showSummary(g) {
  const slot = document.getElementById("summary");
  if (!slot) return;
  if (!(g.replay && g.replay.published)) { slot.remove(); return; }
  const io = new IntersectionObserver(async (entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    const head = document.createElement("h2");
    head.textContent = "Game summary";
    const note = document.createElement("div");
    note.className = "empty";
    note.textContent = "loading summary…";
    const body = document.createElement("div");
    slot.replaceChildren(head, note, body);
    try {
      const m = await import(SUMMARY_JS);
      const handle = await m.mountGameSummary(body, g.id);
      if (handle) note.remove();
      else slot.remove();
    } catch (e) {
      note.className = "error";
      note.textContent = "Failed to load the game summary: " + e.message;
    }
  }, { rootMargin: "600px 0px" });
  io.observe(slot);
}

async function load() {
  const meta = document.getElementById("meta");
  const root = document.getElementById("root");
  if (!GAME_ID) {
    meta.textContent = "";
    root.innerHTML = '<div class="error">Invalid game id.</div>';
    return;
  }
  try {
    // replays=true: the worker resolves this game's barreplay status before it
    // answers, so the facts row's Links are complete when it is first drawn.
    const res = await fetch(withAdmin("/api/games/" + encodeURIComponent(GAME_ID) + "?replays=true"),
      { headers: { accept: "application/json" } });
    if (res.status === 404) {
      meta.textContent = "";
      root.innerHTML = '<div class="empty">No such game.</div>';
      return;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const g = await res.json();
    document.title = "lavabalance · game " + fmtWhen(g.startTime);
    document.querySelector("header.top h1").textContent = "Game · " + fmtWhen(g.startTime);
    meta.textContent = "updated " + new Date().toLocaleTimeString();
    render(g);
  } catch (e) {
    meta.textContent = "";
    root.innerHTML = '<div class="error">Failed to load game: ' + esc(e.message) + '</div>';
  }
}

load();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Scouting page (GET /scouting): the boards built from OneTrickLava's play-style
// cards (GET /api/scout/boards, src/scout.ts) — the WATCH LIST (OTL's "most
// dangerous" score: comm bombs/drops/walks, aggression, rush timing, weighted by
// how regular the player is) and the LANE KINGS (best win rate per Supreme
// Isthmus lane). Private LOS profiles are left off both for a visitor.
// ---------------------------------------------------------------------------
export const SCOUTING_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lavabalance · scouting</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell">
${sidebar("scouting")}
<div class="main">
<header class="top">
  <h1>Scouting</h1>
  <span class="meta" id="meta">loading…</span>
</header>
<main id="root"><div class="empty">loading…</div></main>
</div>
</div>

<script>
${SHARED_JS}

function playerLink(p) {
  return '<a class="plink" href="/player/' + encodeURIComponent(p.userId) + '">' + esc(p.name) + '</a>';
}

function watchRow(p, i) {
  return '<tr>' +
    '<td class="rankno">' + (i + 1) + '</td>' +
    '<td class="name">' + playerLink(p) + scoutIcons(p.badges) + '</td>' +
    '<td class="num"><span class="danger" title="OneTrickLava danger score">' +
      esc(Number(p.danger).toFixed(1)) + '</span></td>' +
    '<td>' + archChips(p.archetypes) + '</td>' +
    '<td>' + (p.lane ? esc(p.lane) : '<span class="muted">–</span>') + '</td>' +
    '<td class="num games">' + esc(p.games) + '</td>' +
  '</tr>';
}

function watchCard(list) {
  const body = list.length
    ? '<div class="games-table"><table><thead><tr><th class="num">#</th><th>Player</th>' +
      '<th class="num" title="comm bombs/drops/walks, aggression and rush timing, weighted by how regular the player is">Danger</th>' +
      '<th>Style</th><th>Main lane</th><th class="num">Games</th></tr></thead><tbody>' +
      list.map(watchRow).join("") + '</tbody></table></div>'
    : '<div class="empty">Nobody on the watch list yet.</div>';
  return '<div class="card"><h2>⚠️ Watch list <span class="sub">who is most likely to comm-bomb, ' +
    'drop or rush you — regulars with 50+ parsed games</span></h2>' + body + '</div>';
}

function kingsCard(lanes) {
  const body = lanes.length
    ? '<div class="kings">' + lanes.map((l) =>
        '<div class="king"><h4>' + esc(l.lane) + '</h4><ol>' + l.kings.slice(0, 5).map((k) =>
          '<li>' + '<a href="/player/' + encodeURIComponent(k.userId) + '">' + esc(k.name) + '</a> ' +
          '<span class="wr ' + wrClass(k.winRate) + '">' + pctTxt(k.winRate) + '</span> ' +
          '<span class="muted">· ' + esc(k.games) + 'g</span></li>').join("") +
        '</ol></div>').join("") + '</div>'
    : '<div class="empty">No lane records yet.</div>';
  return '<div class="card"><h2>👑 Lane kings <span class="sub">best win rate on each Supreme Isthmus ' +
    'lane — 20+ games there</span></h2>' + body + '</div>';
}

function aboutCard(d) {
  const when = d.receivedAt ? new Date(d.receivedAt).toLocaleString() : null;
  return '<div class="card"><div class="src-note" style="border-top:0">' +
    'Scouting comes from <b>OneTrickLava</b>, which parses every lava replay and folds each ' +
    'player’s games into a play-style profile — archetypes, warning badges, the lanes they ' +
    'start on. ' + esc(d.profiles) + ' players scouted' +
    (when ? ' · last update ' + esc(when) : '') +
    '. Each lobby page shows the same cards as a lane forecast and a per-team report; ' +
    'whisper the bot <b>.scout &lt;player&gt;</b> for one in chat.</div></div>';
}

async function load() {
  const meta = document.getElementById("meta");
  const root = document.getElementById("root");
  try {
    const res = await fetch(withAdmin("/api/scout/boards"), { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const d = await res.json();
    meta.textContent = "updated " + new Date().toLocaleTimeString();
    if (!d.profiles) {
      root.innerHTML = '<div class="empty">No scouting data yet — OneTrickLava has not published ' +
        'any play-style cards to this site.</div>';
      return;
    }
    root.innerHTML = watchCard(d.watchlist || []) + kingsCard(d.laneKings || []) + aboutCard(d);
  } catch (e) {
    meta.textContent = "";
    root.innerHTML = '<div class="error">Failed to load scouting: ' + esc(e.message) + '</div>';
  }
}

load();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// SQL stats page (GET /sql, admin-only): what each method of the SQLite-backed
// Durable Objects has cost in SQLite rows — GET /api/sqlstats, one report per DO.
// ---------------------------------------------------------------------------
export const SQL_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lavabalance · SQL</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell">
${sidebar("sql")}
<div class="main">
<header class="top">
  <h1>SQL</h1>
  <span class="meta" id="meta"></span>
</header>
<main id="root" class="sqlstats"><div class="empty">loading…</div></main>
</div>
</div>

<script>
${SHARED_JS}

// What each Durable Object method has cost in SQLite rows since its instance
// started. The tally is in the DO's memory only (a deploy or an eviction starts
// it over — persisting it would spend the write budget it measures), so every
// table states its own window. The "/day · budget" columns project each
// method's spend onto the Workers Free plan's daily allowances — the number
// that says whether a method will exhaust a budget before midnight. Both
// budgets are per ACCOUNT, so the grand total across the DOs is what counts.
// Read on demand only: opening the page, or Reload.
const SQL_READS_PER_DAY = 5000000;
const SQL_WRITES_PER_DAY = 100000;
let sqlStatsSeq = 0; // ignore a reply overtaken by a newer request

const num = (n) => Number(n).toLocaleString("en-US");

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return (h ? h + "h " : "") + (h || m ? m + "m " : "") + s + "s";
}

// A projection off a seconds-old window is noise, not a rate.
function projCell(rows, budget, elapsedSec) {
  if (elapsedSec < 60) return { text: null, cls: "" };
  const perDay = rows / elapsedSec * 86400;
  const pct = perDay / budget * 100;
  return {
    text: num(Math.round(perDay)) + " · " + pct.toFixed(1) + "%",
    cls: pct >= 100 ? " over" : pct >= 50 ? " hot" : "",
  };
}

function cell(text, cls) {
  const dim = text == null ? " dim" : "";
  return '<td class="' + esc((cls || "") + dim).trim() + '">' + (text == null ? "—" : esc(text)) + '</td>';
}

function row(label, calls, rowsRead, rowsWritten, elapsedSec) {
  const pr = projCell(rowsRead, SQL_READS_PER_DAY, elapsedSec);
  const pw = projCell(rowsWritten, SQL_WRITES_PER_DAY, elapsedSec);
  return '<tr>' +
    cell(label, "op") +
    cell(calls == null ? null : num(calls)) +
    cell(num(rowsRead)) +
    cell(calls ? num(Math.round(rowsRead / calls)) : null) +
    cell(pr.text, pr.cls) +
    cell(num(rowsWritten)) +
    cell(calls ? num(Math.round(rowsWritten / calls)) : null) +
    cell(pw.text, pw.cls) +
    '</tr>';
}

const HEAD = '<thead><tr><th>Method</th><th>Calls</th><th>Rows read</th><th>Read/call</th>' +
  '<th>Read/day · budget</th><th>Rows written</th><th>Written/call</th><th>Written/day · budget</th></tr></thead>';

function doCard(d) {
  const since = new Date(d.since);
  const rows = d.ops.map((o) => row(o.op, o.calls, o.rowsRead, o.rowsWritten, d.elapsedSec)).join("");
  return '<div class="card wide">' +
    '<h2>' + esc(d.name) + ' <span class="sub">' + esc(d.description || "") + '</span></h2>' +
    '<div class="window">Counting since <b>' + esc(fmtWhen(since.toISOString())) + '</b> — ' +
      esc(fmtDuration(Math.max(d.elapsedSec, 0))) + ' so far. ' +
      'The window is this Durable Object instance\\u2019s lifetime: a deploy or an eviction starts it over.</div>' +
    '<table>' + HEAD +
    '<tbody>' + (rows || '<tr><td colspan="8" class="empty">no statements yet</td></tr>') + '</tbody>' +
    '<tfoot>' + row("total", null, d.totals.rowsRead, d.totals.rowsWritten, d.elapsedSec) + '</tfoot>' +
    '</table></div>';
}

function grandCard(dos) {
  // The budgets are per account, so the sum over the DOs is the line that matters;
  // each DO's window differs, so the projection uses the youngest one (the
  // most conservative: a longer window would only lower the rate).
  const totals = { rowsRead: 0, rowsWritten: 0 };
  let elapsedSec = Infinity;
  for (const d of dos) {
    totals.rowsRead += d.totals.rowsRead;
    totals.rowsWritten += d.totals.rowsWritten;
    elapsedSec = Math.min(elapsedSec, d.elapsedSec);
  }
  if (!Number.isFinite(elapsedSec)) elapsedSec = 0;
  return '<div class="card wide grand">' +
    '<h2>All Durable Objects <span class="sub">the daily budgets are per account: ' +
      num(SQL_READS_PER_DAY) + ' rows read, ' + num(SQL_WRITES_PER_DAY) + ' rows written (Workers Free)</span></h2>' +
    '<table>' + HEAD +
    '<tbody>' + row("total", null, totals.rowsRead, totals.rowsWritten, elapsedSec) + '</tbody>' +
    '</table></div>';
}

function render(report) {
  document.getElementById("root").innerHTML =
    report.dos.map(doCard).join("") +
    grandCard(report.dos) +
    '<div class="bar"><button type="button" id="reload" title="Re-read the counters">Reload</button></div>';
  document.getElementById("reload").onclick = () => refresh();
}

async function refresh() {
  const meta = document.getElementById("meta");
  const seq = ++sqlStatsSeq;
  try {
    const res = await fetch("/api/sqlstats", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const report = await res.json();
    if (!report || !Array.isArray(report.dos)) throw new Error("unexpected reply");
    if (seq !== sqlStatsSeq) return; // a newer read already went out
    meta.textContent = "read " + new Date().toLocaleTimeString();
    render(report);
  } catch (e) {
    if (seq !== sqlStatsSeq) return;
    meta.textContent = "";
    document.getElementById("root").innerHTML =
      '<div class="error">Could not read the SQL stats: ' + esc(e.message) + '</div>';
  }
}

if (ADMIN_MODE) {
  refresh();
} else {
  // Nothing is fetched outside admin mode: the page is admin-only, like its menu entry.
  document.getElementById("root").innerHTML =
    '<div class="empty">This page is admin-only. <a href="/admin/login?next=' + encodeURIComponent(location.pathname) + '">Admin login</a></div>';
}
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Bot page (GET /bot, admin-only): the bot container's status + Start/Stop.
// Talks to the token-authed control plane (GET /bot/status, POST /bot/start,
// POST /bot/stop), which checks the Access cookie or the bearer token
// (CONTROL_TOKEN, when set) itself; admin mode only reveals the page, exactly
// like the SQL page.
// ---------------------------------------------------------------------------
export const BOT_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lavabalance · Bot</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell">
${sidebar("bot")}
<div class="main">
<header class="top">
  <h1>Bot</h1>
  <span class="meta" id="meta"></span>
</header>
<main id="root" class="botpage"><div class="empty">loading…</div></main>
</div>
</div>

<script>
${SHARED_JS}

// The bot container's control plane. GET /bot/status on load + every 5s, and
// after every action; POST /bot/start / /bot/stop from the buttons. All three
// need the CONTROL_TOKEN bearer when that secret is set — the token field below
// (kept in localStorage) supplies it. A 401 renders as "unauthorized" and the
// poll keeps going, so pasting the right token heals the page in place.
const TOKEN_KEY = "controlToken";
const POLL_MS = 5000;
let lastStatus = null;   // last GET /bot/status body, re-rendered on every state change
let pending = null;      // "start" | "stop" | "join" while a POST is in flight (buttons disabled)
let note = null;         // outcome line next to the buttons: {text, err}
let statusSeq = 0;       // ignore a reply overtaken by a newer request
let mainLobby = null;    // the configured lava lobby id (GET /admin/config), null = unknown/none
const lobbyTitles = {};  // battle id -> title, filled lazily from the public /api/lobbies/:id
let titleFetching = 0;   // the battle id a title fetch is in flight for (0 = none)

function token() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

function authHeaders() {
  const h = { accept: "application/json" };
  const t = token();
  if (t) h.authorization = "Bearer " + t;
  return h;
}

// The headline: is the bot actually up, and does that match the intent?
function stateLine(s) {
  const up = s.status === "running" || s.status === "healthy";
  if (up) return { cls: "up", text: "running" };
  if (s.running) return { cls: "mid", text: "down (should be running — the cron will retry)" };
  return { cls: "down", text: "stopped" };
}

function kv(k, vHtml) {
  return '<div class="k">' + esc(k) + '</div><div class="v">' + vHtml + '</div>';
}

// The prominent lobby banner: which battle the bot sits in (linked, with the
// lobby's title once the public detail endpoint answered), a join in progress,
// or a loud "not in any lobby".
function lobbyLine(s) {
  const up = s && (s.status === "running" || s.status === "healthy");
  if (!up || !s.bot) return '<div class="lobbyline off">🛋️ Bot is not running — no lobby.</div>';
  const battle = s.bot.battle;
  const pendingBattle = s.bot.pendingBattle;
  if (battle != null) {
    const title = lobbyTitles[battle];
    return '<div class="lobbyline">🛋️ In lobby ' +
      '<a href="/lobby/' + encodeURIComponent(battle) + '">#' + esc(String(battle)) + '</a>' +
      (title ? '<span class="title">' + esc(title) + "</span>" : "") +
    "</div>";
  }
  if (pendingBattle != null) {
    return '<div class="lobbyline none">⏳ Joining lobby #' + esc(String(pendingBattle)) + "…</div>";
  }
  return '<div class="lobbyline none">⚠️ Not in any lobby.</div>';
}

// Fetch the joined lobby's title from the public detail endpoint, once per battle
// id (re-rendering when it lands). Failure is fine — the banner just shows the id.
function ensureLobbyTitle(battle) {
  if (battle == null || lobbyTitles[battle] !== undefined || titleFetching === battle) return;
  titleFetching = battle;
  fetch("/api/lobbies/" + encodeURIComponent(battle))
    .then((res) => (res.ok ? res.json() : null))
    .then((lobby) => {
      lobbyTitles[battle] = lobby && lobby.title ? lobby.title : "";
      if (lastStatus && lastStatus.bot && lastStatus.bot.battle === battle) render();
    })
    .catch(() => { lobbyTitles[battle] = ""; })
    .finally(() => { if (titleFetching === battle) titleFetching = 0; });
}

function botFields(bot) {
  if (!bot) return '<span class="muted">unreachable (container down or health endpoint not answering)</span>';
  const parts = Object.entries(bot).map(([k, v]) =>
    esc(k) + " = " + esc(typeof v === "object" ? JSON.stringify(v) : String(v)));
  return '<span class="mono">' + parts.join("<br>") + "</span>";
}

function render() {
  const s = lastStatus;
  const rows = [];
  let head = '<span class="muted">no status yet</span>';
  if (s) {
    const st = stateLine(s);
    head = '<span class="state ' + st.cls + '"><span class="dot"></span>' + esc(st.text) + '</span>';
    rows.push(kv("Intent", s.running
      ? "run (persisted — the 5-min cron restarts the container after platform restarts)"
      : "stopped (the cron leaves it alone until Start)"));
    rows.push(kv("Container state", esc(s.status) +
      (s.exitCode != null ? ' <span class="muted">(exit ' + esc(String(s.exitCode)) + ")</span>" : "")));
    if (s.lastStartedAt) rows.push(kv("Last state change", esc(fmtWhen(s.lastStartedAt))));
    if (s.lastStop) rows.push(kv("Last stop", esc(fmtWhen(s.lastStop.at)) +
      ' <span class="muted">— exit ' + esc(String(s.lastStop.exitCode)) +
      ", " + esc(s.lastStop.reason) + "</span>"));
    if (s.lastError) rows.push(kv("Last error", '<span class="err">' + esc(s.lastError) + "</span>"));
    if (s.lastBattle != null) {
      rows.push(kv("Rejoin on restart", '<a href="/lobby/' + encodeURIComponent(s.lastBattle) +
        '">#' + esc(String(s.lastBattle)) + "</a>" +
        ' <span class="muted">— the last joined lobby; a restart rejoins it, or the main lobby if it is gone</span>'));
    }
    rows.push(kv("Bot /health", botFields(s.bot)));
  }
  const noteHtml = note
    ? '<span class="note' + (note.err ? " err" : "") + '">' + esc(note.text) + "</span>"
    : "";
  // Join controls only make sense while the bot process is up (its /health answers).
  const canJoin = !pending && s && s.bot != null;
  // Keep the id the user is typing across re-renders (the 5s poll redraws the card).
  const typedEl = document.getElementById("joinId");
  const typed = typedEl ? typedEl.value : "";
  document.getElementById("root").innerHTML =
    '<div class="card">' +
      '<h2>Bot container <span class="sub">the lobby bot (src/bot/bot.ts) in its Cloudflare Container</span></h2>' +
      lobbyLine(s) +
      '<div class="actions">' +
        '<div class="state-wrap">' + head + "</div>" +
        '<span class="spacer" style="margin-left:auto"></span>' +
        '<button type="button" class="act start" id="btnStart"' + (pending ? " disabled" : "") + ">" +
          (pending === "start" ? "Starting…" : "Start") + "</button>" +
        '<button type="button" class="act stop" id="btnStop"' + (pending ? " disabled" : "") + ">" +
          (pending === "stop" ? "Stopping…" : "Stop") + "</button>" +
      "</div>" +
      '<div class="joinrow">' +
        '<button type="button" class="act join" id="btnJoinMain"' + (canJoin ? "" : " disabled") + ">" +
          (pending === "join" ? "Joining…" : "Join main lobby" + (mainLobby != null ? " (#" + esc(String(mainLobby)) + ")" : "")) +
        "</button>" +
        '<span class="sep">·</span>' +
        '<input class="ctl" id="joinId" type="text" inputmode="numeric" placeholder="lobby id" ' +
          'value="' + esc(typed) + '"' + (pending ? " disabled" : "") + " />" +
        '<button type="button" class="act join" id="btnJoinId"' + (canJoin ? "" : " disabled") + ">Join by id</button>" +
      "</div>" +
      (noteHtml ? '<div class="actions">' + noteHtml + "</div>" : "") +
      '<div class="kv">' + rows.join("") + "</div>" +
      '<div class="token"><label for="tok">Control token</label>' +
        '<input class="ctl" id="tok" type="password" autocomplete="off" ' +
          'placeholder="CONTROL_TOKEN (if set)" value="' + esc(token()) + '" />' +
        "<span>sent as the bearer token; kept in this browser only</span></div>" +
    "</div>";
  document.getElementById("btnStart").onclick = () => act("start");
  document.getElementById("btnStop").onclick = () => act("stop");
  document.getElementById("btnJoinMain").onclick = () => join(null);
  document.getElementById("btnJoinId").onclick = () => joinTyped();
  document.getElementById("joinId").addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinTyped();
  });
  document.getElementById("tok").addEventListener("change", (e) => {
    try { localStorage.setItem(TOKEN_KEY, e.target.value.trim()); } catch {}
    refresh();
  });
}

function joinTyped() {
  const raw = document.getElementById("joinId").value.trim();
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id < 0) {
    note = { text: "enter a numeric lobby id to join", err: true };
    render();
    return;
  }
  join(id);
}

async function refresh() {
  const seq = ++statusSeq;
  // The configured main lobby (labels the "Join main lobby" button); same bearer
  // auth as the status. A failure only blanks the label, never the page.
  const configPromise = fetch("/admin/config", { headers: authHeaders() })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  try {
    const res = await fetch("/bot/status", { headers: authHeaders() });
    if (seq !== statusSeq) return; // a newer read already went out
    if (!res.ok) throw new Error(res.status === 401
      ? "unauthorized — paste the control token below" : "HTTP " + res.status);
    lastStatus = await res.json();
    document.getElementById("meta").textContent = "read " + new Date().toLocaleTimeString();
    if (lastStatus.bot && lastStatus.bot.battle != null) ensureLobbyTitle(lastStatus.bot.battle);
  } catch (e) {
    if (seq !== statusSeq) return;
    lastStatus = null;
    document.getElementById("meta").textContent = "";
    note = { text: "Could not read the status: " + e.message, err: true };
  }
  const config = await configPromise;
  if (seq !== statusSeq) return;
  mainLobby = config && Array.isArray(config.lava_lobbies) && config.lava_lobbies.length
    ? config.lava_lobbies[0] : null;
  render();
}

// POST /bot/start or /bot/stop. Both answer the full status (start: 503 with the
// same body when the container did not come up — lastError says why), so the
// response body IS the fresh view; render it and keep polling.
async function act(which) {
  if (pending) return;
  pending = which;
  note = null;
  render();
  try {
    const res = await fetch("/bot/" + which, { method: "POST", headers: authHeaders() });
    let body = null;
    try { body = await res.json(); } catch {}
    if (res.status === 401) throw new Error("unauthorized — paste the control token below");
    if (body && typeof body === "object" && "running" in body) lastStatus = body;
    if (which === "start" && !res.ok) {
      throw new Error("the container did not come up" +
        (body && body.lastError ? ": " + body.lastError : " (HTTP " + res.status + ")"));
    }
    if (!res.ok && which === "stop") throw new Error("HTTP " + res.status);
    note = { text: which === "start" ? "started" : "stopped", err: false };
  } catch (e) {
    note = { text: which + " failed: " + e.message, err: true };
  }
  pending = null;
  render();
  refresh();
}

// POST /bot/join. id = null joins the current MAIN lobby (the server resolves the
// configured lava lobby, auto-picking one if needed). The join is async on the
// lobby protocol: a 200 means the bot accepted it, and the banner catches up via
// the poll (the response's fresh status is applied right away).
async function join(id) {
  if (pending) return;
  pending = "join";
  note = null;
  render();
  try {
    const res = await fetch("/bot/join", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(id != null ? { battle: id } : {}),
    });
    let body = null;
    try { body = await res.json(); } catch {}
    if (res.status === 401) throw new Error("unauthorized — paste the control token below");
    if (body && body.status && typeof body.status === "object" && "running" in body.status) {
      lastStatus = body.status;
    }
    if (!res.ok) {
      throw new Error(body && body.error ? body.error : "HTTP " + res.status);
    }
    note = { text: "join requested — lobby #" + body.battle, err: false };
  } catch (e) {
    note = { text: "join failed: " + e.message, err: true };
  }
  pending = null;
  render();
  refresh();
}

if (ADMIN_MODE) {
  refresh();
  setInterval(() => { if (!pending) refresh(); }, POLL_MS);
} else {
  // Nothing is fetched outside admin mode: the page is admin-only, like its menu entry.
  document.getElementById("root").innerHTML =
    '<div class="empty">This page is admin-only. <a href="/admin/login?next=' + encodeURIComponent(location.pathname) + '">Admin login</a></div>';
}
</script>
</body>
</html>`;

// GET /login — website login with a BAR account (src/auth.ts). Three states:
//   • opened from the link the bot whispered (?t=…): "Continue as <name>" —
//     the button POSTs the token; nothing happens on page load, so a chat
//     client prefetching the link cannot use it up;
//   • logged in: who you are, and a Log out button;
//   • otherwise: the steps — whisper .login to the bot from the BAR lobby.
// The token is dropped from the address bar as soon as the page has read it.
export const LOGIN_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>lavabalance · Log in</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell">
${sidebar("login")}
<div class="main">
<header class="top">
  <h1>Log in</h1>
  <span class="meta" id="meta"></span>
</header>
<main id="root" class="loginpage"><div class="empty">loading…</div></main>
</div>
</div>

<script>
${SHARED_JS}

const root = document.getElementById("root");
let linkToken = new URLSearchParams(location.search).get("t");
if (linkToken) {
  // Keep the one-time token out of history, bookmarks and shared screenshots.
  const clean = new URL(location.href);
  clean.searchParams.delete("t");
  history.replaceState(null, "", clean.pathname + clean.search);
}

let devLogin = false; // /api/auth/me: the dev-only fake login is on

function card(title, inner) {
  root.innerHTML = '<div class="card"><h2>' + esc(title) + '</h2><div class="body">' + inner + "</div></div>";
  if (devLogin) addDevSection();
}

// DEV ONLY (DEV_LOGIN=true in .dev.vars): log in as any rated
// player by name, no bot. The server refuses it everywhere else, so this
// section only ever renders when the route would work.
function addDevSection() {
  const el = document.createElement("div");
  el.className = "card dev";
  el.innerHTML = '<h2>Dev mode: log in as any player</h2><div class="body">' +
    '<div class="devrow"><input id="devName" class="ctl" type="text" placeholder="player name" autocomplete="off" />' +
    '<button class="act quiet" id="devGo">Log in as player</button></div><div id="devNote"></div></div>';
  root.appendChild(el);
  const input = document.getElementById("devName");
  const go = document.getElementById("devGo");
  const submit = async () => {
    const name = input.value.trim();
    if (!name) return;
    go.disabled = true;
    const r = await getJson("/api/auth/dev-login", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ name }),
    });
    go.disabled = false;
    if (r.ok) {
      linkToken = null;
      rememberAuthUser(r.body.user);
      renderAuthBox();
      if (goBack()) return;
      return showLoggedIn(r.body.user);
    }
    const n = document.getElementById("devNote");
    n.className = "note err";
    n.textContent = r.body.error || "dev login failed";
  };
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") submit(); });
}

// Logged in: back to the page that sent the visitor here (setLoginReturn),
// if one did. True when navigating away.
function goBack() {
  const back = takeLoginReturn();
  if (!back) return false;
  root.innerHTML = '<div class="empty">Logged in. Taking you back to ' + esc(back.label || back.path) + "…</div>";
  location.replace(back.path);
  return true;
}

function note(text, err) {
  const el = document.getElementById("note");
  if (!el) return;
  el.className = "note" + (err ? " err" : "");
  el.textContent = text;
}

async function getJson(url, init) {
  const res = await fetch(url, Object.assign({ headers: { accept: "application/json" } }, init || {}));
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function showSteps(bot) {
  const name = bot || "lavabalance";
  card("Log in with your BAR account",
    "<p>There is no password here: you prove who you are by messaging the lavabalance bot " +
    "from your Beyond All Reason account.</p>" +
    '<ol class="steps">' +
    "<li>Open Beyond All Reason and log in to the lobby.</li>" +
    "<li>Send a private message <code>login</code> to the \u201C" + esc(name) + "\u201D bot. " +
      "Find it in a lobby spectator list and right-click it.</li>" +
    "<li>The bot replies with a link. Open it in this browser and press <b>Continue</b>.</li>" +
    "</ol>" +
    '<p class="fine">The link works once and expires after 5 minutes. Never share it: whoever opens it ' +
    "is logged in as you. Send <code>logout</code> to the bot to log out everywhere.</p>" +
    (peekLoginReturn() ? '<p class="returnnote">\u21A9\uFE0E Once you are logged in you go straight back to <a href="' +
      esc(peekLoginReturn().path) + '">' + esc(peekLoginReturn().label || peekLoginReturn().path) + "</a>.</p>" : ""));
}

function showLoggedIn(user) {
  card("Logged in",
    '<div class="who">' + esc(user.name) + "</div>" +
    '<p>You are logged in with your BAR account. <a href="/player/' + encodeURIComponent(user.userId) +
    '">Your profile</a></p>' +
    '<button class="act quiet" id="logout">Log out</button><div id="note"></div>');
  document.getElementById("logout").addEventListener("click", async (ev) => {
    ev.target.disabled = true;
    const r = await getJson("/api/auth/logout", { method: "POST" });
    if (r.ok) {
      rememberAuthUser(null);
      renderAuthBox();
      return load();
    }
    ev.target.disabled = false;
    note(r.body.error || "logout failed", true);
  });
}

async function showContinue(token) {
  const r = await getJson("/api/auth/link?t=" + encodeURIComponent(token));
  if (!r.ok) {
    card("Login link not valid",
      "<p>" + esc(r.body.error || "This login link is not valid.") + "</p>" +
      '<p><a href="/login">Get a new one</a> by whispering <code>.login</code> to the bot again.</p>');
    return;
  }
  card("Log in",
    '<div class="who">Continue as ' + esc(r.body.user.name) + "?</div>" +
    '<button class="act" id="go">Continue</button><div id="note"></div>');
  document.getElementById("go").addEventListener("click", async (ev) => {
    ev.target.disabled = true;
    const res = await getJson("/api/auth/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      linkToken = null;
      rememberAuthUser(res.body.user);
      renderAuthBox();
      if (goBack()) return;
      return showLoggedIn(res.body.user);
    }
    ev.target.disabled = false;
    note(res.body.error || "login failed", true);
  });
}

async function load() {
  try {
    const me = await getJson("/api/auth/me");
    // The login page is the one place that asks the server: it corrects the
    // header's remembered user (an expired session, a bot .logout).
    if (me.ok) {
      rememberAuthUser(me.body.user || null);
      renderAuthBox();
    }
    devLogin = !!(me.ok && me.body.devLogin);
    if (linkToken) return await showContinue(linkToken);
    if (me.ok && me.body.user) {
      if (goBack()) return;
      return showLoggedIn(me.body.user);
    }
    showSteps(me.body.bot);
  } catch (e) {
    root.innerHTML = '<div class="error">' + esc(e && e.message ? e.message : String(e)) + "</div>";
  }
}
load();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Polls page (GET /polls, /polls/:slug): one poll (src/polls.ts) — the
// question, a column per option with its picture, single choice, a prominent
// Vote button and View results. Voting needs the website login: a visitor who
// presses Vote is sent to /login (with the pick and the way back saved in
// localStorage), and the vote is cast as soon as they come back logged in.
// A logged-in voter may change their vote; the page shows which one counts.
// Results: overall bars, and the split by the voters' current rank tier with
// the vote counts per option. Admins also see the voter list.
// ---------------------------------------------------------------------------
export const POLLS_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<!--POLL_META--><title>lavabalance · polls</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell">
${sidebar("polls")}
<div class="main">
<header class="top">
  <h1>Polls</h1>
  <span class="meta">one BAR account, one vote · you can change it any time</span>
</header>
<main id="root" class="pollpage"><div class="empty">loading…</div></main>
</div>
</div>

<script>
${SHARED_JS}

const root = document.getElementById("root");
// /polls → the newest poll; /polls/<slug> → that one.
const slugFromUrl = decodeURIComponent((location.pathname.match(/^\\/polls\\/([^/]+)/) || [])[1] || "");
// A pick saved by Vote before the login detour (cast on the way back).
const PENDING_KEY = "pollPendingVote";
const PENDING_TTL_MS = 30 * 60 * 1000;

let state = null;      // the last /api/polls/:slug answer
let selected = null;   // the option key picked on the page
let resultsOpen = false;

async function getJson(url, init) {
  const res = await fetch(url, Object.assign({ headers: { accept: "application/json" } }, init || {}));
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function savePending(slug, choice) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify({ slug, choice, at: Date.now() })); } catch (e) {}
}
function takePending(slug) {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) || "null");
    localStorage.removeItem(PENDING_KEY);
    if (p && p.slug === slug && typeof p.choice === "string" && Date.now() - p.at < PENDING_TTL_MS) return p.choice;
  } catch (e) {}
  return null;
}

function optionOf(key) {
  return state.poll.options.find((o) => o.key === key) || null;
}

function fmtDay(iso) {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
function fmtAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
function pct(n, total) {
  return total ? Math.round((n / total) * 1000) / 10 : 0;
}

function choiceCard(o, open) {
  const mine = state.myVote && state.myVote.choice === o.key;
  return '<div class="choice' + (open ? "" : " closed") + '" data-key="' + esc(o.key) + '" style="--accent:' + esc(o.color) + '">' +
    (mine ? '<span class="mine">\\u2713 your vote</span>' : "") +
    (o.heading ? '<div class="choice-heading"><span class="dot"></span>' + esc(o.heading) + "</div>" : "") +
    (o.image ? '<button type="button" class="shot" data-zoom="' + esc(o.key) + '" aria-label="Enlarge: ' + esc(o.imageAlt || o.heading || o.label) + '">' +
      '<img src="' + esc(o.image) + '" alt="' + esc(o.imageAlt || "") + '" loading="lazy" />' +
      '<span class="zoomhint">\\u{1F50D} enlarge</span></button>' : "") +
    (o.caption ? '<p class="caption">' + esc(o.caption) + "</p>" : "") +
    '<label class="pick"><input type="radio" name="choice" value="' + esc(o.key) + '"' + (open ? "" : " disabled") + " />" +
      '<span class="radio"></span><span class="txt"><span class="lbl">' + esc(o.label) + "</span>" +
      (o.hint ? '<span class="sub">' + esc(o.hint) + "</span>" : "") + "</span></label>" +
  "</div>";
}

function render() {
  const p = state.poll;
  const open = p.open;
  root.innerHTML =
    '<article class="poll">' +
      '<div class="poll-head">' +
        '<div class="poll-kicker"><span class="state' + (open ? "" : " closed") + '">' + (open ? "Open" : "Closed") + "</span>" +
          "<span>Community poll</span><span>\\u00B7</span><span>since " + esc(fmtDay(p.openedAt)) + "</span>" +
          (p.closesAt ? "<span>\\u00B7</span><span>" + (open ? "closes " : "closed ") + esc(fmtDay(p.closesAt)) + "</span>" : "") +
          '<span>\\u00B7</span><span id="voteCount"></span></div>' +
        "<h2>" + esc(p.title) + "</h2>" +
        '<div class="poll-question">' + p.questionHtml + "</div>" +
        '<p class="poll-hint">Pick one. ' + (open ? "You can change your vote until the poll closes." : "This poll no longer takes votes.") + "</p>" +
      "</div>" +
      '<div class="choices" role="radiogroup" aria-label="' + esc(p.title) + '">' + p.options.map((o) => choiceCard(o, open)).join("") + "</div>" +
      '<div class="poll-actions">' +
        (open ? '<button type="button" class="vote-btn" id="voteBtn">Vote</button>' : "") +
        '<button type="button" class="results-btn" id="resultsBtn">\\u{1F4CA} View results</button>' +
        '<span class="poll-status" id="status"></span>' +
      "</div>" +
      '<section class="poll-results" id="results" hidden></section>' +
    "</article>" +
    '<p class="poll-foot">Only logged-in BAR accounts can vote, one vote each. Results show how many voted for each option, ' +
      "and how each rank tier voted. Who picked what is never shown to other players.</p>";

  root.querySelectorAll('input[name="choice"]').forEach((inp) => {
    inp.addEventListener("change", () => select(inp.value));
  });
  root.querySelectorAll(".shot").forEach((b) => {
    b.addEventListener("click", (ev) => { ev.stopPropagation(); zoom(b.dataset.zoom); });
  });
  if (open) document.getElementById("voteBtn").addEventListener("click", vote);
  document.getElementById("resultsBtn").addEventListener("click", () => {
    resultsOpen = !resultsOpen;
    renderResults(true);
    if (resultsOpen) document.getElementById("results").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  select(selected, true);
  renderResults(false);
}

function select(key, quiet) {
  selected = key && optionOf(key) ? key : null;
  root.querySelectorAll(".choice").forEach((c) => c.classList.toggle("selected", c.dataset.key === selected));
  root.querySelectorAll('input[name="choice"]').forEach((i) => { i.checked = i.value === selected; });
  updateVoteButton();
  if (!quiet) status("");
}

function updateVoteButton() {
  const btn = document.getElementById("voteBtn");
  if (!btn) return;
  const mine = state.myVote ? state.myVote.choice : null;
  btn.classList.remove("done");
  btn.disabled = false;
  if (!mine) {
    btn.textContent = "Vote";
  } else if (!selected || selected === mine) {
    btn.textContent = "\\u2713 Voted";
    btn.classList.add("done");
    btn.disabled = true;
  } else {
    btn.textContent = "Change my vote";
  }
  const s = document.getElementById("status");
  if (s && !s.dataset.sticky) defaultStatus();
}

function defaultStatus() {
  const s = document.getElementById("status");
  if (!s || !state.poll.open) return;
  s.className = "poll-status";
  if (state.myVote) {
    const o = optionOf(state.myVote.choice);
    s.innerHTML = "You voted <b>" + esc(o ? o.label : state.myVote.choice) + '</b> <span class="ago">\\u00B7 ' +
      esc(fmtAgo(state.myVote.updatedAt)) + "</span>" +
      (selected && selected !== state.myVote.choice ? " \\u2014 press <b>Change my vote</b> to switch." : "");
  } else if (!state.user) {
    s.innerHTML = '<span class="login">\\u{1F511} Voting needs a BAR login</span> \\u2014 pick an option and press Vote, we will walk you through it.';
  } else {
    s.innerHTML = "Voting as <b>" + esc(state.user.name) + "</b>.";
  }
}

function status(html, cls, sticky) {
  const s = document.getElementById("status");
  if (!s) return;
  if (!html) { delete s.dataset.sticky; return defaultStatus(); }
  s.className = "poll-status" + (cls ? " " + cls : "");
  s.innerHTML = html;
  if (sticky) s.dataset.sticky = "1"; else delete s.dataset.sticky;
}

function goLogin(choice) {
  savePending(state.poll.slug, choice);
  setLoginReturn(location.pathname, "the poll");
  location.href = "/login";
}

async function vote() {
  if (!selected) {
    status("Pick one of the options first.", "err");
    root.querySelectorAll(".choice .pick").forEach((c) => {
      c.classList.remove("shake"); void c.offsetWidth; c.classList.add("shake");
    });
    return;
  }
  // The header's remembered login says nobody is logged in: straight to the
  // login page, no request. (A stale "logged in" is caught by the 401 below.)
  if (!storedAuthUser()) return goLogin(selected);
  await castVote(selected);
}

async function castVote(choice) {
  const btn = document.getElementById("voteBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Voting\\u2026"; }
  const r = await getJson("/api/polls/" + encodeURIComponent(state.poll.slug) + "/vote", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ choice }),
  });
  if (r.status === 401) {
    rememberAuthUser(null);
    return goLogin(choice);
  }
  if (!r.ok) {
    updateVoteButton();
    return status(esc(r.body.error || "Voting failed, try again."), "err", true);
  }
  const previous = r.body.previous;
  state = r.body;
  if (state.user) { rememberAuthUser(state.user); renderAuthBox(); }
  selected = choice;
  resultsOpen = true;
  render();
  const o = optionOf(choice);
  status(previous && previous !== choice
    ? "\\u2713 Vote changed to <b>" + esc(o.label) + "</b>."
    : previous === choice
      ? "\\u2713 That is already your vote: <b>" + esc(o.label) + "</b>."
      : "\\u2713 Thanks! Your vote for <b>" + esc(o.label) + "</b> is counted.", "ok", true);
  renderResults(true);
}

function renderResults(animate) {
  const el = document.getElementById("results");
  const btn = document.getElementById("resultsBtn");
  if (btn) btn.textContent = resultsOpen ? "Hide results" : "\\u{1F4CA} View results";
  const res = state.results;
  const countEl = document.getElementById("voteCount");
  if (countEl) countEl.textContent = res.total + (res.total === 1 ? " vote" : " votes");
  if (!resultsOpen) { el.hidden = true; return; }
  el.hidden = false;
  if (animate) { el.classList.remove("reveal"); void el.offsetWidth; el.classList.add("reveal"); }
  const opts = state.poll.options;
  const mine = state.myVote ? state.myVote.choice : null;
  if (!res.total) {
    el.innerHTML = '<h3>Results</h3><div class="poll-empty">No votes yet. ' + (state.poll.open ? "Be the first!" : "") + "</div>";
    return;
  }
  const max = Math.max.apply(null, opts.map((o) => res.counts[o.key] || 0));
  let html = '<h3>Results <span class="sub">' + res.total + (res.total === 1 ? " vote" : " votes") + "</span></h3>";
  html += '<div class="split" id="split">' + opts.map((o) => {
    const n = res.counts[o.key] || 0;
    return '<div data-basis="' + pct(n, res.total) + '" style="background:' + esc(o.color) + '" title="' + esc(o.label) + ": " + n + '">' +
      (pct(n, res.total) >= 12 ? pct(n, res.total) + "%" : "") + "</div>";
  }).join("") + "</div>";
  html += opts.map((o) => {
    const n = res.counts[o.key] || 0;
    const lead = n === max && n > 0 && opts.filter((x) => (res.counts[x.key] || 0) === max).length === 1;
    return '<div class="rbar" style="--accent:' + esc(o.color) + '">' +
      '<div class="rbar-top"><span class="lbl">' + esc(o.label) + "</span>" +
        (mine === o.key ? '<span class="you">your vote</span>' : "") +
        (lead ? '<span class="lead">\\u2605 leading</span>' : "") +
        '<span class="num">' + n + (n === 1 ? " vote" : " votes") + '<span class="pct">' + pct(n, res.total) + "%</span></span></div>" +
      '<div class="rbar-track"><div class="rbar-fill" data-w="' + pct(n, res.total) + '"></div></div>' +
    "</div>";
  }).join("");

  // By rank tier, best first, unrated last.
  const order = ["diamond", "platinum", "gold", "silver", "bronze", "placing", "unrated"];
  const buckets = res.byTier.slice().sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier));
  if (buckets.length) {
    html += '<div class="tiers"><h4>How each rank voted</h4>' +
      '<div class="legend">' + opts.map((o) => '<span><i style="background:' + esc(o.color) + '"></i>' + esc(o.label) + "</span>").join("") + "</div>" +
      buckets.map((b) => {
        const name = b.tier === "unrated" ? "No rated games" : tierName(b.tier);
        const badge = b.tier === "unrated" ? '<span style="width:20px;text-align:center">\\u2013</span>' : rankEmblem(b.tier, { size: 20 });
        const bar = '<div class="mini">' + opts.map((o) => {
          const n = b.counts[o.key] || 0;
          return n ? '<div style="width:' + pct(n, b.total) + "%;background:" + esc(o.color) + '" title="' + esc(o.label) + ": " + n + " (" + pct(n, b.total) + '%)"></div>' : "";
        }).join("") + "</div>";
        const nums = opts.map((o) => '<b style="color:' + esc(o.color) + '">' + (b.counts[o.key] || 0) + "</b>").join(" \\u00B7 ");
        return '<div class="tier-row"' + (b.tier === "unrated" ? ' title="Logged-in voters who have not played a rated Lava game yet, so they have no rank"' : "") + '><span class="who">' + badge + esc(name) + "</span>" + bar +
          '<span class="n">' + nums + "</span></div>";
      }).join("") + "</div>";
  }

  if (state.voters) {
    html += '<div class="voters"><h4>\\u{1F6E1}\\uFE0F Voters (admin only) \\u00B7 ' + state.voters.length + "</h4>" +
      '<div class="scroll"><table><thead><tr><th>Player</th><th>Rank</th><th>Vote</th><th>Voted</th><th>Changed</th></tr></thead><tbody>' +
      state.voters.map((v) => {
        const o = optionOf(v.choice);
        return '<tr><td><a href="' + playerHref(v.userId) + '">' + esc(v.name) + "</a></td>" +
          "<td>" + (v.tier ? rankBadge(v.tier, v.games, { size: 18 }) : "\\u2013") + "</td>" +
          '<td style="color:' + esc(o ? o.color : "#c7ccd1") + '">' + esc(o ? o.label : v.choice) + "</td>" +
          "<td>" + esc(fmtAgo(v.votedAt)) + "</td>" +
          "<td>" + (v.changes ? v.changes + "\\u00D7, last " + esc(fmtAgo(v.updatedAt)) : "\\u2013") + "</td></tr>";
      }).join("") + "</tbody></table></div></div>";
  }
  el.innerHTML = html;
  // Grow the bars from zero on the next frame, so the reveal animates.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.querySelectorAll(".rbar-fill").forEach((f) => { f.style.width = f.dataset.w + "%"; });
    el.querySelectorAll("#split > div").forEach((d) => { d.style.flexBasis = d.dataset.basis + "%"; });
  }));
}

function zoom(key) {
  const o = optionOf(key);
  if (!o) return;
  const lb = document.createElement("div");
  lb.className = "lightbox";
  lb.style.setProperty("--accent", o.color);
  lb.innerHTML = '<figure><img src="' + esc(o.image) + '" alt="' + esc(o.imageAlt || "") + '" />' +
    "<figcaption><b>" + esc(o.heading || "") + "</b> \\u00B7 " + esc(o.caption || o.label) + "</figcaption></figure>";
  const close = () => { lb.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (ev) => { if (ev.key === "Escape") close(); };
  lb.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(lb);
}

async function load() {
  try {
    let slug = slugFromUrl;
    if (!slug) {
      const list = await getJson("/api/polls");
      if (!list.ok || !list.body.polls || !list.body.polls.length) {
        root.innerHTML = '<div class="empty">No polls right now.</div>';
        return;
      }
      slug = list.body.polls[0].slug;
    }
    const r = await getJson("/api/polls/" + encodeURIComponent(slug));
    if (!r.ok) {
      root.innerHTML = '<div class="error">' + esc(r.body.error || "Could not load the poll.") + "</div>";
      return;
    }
    state = r.body;
    // The server knows who is logged in: keep the header's remembered user right.
    const known = storedAuthUser();
    if ((state.user ? state.user.userId : null) !== (known ? known.userId : null)) {
      rememberAuthUser(state.user);
      renderAuthBox();
    }
    selected = state.myVote ? state.myVote.choice : null;
    resultsOpen = !!state.myVote || !state.poll.open;
    render();
    // Back from the login detour with a pick: cast it now (that is what the
    // Vote press was for). Not logged in after all → just preselect it.
    const pending = takePending(state.poll.slug);
    if (pending && optionOf(pending)) {
      if (state.user && state.poll.open) {
        selected = pending;
        await castVote(pending);
      } else {
        select(pending);
      }
    }
  } catch (e) {
    root.innerHTML = '<div class="error">' + esc(e && e.message ? e.message : String(e)) + "</div>";
  }
}
load();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// "Does it work?" page (GET /does-it-work): the balance report — is a 50:50 game
// really 50:50, the new player handicap, BAR OS/chevron — written for players.
// The report is a standalone static page (public/reports/balance-2026-10.html,
// its own styles and charts), shown in a same-origin iframe sized to its content
// so the site's STYLES and the report's never collide.
// ---------------------------------------------------------------------------
export const DOES_IT_WORK_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lavabalance · does it work?</title>
<style>${STYLES}
  iframe.report { display: block; width: 100%; border: 0; min-height: 80vh; background: #12151b; }
</style>
</head>
<body>
<div class="shell">
${sidebar("doesitwork")}
<div class="main">
<header class="top">
  <h1>Does it work?</h1>
  <span class="meta">balance report · Sep 28 – Oct 31, 2026</span>
</header>
<iframe class="report" id="report" src="/reports/balance-2026-10" scrolling="no" title="Is lava balancing fair? Balance report"></iframe>
</div>
</div>

<script>
${SHARED_JS}

// Grow the iframe to the report's height (same origin), and keep it in step
// when the report reflows (window resize, a chart tab changing height).
// The frame must never scroll on its own: a frame that is even a pixel short
// becomes a nested scroll area, and Firefox then stops the page's wheel
// scrolling at the frame's edge before handing it on. So the frame is
// scrolling="no", the report's own overflow is hidden, and the height is
// rounded up with a little slack.
(function () {
  const f = document.getElementById("report");
  function fit() {
    try {
      const d = f.contentDocument;
      if (d && d.documentElement) f.style.height = (Math.ceil(d.documentElement.scrollHeight) + 2) + "px";
    } catch (e) { /* not same-origin: keep the min-height */ }
  }
  f.addEventListener("load", function () {
    try {
      const d = f.contentDocument;
      const st = d.createElement("style");
      st.textContent = "html,body{overflow:hidden!important}";
      d.head.appendChild(st);
    } catch (e) {}
    fit();
    try { new ResizeObserver(fit).observe(f.contentDocument.body); } catch (e) {}
  });
  window.addEventListener("resize", fit);
})();
</script>
</body>
</html>`;
