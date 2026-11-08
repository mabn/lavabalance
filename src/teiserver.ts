// HTML→JSON mapping for the src=teiserver data source (the stateful Durable Object that
// drives it lives in ./teiserverDO).
//
// This path talks DIRECTLY to Teiserver's web UI instead of rebuilding lobby state from
// the proxied protocol stream (the Dispatcher). The functions here are pure: they take
// the rendered lobby pages and map them into the SAME JSON shape the Dispatcher's
// `lobbies()` returns, so the existing UI consumes it unchanged. Per the chosen scope it
// is filtered to the configured `lava_lobbies`.
//
// Pages scraped (Phoenix LiveView "dead render", so the data is in the initial HTML):
//   • /battle/lobbies            — the lobby list (id, name, map, counts, locked, in-progress)
//   • /battle/lobbies/show/<id>  — one lobby's roster (players + spectators) + max players,
//                                  locked, and the boss list
//
// KNOWN GAPS vs the Dispatcher view (the web UI simply does not render these for a normal
// account, so we report them empty):
//   • founder, gameName, engineVersion — not on the page; reported as "".
//   • rank, away, sync — not on the page; reported as null / false / 0.
//   • team (the unique per-player slot, `player_number`) is moderator-only; reported as 0.
// Derived fields: `ally` = the page's "Team" column (Teiserver's ally-team / side number,
// so lobby teams DO group correctly — unlike the bar-rts source); `skill` = the "Rating"
// column (Teiserver's OpenSkill value, the OS-equivalent the UI rounds for display);
// `ready` = the "Ready" cell text; `spectator` = membership of the spectators table;
// `boss` = membership of the parsed boss list; `party` = the Party column's cell colour
// (an opaque key that doubles as the party's display colour). Lobby-level extras from
// the show page: `balanceAlgorithm` (the consul's "Balance algorithm" line) and
// `inProgress`/`inProgressSec` (the "Match in progress - <duration>" heading). Ratings
// (LOS) are layered on by the detail route via finalizeLobby, not by this source.

// ---- Output shape: identical to Dispatcher.lobbies() so the UI is unchanged. ----

export interface TeiserverLobbyPlayer {
  name: string;
  skill: number | null;
  /**
   * Opaque party key (the show page's Party-column colour, e.g. "#62ea6b"); players
   * sharing a key are in one party, null = unpartied. The colour doubles as the
   * party's display colour — it is the one Teiserver shows for that party.
   */
  party: string | null;
  /** Not rendered for a normal account; always null. */
  rank: number | null;
  /** The whole match is in-progress (per-player in-game isn't rendered); mirrors the lobby. */
  inGame: boolean;
  /** Not rendered; always false. */
  away: boolean;
  ready: boolean;
  spectator: boolean;
  /** Not rendered; always 0 (unknown). */
  sync: number;
  /** Teiserver ally-team / side number (the page's "Team" column). */
  ally: number;
  /** The unique per-player slot is moderator-only; always 0. */
  team: number;
  boss: boolean;
  statusKnown: boolean;
}

export interface TeiserverLobby {
  battleId: number;
  /** Not available from this source; always "". */
  founder: string;
  title: string;
  map: string;
  /** Not available from this source; always "". */
  gameName: string;
  /** Not available from this source; always "". */
  engineVersion: string;
  maxPlayers: number;
  passworded: boolean;
  locked: boolean;
  /** The match has launched (the index's play icon / the show page's heading). */
  inProgress: boolean;
  /**
   * How long the match has been running, in seconds (from the show page's
   * "Match in progress - <duration>" heading). Null when not in progress.
   */
  inProgressSec: number | null;
  /** The lobby's balance algorithm (the show page's "Balance algorithm" line). */
  balanceAlgorithm: string | null;
  /**
   * The lobby's SPADS balanceMode ("clan;skill", "skill", …). Only the host's
   * BarManager broadcast carries it, so this source always reports null.
   */
  balanceMode: string | null;
  spectatorCount: number;
  bosses: string[];
  playerCount: number;
  players: TeiserverLobbyPlayer[];
}

// ---- Parsed intermediates (one per scraped page). Exported for unit testing. ----

/** One row of the /battle/lobbies index table. */
export interface IndexLobby {
  id: number;
  name: string;
  map: string;
  inProgress: boolean;
  locked: boolean;
  passworded: boolean;
  memberCount: number;
  playerCount: number;
  spectatorCount: number;
}

