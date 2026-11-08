// Scouting — play-style cards from onetricklava (OTL), the wire shape and the
// pure logic over it (no `cloudflare:*` / `node:*`, so the Node unit pool and
// the bot both load it).
//
// OTL parses every lava demo and folds each player's career into a behaviour
// profile: archetypes ("Economist", "Frontliner"…), warning badges ("💥 Comm
// bomber"), the named Supreme Isthmus lanes they start on and how they do
// there, commander habits. lavabalance has the ratings and the live lobby but
// never sees a demo. OTL PUSHES compact cards here (POST /api/scout/profiles,
// src/scoutRoutes.ts, stored in the LosDO's scout_profiles table) and this
// module turns them into what the site and the bot show:
//
//   • `parseScoutUpload` — the strict validator for one push (a garbage or
//     hostile body never reaches the table; every string is length-capped,
//     every number range-checked, unknown keys dropped);
//   • `laneForecast` — who on each team is likely to take which lane, as a
//     maximum-weight assignment (each lane at most once per team, each player
//     at most once) over the players' own lane shares;
//   • `teamScouting` — per team: the threats (badge holders), the style mix,
//     mean aggression / eco focus;
//   • `scoutBoards` — the Scouting page's watch list and lane kings;
//   • `scoutLine` — the bot's one-line `.scout <player>` answer.
//
// Privacy: a card is a public behavioural summary of public replays, but a
// player whose LOS profile an admin made private (players.private_profile)
// gets no card either — the LosDO filters on read, exactly like the rating.

/** One warning badge, as OTL's `profile_builder._awards` produces it. */
export interface ScoutBadge {
  id: string;
  icon: string;
  label: string;
  caption: string;
}

/** One named start lane (OTL merges the two mirror spots into one name). */
export interface ScoutLane {
  name: string;
  /** Games this player started on this lane. */
  games: number;
  /** Fraction of their games played on this lane (0..1). */
  share: number;
  /** Win rate over the decided games on this lane, null when none was decided. */
  winRate: number | null;
}

/** OTL's career trait means (each a 0..1 fraction unless named otherwise). */
export interface ScoutTraits {
  aggression: number | null;
  ecoFocus: number | null;
  defenseFocus: number | null;
  forwardness: number | null;
  apm: number | null;
  /** Median seconds to the first offensive action. */
  firstOffenseS: number | null;
}

/** Commander habits (rates are fractions of tracked games). */
export interface ScoutCommander {
  bombRate: number | null;
  dropRate: number | null;
  walkRate: number | null;
  /** Median seconds to the first D-gun. */
  firstDgunS: number | null;
}

/** A player's scouting card — one row of scout_profiles. */
export interface ScoutCard {
  /** BAR account id: the same id LOS keys players on. */
  userId: number;
  name: string;
  /** Games OTL parsed for this player. */
  games: number;
  winRate: number | null;
  faction: string | null;
  archetypes: string[];
  badges: ScoutBadge[];
  lanes: ScoutLane[];
  traits: ScoutTraits;
  commander: ScoutCommander;
  /** OTL's "most dangerous" score (comm habits + aggression + rush timing, regular-weighted). */
  danger: number | null;
  lastSeen: string | null;
}

/** One validated push. */
export interface ScoutUpload {
  profiles: ScoutCard[];
  /** Account ids whose card OTL no longer publishes. */
  remove: number[];
  /** When OTL built this batch (ISO), informational. */
  generatedAt: string | null;
}

/** Most cards one push may carry (OTL sends batches of 500). */
export const MAX_SCOUT_BATCH = 1000;
/** Most removals one push may carry. */
export const MAX_SCOUT_REMOVALS = 5000;

const MAX_NAME = 64;
const MAX_TAG = 40;
const MAX_CAPTION = 200;
const MAX_ICON = 8;
const MAX_ARCHETYPES = 8;
const MAX_BADGES = 6;
const MAX_LANES = 8;

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function num(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

function frac(v: unknown): number | null {
  const n = num(v, 0, 1);
  return n == null ? null : Math.round(n * 1000) / 1000;
}

function count(v: unknown): number {
  const n = num(v, 0, 1_000_000);
  return n == null ? 0 : Math.floor(n);
}

function obj(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function accountId(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** One card from untrusted JSON, or null when it has no usable id/name. */
export function parseScoutCard(raw: unknown): ScoutCard | null {
  const o = obj(raw);
  const userId = accountId(o.userId);
  const name = str(o.name, MAX_NAME);
  if (userId == null || name == null) return null;
  const t = obj(o.traits);
  const c = obj(o.commander);
  const archetypes: string[] = [];
  for (const a of arr(o.archetypes)) {
    const s = str(a, MAX_TAG);
    if (s && !archetypes.includes(s)) archetypes.push(s);
    if (archetypes.length >= MAX_ARCHETYPES) break;
  }
  const badges: ScoutBadge[] = [];
  for (const b of arr(o.badges)) {
    const bo = obj(b);
    const id = str(bo.id, MAX_TAG);
    const label = str(bo.label, MAX_TAG * 2);
    if (!id || !label || badges.some((x) => x.id === id)) continue;
    badges.push({ id, icon: str(bo.icon, MAX_ICON) ?? "", label, caption: str(bo.caption, MAX_CAPTION) ?? "" });
    if (badges.length >= MAX_BADGES) break;
  }
  const lanes: ScoutLane[] = [];
  for (const l of arr(o.lanes)) {
    const lo = obj(l);
    const lane = str(lo.name, MAX_TAG);
    // OTL's internal spot ids (P1..P16) are never a lane name worth showing.
    if (!lane || /^P\d+$/i.test(lane) || lanes.some((x) => x.name === lane)) continue;
    lanes.push({ name: lane, games: count(lo.games), share: frac(lo.share) ?? 0, winRate: frac(lo.winRate) });
    if (lanes.length >= MAX_LANES) break;
  }
  lanes.sort((a, b) => b.share - a.share || b.games - a.games || a.name.localeCompare(b.name));
  return {
    userId,
    name,
    games: count(o.games),
    winRate: frac(o.winRate),
    faction: str(o.faction, MAX_TAG),
    archetypes,
    badges,
    lanes,
    traits: {
      aggression: frac(t.aggression),
      ecoFocus: frac(t.ecoFocus),
      defenseFocus: frac(t.defenseFocus),
      forwardness: frac(t.forwardness),
      apm: num(t.apm, 0, 2000),
      firstOffenseS: num(t.firstOffenseS, 0, 24 * 3600),
    },
    commander: {
      bombRate: frac(c.bombRate),
      dropRate: frac(c.dropRate),
      walkRate: frac(c.walkRate),
      firstDgunS: num(c.firstDgunS, 0, 24 * 3600),
    },
    danger: num(o.danger, 0, 1000),
    lastSeen: str(o.lastSeen, 40),
  };
}

/**
 * Validate one push: `{profiles: [...], remove?: [ids], generatedAt?}`.
 * Throws with a message fit for a 400 on anything structurally wrong; a
 * single card without an id or a name is skipped rather than failing the
 * batch (`skipped` counts them), since one bad profile must not block the rest.
 */
export function parseScoutUpload(body: unknown): ScoutUpload & { skipped: number } {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("body must be a JSON object {profiles: [...], remove?: [...]}");
  }
  const b = body as Record<string, unknown>;
  if (b.profiles !== undefined && !Array.isArray(b.profiles)) throw new Error("profiles must be an array");
  if (b.remove !== undefined && !Array.isArray(b.remove)) throw new Error("remove must be an array of account ids");
  const rawProfiles = arr(b.profiles);
  const rawRemove = arr(b.remove);
  if (rawProfiles.length > MAX_SCOUT_BATCH) {
    throw new Error(`at most ${MAX_SCOUT_BATCH} profiles per push (got ${rawProfiles.length})`);
  }
  if (rawRemove.length > MAX_SCOUT_REMOVALS) {
    throw new Error(`at most ${MAX_SCOUT_REMOVALS} removals per push (got ${rawRemove.length})`);
  }
  const byId = new Map<number, ScoutCard>();
  let skipped = 0;
  for (const p of rawProfiles) {
    const card = parseScoutCard(p);
    if (card) byId.set(card.userId, card); // a repeated id: the later card wins
    else skipped++;
  }
  const remove = [...new Set(rawRemove.map(accountId).filter((id): id is number => id != null))].filter(
    (id) => !byId.has(id),
  );
  return { profiles: [...byId.values()], remove, generatedAt: str(b.generatedAt, 40), skipped };
}

// --------------------------------------------------------------- lane forecast

/**
 * Supreme Isthmus lanes as the lava lobby names them (OTL's positions.txt),
 * front to back. Only fixes the ROW ORDER of a forecast: a lane name OTL
 * starts using that is not listed here still shows, after these.
 */
export const LANE_ORDER = [
  "Front Suicide",
  "Front Second",
  "Pond",
  "Geo",
  "Geo Sea",
  "Beach Sea",
  "Eco",
  "Air",
] as const;

/** Most lanes one forecast assigns over (keeps the bitmask search tiny). */
const MAX_FORECAST_LANES = 12;

/** A forecast seat: the player expected on a lane, and their record there. */
export interface LanePick {
  name: string;
  userId: number;
  share: number;
  games: number;
  winRate: number | null;
}

export interface LaneForecast {
  /** One row per lane, `picks[i]` = team i's expected player (null = nobody known). */
  lanes: { lane: string; picks: (LanePick | null)[] }[];
  /** Per team: scouted players the forecast left without a lane (all their lanes taken). */
  flex: string[][];
}

/** A player to forecast: their lobby name and card (null = OTL has no card). */
export interface ForecastPlayer {
  name: string;
  card: ScoutCard | null;
}

/** How strongly a lane share predicts the seat: a share from 1-2 games is a hint, not a habit. */
function laneWeight(l: ScoutLane): number {
  return l.share * (l.games >= 5 ? 1 : l.games >= 2 ? 0.75 : 0.4);
}

function laneRank(name: string): number {
  const i = (LANE_ORDER as readonly string[]).indexOf(name);
  return i < 0 ? LANE_ORDER.length : i;
}

/**
 * Best assignment of one team's players to lanes: maximise the summed lane
 * weight, each lane used once, a player unassigned when every lane they play
 * is better spent on somebody else. Exact (DP over players × used-lane mask),
 * fine for the ≤ 12 lanes and a 16-player team at most.
 */
function assignTeam(players: ForecastPlayer[], lanes: string[]): Map<string, number> {
  const L = lanes.length;
  const laneIdx = new Map(lanes.map((l, i) => [l, i]));
  const opts = players.map((p) =>
    (p.card?.lanes ?? [])
      .filter((l) => laneIdx.has(l.name) && l.share > 0)
      .map((l) => ({ lane: laneIdx.get(l.name)!, w: laneWeight(l) })),
  );
  const n = players.length;
  const size = 1 << L;
  // best[i][mask]: max weight placing players i..n-1 given lanes in `mask` are taken.
  const best: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(size));
  for (let i = n - 1; i >= 0; i--) {
    for (let mask = 0; mask < size; mask++) {
      let v = best[i + 1][mask];
      for (const o of opts[i]) {
        if (mask & (1 << o.lane)) continue;
        const cand = o.w + best[i + 1][mask | (1 << o.lane)];
        if (cand > v + 1e-12) v = cand;
      }
      best[i][mask] = v;
    }
  }
  const out = new Map<string, number>(); // player name → lane index
  let mask = 0;
  for (let i = 0; i < n; i++) {
    // Any lane that achieves the optimum; on a tie with leaving them out, seat them.
    const pick = opts[i].find(
      (o) => !(mask & (1 << o.lane)) && Math.abs(o.w + best[i + 1][mask | (1 << o.lane)] - best[i][mask]) < 1e-9,
    );
    if (pick) {
      out.set(players[i].name, pick.lane);
      mask |= 1 << pick.lane;
    }
  }
  return out;
}

/**
 * Forecast who takes which lane, team by team. Null when nobody in the lobby
 * has a lane on their card (nothing to say). Players are visited in the order
 * given, which only breaks exact ties.
 */
export function laneForecast(teams: ForecastPlayer[][]): LaneForecast | null {
  const totals = new Map<string, number>();
  for (const team of teams) {
    for (const p of team) for (const l of p.card?.lanes ?? []) totals.set(l.name, (totals.get(l.name) ?? 0) + laneWeight(l));
  }
  if (totals.size === 0) return null;
  // The lanes worth forecasting: every known one, or the heaviest when OTL
  // somehow names more than the search is sized for.
  const lanes = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_FORECAST_LANES)
    .map(([l]) => l)
    .sort((a, b) => laneRank(a) - laneRank(b) || a.localeCompare(b));
  const picks = teams.map((team) => assignTeam(team, lanes));
  const rows = lanes.map((lane, li) => ({
    lane,
    picks: teams.map((team, ti) => {
      for (const p of team) {
        if (picks[ti].get(p.name) !== li || !p.card) continue;
        const l = p.card.lanes.find((x) => x.name === lane)!;
        return { name: p.name, userId: p.card.userId, share: l.share, games: l.games, winRate: l.winRate };
      }
      return null;
    }),
  }));
  const flex = teams.map((team, ti) =>
    team.filter((p) => p.card && p.card.lanes.length > 0 && !picks[ti].has(p.name)).map((p) => p.name),
  );
  return { lanes: rows.filter((r) => r.picks.some((p) => p != null)), flex };
}