/** A member parsed from a /battle/lobbies/show/<id> roster table. */
export interface ShowMember {
  name: string;
  skill: number | null;
  /** Ally-team / side number ("Team" column); 0 for spectators. */
  ally: number;
  ready: boolean;
  spectator: boolean;
  /**
   * Opaque party key — the "Party" column's cell colour (see `partyKey`). Players
   * sharing a key are in one party; null means unpartied. Teiserver only colours
   * parties with 2+ members, so a key always implies a real party.
   */
  party: string | null;
}

/** The parsed contents of a /battle/lobbies/show/<id> page. */
export interface ShowLobby {
  maxPlayers: number;
  locked: boolean;
  bosses: string[];
  /** The consul's balance algorithm ("Balance algorithm:" line); null if absent. */
  balanceAlgorithm: string | null;
  /** True when the page's heading says "Match in progress". */
  inProgress: boolean;
  /** Elapsed match time in seconds from that heading's duration; null when absent. */
  inProgressSec: number | null;
  members: ShowMember[];
}

// ---- HTML helpers (no DOM in Workers; small, well-scoped regex parsing). ----

/** Strip HTML tags then decode the handful of entities Teiserver emits. */
function cellText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse the leading number out of a cell ("21.24" → 21.24); null if none. */
function parseNumber(s: string): number | null {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract the Phoenix CSRF token from a rendered page. The `<meta name="csrf-token">`
 * value matches the login form's hidden `_csrf_token` on the (unauthenticated) login
 * page, and is what the POST must echo back.
 */
export function extractCsrfToken(html: string): string | null {
  const meta = /<meta\s+name="csrf-token"\s+content="([^"]*)"/.exec(html);
  if (meta) return meta[1];
  const input = /name="_csrf_token"[^>]*value="([^"]*)"/.exec(html);
  return input ? input[1] : null;
}