// --------------------------------------------------------------- team summary

export interface TeamThreat {
  id: string;
  icon: string;
  label: string;
  names: string[];
}

export interface TeamScout {
  /** How many of the team's players OTL has a card for. */
  scouted: number;
  players: number;
  /** Badge holders, most common badge first. */
  threats: TeamThreat[];
  /** The team's most common archetypes (top 3). */
  styles: { archetype: string; count: number }[];
  /** Mean aggression / eco focus over the scouted players, null when none had one. */
  aggression: number | null;
  ecoFocus: number | null;
}

function mean(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000 : null;
}

/** One team's scouting summary (players with no card count only in `players`). */
export function teamScouting(team: ForecastPlayer[]): TeamScout {
  const cards = team.map((p) => ({ name: p.name, card: p.card })).filter((p) => p.card != null) as {
    name: string;
    card: ScoutCard;
  }[];
  const threats = new Map<string, TeamThreat>();
  const styles = new Map<string, number>();
  for (const { name, card } of cards) {
    for (const b of card.badges) {
      const t = threats.get(b.id) ?? { id: b.id, icon: b.icon, label: b.label, names: [] };
      t.names.push(name);
      threats.set(b.id, t);
    }
    for (const a of card.archetypes) styles.set(a, (styles.get(a) ?? 0) + 1);
  }
  return {
    scouted: cards.length,
    players: team.length,
    threats: [...threats.values()].sort((a, b) => b.names.length - a.names.length || a.label.localeCompare(b.label)),
    styles: [...styles.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([archetype, n]) => ({ archetype, count: n })),
    aggression: mean(cards.map((c) => c.card.traits.aggression)),
    ecoFocus: mean(cards.map((c) => c.card.traits.ecoFocus)),
  };
}