/** Parse the /battle/lobbies index into a map of battle id → row summary. */
export function parseLobbyIndex(html: string): Map<number, IndexLobby> {
  const out = new Map<number, IndexLobby>();
  for (const row of html.matchAll(/<tr id="lobby-(\d+)">([\s\S]*?)<\/tr>/g)) {
    const id = Number(row[1]);
    const tds = [...row[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    // Columns (no moderator/tester variance on this table): name, map, status (play icon),
    // locked (lock icon), password (key icon), members, players, spectators.
    out.set(id, {
      id,
      name: cellText(tds[0] ?? ""),
      map: cellText(tds[1] ?? ""),
      inProgress: /fa-play/.test(tds[2] ?? ""),
      locked: /fa-lock/.test(tds[3] ?? ""),
      passworded: /fa-key/.test(tds[4] ?? ""),
      memberCount: parseNumber(cellText(tds[5] ?? "")) ?? 0,
      playerCount: parseNumber(cellText(tds[6] ?? "")) ?? 0,
      spectatorCount: parseNumber(cellText(tds[7] ?? "")) ?? 0,
    });
  }
  return out;
}

/**
 * Pull one `<table id="...">`'s header labels and body rows. `rows` holds the cell
 * TEXT; `rawRows` keeps each `<td …>…</td>` verbatim, because one column (Party)
 * carries its value in an attribute rather than as text — see `partyKey`.
 */
function parseTable(
  html: string,
  tableId: string,
): { headers: string[]; rows: string[][]; rawRows: string[][] } {
  const tbl = new RegExp(`<table[^>]*id="${tableId}"[\\s\\S]*?</table>`).exec(html);
  if (!tbl) return { headers: [], rows: [], rawRows: [] };
  const thead = /<thead>([\s\S]*?)<\/thead>/.exec(tbl[0]);
  const headers = thead
    ? [...thead[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => cellText(m[1]))
    : [];
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(tbl[0]);
  const rows: string[][] = [];
  const rawRows: string[][] = [];
  if (tbody) {
    for (const r of tbody[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
      if (!cells.length) continue;
      rows.push(cells.map((m) => cellText(m[1])));
      rawRows.push(cells.map((m) => m[0]));
    }
  }
  return { headers, rows, rawRows };
}

/**
 * The "Party" column identifies parties by CELL COLOUR, not text: Teiserver assigns
 * each party (2+ members only) a distinct background colour and renders an otherwise
 * empty cell — `<td style="background-color: #62ea6b;" width="50">&nbsp;</td>` — so
 * players sharing a colour are in one party, and an unstyled cell means "no party".
 * Returns the normalised colour as an opaque party key, or null.
 */
export function partyKey(rawCell: string): string | null {
  const m = /background-color:\s*([^;"']+)/i.exec(rawCell);
  const colour = m?.[1]?.trim().toLowerCase();
  return colour ? colour : null;
}

/**
 * Parse a /battle/lobbies/show/<id> page. Reads cells by their header label so the
 * parser is robust to the extra columns a moderator/tester account would see.
 */
export function parseLobbyShow(html: string): ShowLobby {
  const maxPlayers = parseNumber((/Max players:\s*(\d+)/.exec(html) ?? [])[1] ?? "") ?? 0;
  const locked = /Locked:\s*true/.test(html);

  // "Balance algorithm: <name>" from the lobby-facts list (a consul setting,
  // e.g. "loser_picks" / "split_one_chevs").
  let balanceAlgorithm: string | null = null;
  const ba = /Balance algorithm:\s*([\s\S]*?)<\/li>/.exec(html);
  if (ba) balanceAlgorithm = cellText(ba[1]) || null;

  // The page heading is "Match in progress - <duration> - <name> - <map>" while the
  // game runs (else "Pre-game lobby - …"). The duration is TimexHelper's short form:
  // "[Nd ][H:]MM:SS" (minutes/seconds zero-padded, hours/days only when non-zero).
  const inProgress = /Match in progress/.test(html);
  let inProgressSec: number | null = null;
  const dur = /Match in progress\s*-\s*(?:(\d+)d\s+)?(?:(\d+):)?(\d{1,2}):(\d{2})/.exec(html);
  if (dur) {
    inProgressSec =
      Number(dur[1] ?? 0) * 86400 +
      Number(dur[2] ?? 0) * 3600 +
      Number(dur[3]) * 60 +
      Number(dur[4]);
  }

  let bosses: string[] = [];
  const bm = /Bosses:\s*([\s\S]*?)<\/li>/.exec(html);
  if (bm) {
    const txt = cellText(bm[1]);
    if (txt && !/^No boss$/i.test(txt)) {
      bosses = txt.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  const members: ShowMember[] = [];
  const col = (headers: string[], label: string) =>
    headers.findIndex((h) => h.toLowerCase() === label.toLowerCase());
  const cell = (row: string[], idx: number) => (idx >= 0 ? (row[idx] ?? "") : "");

  const players = parseTable(html, "players-table");
  const pName = col(players.headers, "Name");
  const pReady = col(players.headers, "Ready");
  const pTeam = col(players.headers, "Team");
  const pRating = col(players.headers, "Rating");
  const pParty = col(players.headers, "Party");
  for (const [i, r] of players.rows.entries()) {
    const name = cell(r, pName);
    if (!name) continue;
    members.push({
      name,
      skill: parseNumber(cell(r, pRating)),
      ally: parseNumber(cell(r, pTeam)) ?? 0,
      ready: cell(r, pReady).toLowerCase() === "ready",
      spectator: false,
      party: pParty >= 0 ? partyKey(players.rawRows[i]?.[pParty] ?? "") : null,
    });
  }

  const specs = parseTable(html, "spectators-table");
  const sName = col(specs.headers, "Name");
  const sRating = col(specs.headers, "Rating");
  for (const r of specs.rows) {
    const name = cell(r, sName);
    if (!name) continue;
    members.push({
      name,
      skill: parseNumber(cell(r, sRating)),
      ally: 0,
      ready: false,
      spectator: true,
      party: null, // the spectators table has no Party column
    });
  }

  return { maxPlayers, locked, bosses, balanceAlgorithm, inProgress, inProgressSec, members };
}

/**
 * Combine an index row + its show page into one `lobbies()`-shaped lobby. Pure / testable.
 */
export function buildLobby(index: IndexLobby, show: ShowLobby): TeiserverLobby {
  const players: TeiserverLobbyPlayer[] = show.members
    .map((m) => {
      return {
        name: m.name,
        skill: m.skill,
        party: m.party,
        rank: null,
        inGame: index.inProgress,
        away: false,
        ready: m.ready,
        spectator: m.spectator,
        sync: 0,
        ally: m.ally,
        team: 0,
        boss: show.bosses.includes(m.name),
        statusKnown: true,
      };
    })
    // Match the Dispatcher view: players ordered by OS (skill) high→low, unknown last.
    .sort((a, b) => (b.skill ?? -Infinity) - (a.skill ?? -Infinity));

  const spectatorCount = show.members.filter((m) => m.spectator).length;

  return {
    battleId: index.id,
    founder: "",
    title: index.name,
    map: index.map,
    gameName: "",
    engineVersion: "",
    maxPlayers: show.maxPlayers,
    passworded: index.passworded,
    locked: show.locked,
    inProgress: index.inProgress || show.inProgress,
    inProgressSec: show.inProgressSec,
    balanceAlgorithm: show.balanceAlgorithm,
    balanceMode: null, // not on the show page — only the host broadcasts it
    spectatorCount,
    bosses: show.bosses,
    playerCount: show.members.length,
    players,
  };
}