/** The compact per-player summary the lobby roster carries. */
export interface ScoutSummary {
  archetypes: string[];
  badges: ScoutBadge[];
  lane: { name: string; share: number; winRate: number | null } | null;
  games: number;
}

export function scoutSummary(card: ScoutCard): ScoutSummary {
  const top = card.lanes[0];
  return {
    archetypes: card.archetypes.slice(0, 3),
    badges: card.badges,
    lane: top ? { name: top.name, share: top.share, winRate: top.winRate } : null,
    games: card.games,
  };
}

/** Is this the map OTL's lanes are named for? (Every lava-lobby lane name is Supreme Isthmus.) */
export function lanesApply(map: string | null | undefined): boolean {
  return /supreme\s*isthmus/i.test(map ?? "");
}

// --------------------------------------------------------------- boards

/** Fewest OTL games for a place on a board (OTL's own danger board uses 50). */
export const BOARD_MIN_GAMES = 50;
/** Fewest games ON a lane for a lane-king place. */
export const LANE_KING_MIN_GAMES = 20;
/** Entries kept per board (filtering private players on read eats into it). */
export const BOARD_KEEP = 40;

export interface WatchEntry {
  userId: number;
  name: string;
  games: number;
  danger: number;
  badges: ScoutBadge[];
  archetypes: string[];
  lane: string | null;
}

export interface LaneKing {
  userId: number;
  name: string;
  games: number;
  winRate: number;
}

export interface ScoutBoards {
  watchlist: WatchEntry[];
  /** Per lane (LANE_ORDER first), the best win rates on it. */
  laneKings: { lane: string; kings: LaneKing[] }[];
}

/** Build both boards from every stored card. */
export function scoutBoards(cards: Iterable<ScoutCard>): ScoutBoards {
  const watch: WatchEntry[] = [];
  const lanes = new Map<string, LaneKing[]>();
  for (const c of cards) {
    if (c.games < BOARD_MIN_GAMES) continue;
    if (c.danger != null && c.danger > 0) {
      watch.push({
        userId: c.userId,
        name: c.name,
        games: c.games,
        danger: c.danger,
        badges: c.badges,
        archetypes: c.archetypes.slice(0, 3),
        lane: c.lanes[0]?.name ?? null,
      });
    }
    for (const l of c.lanes) {
      if (l.games < LANE_KING_MIN_GAMES || l.winRate == null) continue;
      const list = lanes.get(l.name) ?? [];
      list.push({ userId: c.userId, name: c.name, games: l.games, winRate: l.winRate });
      lanes.set(l.name, list);
    }
  }
  watch.sort((a, b) => b.danger - a.danger || b.games - a.games || a.userId - b.userId);
  return {
    watchlist: watch.slice(0, BOARD_KEEP),
    laneKings: [...lanes.entries()]
      .sort((a, b) => laneRank(a[0]) - laneRank(b[0]) || a[0].localeCompare(b[0]))
      .map(([lane, kings]) => ({
        lane,
        kings: kings
          .sort((a, b) => b.winRate - a.winRate || b.games - a.games || a.userId - b.userId)
          .slice(0, BOARD_KEEP),
      })),
  };
}

/** The boards without the given (private) players. */
export function filterBoards(boards: ScoutBoards, hidden: ReadonlySet<number>, keep: number): ScoutBoards {
  return {
    watchlist: boards.watchlist.filter((e) => !hidden.has(e.userId)).slice(0, keep),
    laneKings: boards.laneKings.map((l) => ({
      lane: l.lane,
      kings: l.kings.filter((k) => !hidden.has(k.userId)).slice(0, keep),
    })),
  };
}

// --------------------------------------------------------------- the bot's line

function pct(f: number | null): string {
  return f == null ? "?" : Math.round(f * 100) + "%";
}

/** Longest `.scout` answer (one chat line). */
const SCOUT_LINE_MAX = 300;

/**
 * `.scout <player>` in one line: "Songi (1140 games) — Economist, Backline /
 * tech · plays Eco 62% (won 71%), Geo 20% · 💥 Comm bomber". Built from what
 * the card has; every part is optional.
 */
export function scoutLine(card: ScoutCard): string {
  const parts = [`${card.name} (${card.games} games, won ${pct(card.winRate)})`];
  if (card.archetypes.length) parts.push(card.archetypes.slice(0, 3).join(", "));
  if (card.lanes.length) {
    parts.push(
      "plays " +
        card.lanes
          .slice(0, 2)
          .map((l, i) => `${l.name} ${pct(l.share)}` + (i === 0 && l.winRate != null ? ` (won ${pct(l.winRate)})` : ""))
          .join(", "),
    );
  }
  if (card.badges.length) parts.push(card.badges.map((b) => (b.icon ? b.icon + " " : "") + b.label).join(", "));
  const line = parts.join(" · ");
  return line.length > SCOUT_LINE_MAX ? line.slice(0, SCOUT_LINE_MAX - 1) + "…" : line;
}

// --------------------------------------------------------------- the lobby view

/** The `scouting` block `/api/lobbies/:id` carries (null when OTL knows nobody there). */
export interface LobbyScouting {
  /** One per ally team, ally ascending — the order the page draws its teams in. */
  teams: (TeamScout & { ally: number })[];
  /** Lane forecast, ally order as `teams`; null off Supreme Isthmus or with no lanes known. */
  lanes: LaneForecast | null;
}

/** What scoutLobby needs of a lobby player (finalizeLobby's output has all of it). */
export interface ScoutablePlayer {
  name: string;
  ally: number;
  spectator: boolean;
  losUserId: number | null;
}

/**
 * Attach the cards to a finalized lobby roster: each player gets `scout` (the
 * compact summary, null without a card) and the lobby a `scouting` report.
 * A card matches by account id first (the id LOS resolved for the name), by
 * lowercased name otherwise — the cards were looked up the same way.
 */
export function scoutLobby<P extends ScoutablePlayer>(
  players: P[],
  cards: ScoutCard[],
  map: string | null | undefined,
): { players: (P & { scout: ScoutSummary | null })[]; scouting: LobbyScouting | null } {
  const byId = new Map(cards.map((c) => [c.userId, c]));
  const byName = new Map(cards.map((c) => [c.name.toLowerCase(), c]));
  const cardOf = (p: P): ScoutCard | null =>
    (p.losUserId != null ? byId.get(p.losUserId) : undefined) ?? byName.get(p.name.trim().toLowerCase()) ?? null;
  const out = players.map((p) => {
    const card = p.spectator ? null : cardOf(p);
    return { ...p, scout: card ? scoutSummary(card) : null };
  });
  const allies = [...new Set(players.filter((p) => !p.spectator).map((p) => p.ally))].sort((a, b) => a - b);
  const teams: ForecastPlayer[][] = allies.map((ally) =>
    players
      .filter((p) => !p.spectator && p.ally === ally)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ name: p.name, card: cardOf(p) })),
  );
  if (!teams.some((t) => t.some((p) => p.card != null))) return { players: out, scouting: null };
  return {
    players: out,
    scouting: {
      teams: teams.map((t, i) => ({ ally: allies[i], ...teamScouting(t) })),
      lanes: lanesApply(map) ? laneForecast(teams) : null,
    },
  };
}
