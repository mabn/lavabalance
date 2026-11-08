// The LOS public API routes (docs/lavaos-cloudflare-data-model.md), mounted
// into the lavabalance Worker's Hono app (src/index.ts) — historically a
// separate "lavaos" Worker, merged since there was no reason for two
// deployments. API only, no UI. All state lives in the singleton LosDO; these
// routes parse/validate requests, forward them over RPC, and mark GET
// responses edge-cacheable. Route paths are disjoint from the lobby API
// (/api/games, /api/ranking, /api/players vs /api/lobbies, /api/scores), so
// the public URLs survived the merge unchanged.

import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { fetchReplayStatuses, replayCacheHeaders, replayTiming, type ReplayStatus } from "../barreplay";
import type { ReplayDetail } from "../lavaos/types";
import { parseRankingSort } from "./losDO";
import type { LosEnv } from "./losDO";
import { adminRequest, botIdentity, botAccessConfigured, type AdminEnv } from "../access";
import { stripLos } from "./tiers";

const LOS_SINGLETON = "singleton";

/** The singleton LosDO stub — shared with src/losRatings.ts. */
export function losStub(env: LosEnv) {
  return env.LOS.get(env.LOS.idFromName(LOS_SINGLETON));
}

/** Sanity cap on one upload's game count (a month of lava is ~800). */
const MAX_UPLOAD_GAMES = 5000;

/** Data changes only on upload, so every read is edge-cacheable briefly. */
const CACHE_CONTROL = "public, max-age=60";

type Env = LosEnv & AdminEnv;

/**
 * `?includePrivate=true` — the ADMIN view: profiles an admin has hidden
 * (`private_profile`) are listed too, rather than filtered out of the ranking
 * and stripped of their rating on the player routes. Granted only to a
 * superadmin (Cloudflare Access, src/access.ts); anyone else asking gets the
 * public view.
 *
 * A request ASKING for it is `no-store` either way: a hidden profile must
 * never be handed to the next reader from an edge cache, a toggle has to show
 * up immediately, and a public copy cached under the admin URL must not
 * outlive a sign-in.
 */
async function adminView(c: Context<{ Bindings: Env }>): Promise<boolean> {
  return c.req.query("includePrivate") === "true" && (await adminRequest(c.env, c.req.raw)) !== null;
}

/**
 * LOS itself is for admins only: anyone else gets every LOS figure removed
 * (stripLos) and sees the rank tier the same answers carry. Keyed on the same
 * admin view as the private profiles, so the shared edge cache never holds an
 * admin's copy (readCache: `no-store` whenever the flag is asked for).
 */
function view<T>(admin: boolean, body: T): T {
  return admin ? body : stripLos(body);
}

function readCache(c: Context<{ Bindings: Env }>): Record<string, string> {
  return { "Cache-Control": c.req.query("includePrivate") === "true" ? "no-store" : CACHE_CONTROL };
}

/** The admin row actions' guard: 401 without a superadmin credential. */
const requireAdmin = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  if ((await adminRequest(c.env, c.req.raw)) === null) {
    return c.json({ error: "admin sign-in required", login: "/admin/login" }, 401, { "Cache-Control": "no-store" });
  }
  await next();
});

function errorResponse(c: Context<{ Bindings: Env }>, message: string, status: ContentfulStatusCode) {
  console.error(`error response ${status}: ${message}`);
  return c.json({ error: message }, status);
}

/**
 * Validate the upload body just enough to fail fast with a useful message —
 * the DO's classifier does the real work. Accepts a bare ReplayDetail array
 * (the scraper's day-file content verbatim) or `{games: [...]}`.
 */
function parseUploadBody(body: unknown): { games: ReplayDetail[] } | { error: string } {
  const raw = Array.isArray(body)
    ? body
    : body != null && typeof body === "object" && Array.isArray((body as { games?: unknown }).games)
      ? (body as { games: unknown[] }).games
      : null;
  if (raw == null) return { error: "body must be a JSON array of replays (or {games: [...]})" };
  if (raw.length > MAX_UPLOAD_GAMES) {
    return { error: `too many games in one upload (${raw.length} > ${MAX_UPLOAD_GAMES})` };
  }
  for (let i = 0; i < raw.length; i++) {
    const g = raw[i] as Partial<ReplayDetail> | null;
    if (
      g == null ||
      typeof g !== "object" ||
      typeof g.id !== "string" ||
      g.id.length === 0 ||
      typeof g.startTime !== "string" ||
      typeof g.durationMs !== "number" ||
      !Array.isArray(g.AllyTeams)
    ) {
      return { error: `games[${i}] is not a replay detail (need id, startTime, durationMs, AllyTeams)` };
    }
  }
  return { games: raw as ReplayDetail[] };
}

function intParam(value: string | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

export const losApp = new Hono<{ Bindings: Env }>();
const app = losApp; // route definitions below predate the merge; keep them short

// ----------------------------------------------------------------- writes

// Re-run the rating fold from one stored game onward (LosDO.rebase — the
// recovery for a game that arrived behind the fold head). Superadmin only
// (requireAdmin: the Access cookie the admin UI's button carries, or the
// control token).
app.post("/api/games/:id/rebase", requireAdmin, async (c) => {
  // Optional body: {includeOffMap: true} rates games on other maps too;
  // absent or anything else keeps the rating Supreme-Isthmus-only.
  const body = await c.req.json().catch(() => ({}));
  const includeOffMap = (body as { includeOffMap?: unknown })?.includeOffMap === true;
  const r = await losStub(c.env).rebase(c.req.param("id"), includeOffMap);
  if (!r.ok) return errorResponse(c, r.error, r.error === "no such stored game" ? 404 : 409);
  console.log(
    `LOS rebase from ${r.from}: ${r.rated} rated, ${r.ignored} ignored over ${r.games} games, ` +
      `${r.players} players rebuilt (seq ${r.lastSeq})`,
  );
  return c.json(r);
});

// Mark one stored game ignored, or unmark it — the games page's admin row menu
// ("Ignore game" / "Un-ignore game"). Body {"ignored": true|false}. 404 when no
// such stored game. Superadmin only, like the rebase above.
//
// DELIBERATELY not a rating change: it writes the marker and nothing else (see
// LosDO.setGameExcluded), so scores are recalculated only when the row's other
// action re-runs the fold. `needsRebase` in the response says whether the
// marker and the stored ratings currently disagree.
app.post("/api/games/:id/ignored", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const wanted = (body as { ignored?: unknown } | null)?.ignored;
  if (typeof wanted !== "boolean") return errorResponse(c, 'body must be {"ignored": true|false}', 400);
  const r = await losStub(c.env).setGameExcluded(c.req.param("id"), wanted);
  if (r == null) return errorResponse(c, "no such game", 404);
  console.log(
    `LOS game ${r.id} ${r.excluded ? "ignored" : "un-ignored"}` +
      `${r.changed ? "" : " (no change)"}${r.needsRebase ? "; re-run pending" : ""}`,
  );
  return c.json(r, 200, { "Cache-Control": "no-store" });
});

// Redraw the last 8 days of rank_history from the game log, then re-derive the
// two 7-day change columns from it (LosDO.rebuildRankHistory) — the ranking
// page's "Rebuild history" button, and the repair for the days the once-a-day
// recorder could only approximate or missed entirely. Superadmin only, like the
// rebase and the privacy toggle. Rewinds the stored ratings, never re-runs the
// fold, so it cannot change anybody's LOS.
app.post("/api/rank-history/rebuild", requireAdmin, async (c) => {
  const r = await losStub(c.env).rebuildRankHistory();
  console.log(
    `LOS rank history rebuilt: ${r.days.length} days, ${r.rows} rows, ${r.games} games rewound`,
  );
  return c.json(r, 200, { "Cache-Control": "no-store" });
});

app.post("/api/games", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(c, "body is not valid JSON", 400);
  }
  const parsed = parseUploadBody(body);
  if ("error" in parsed) return errorResponse(c, parsed.error, 400);
  const result = await losStub(c.env).upload(parsed.games);
  return c.json(result);
});

// Hide/unhide one player's profile — the ranking page's admin row menu
// ("Make private" / "Make public"). Body {"private": true|false}. 404 when no
// such rated player. Superadmin only, like the rebase.
app.post("/api/players/:userId/private", requireAdmin, async (c) => {
  const userId = intParam(c.req.param("userId"));
  if (userId == null) return errorResponse(c, "userId must be a number", 400);
  const body = await c.req.json().catch(() => null);
  const wanted = (body as { private?: unknown } | null)?.private;
  if (typeof wanted !== "boolean") return errorResponse(c, "body must be {\"private\": true|false}", 400);
  const result = await losStub(c.env).setPrivateProfile(userId, wanted);
  if (result == null) return errorResponse(c, "no such player", 404);
  return c.json(result, 200, { "Cache-Control": "no-store" });
});

// Destructive: wipes every table for a chronological re-upload. Guarded by an
// explicit confirmation param (?confirm=true) — deliberately unauthenticated
// for now, like the rest of the API.
app.post("/api/reset", async (c) => {
  if (c.req.query("confirm") !== "true") {
    return errorResponse(c, "reset requires ?confirm=true", 400);
  }
  return c.json(await losStub(c.env).reset());
});

// ------------------------------------------------------------------ reads

app.get("/api/ranking", async (c) => {
  const includePrivate = await adminView(c);
  // ?sort= one of RANKING_SORTS, ?dir= asc|desc — both normalized in the DO
  // (an unknown value falls back to the leaderboard rather than 400ing, so a
  // hand-written or stale URL still gets a list). The response echoes what it
  // actually used. The sorted body is a different body under the same 60s edge
  // cache, which the params being part of the URL already keys correctly.
  // Sorting by LOS movement would hand a visitor the hidden numbers' order.
  // A visitor's list is the TIER board, always: tier, then games played. Every
  // other order (LOS, leaderboard position, either 7-day change) is the hidden
  // numbers' order given back, so a visitor's ?sort= only picks the direction.
  const { sort, dir } = parseRankingSort(includePrivate ? c.req.query("sort") : "tier", c.req.query("dir"));
  const result = await losStub(c.env).ranking({
    page: intParam(c.req.query("page")),
    perPage: intParam(c.req.query("perPage")),
    q: c.req.query("q"),
    includePrivate,
    sort,
    dir,
  });
  if (includePrivate) return c.json(result, 200, readCache(c));
  // The leaderboard position's 7-day move is the LOS order's, so it goes too.
  const players = result.players.map((p) => ({ ...p, rankChange7d: null }));
  return c.json(stripLos({ ...result, players }), 200, readCache(c));
});

/**
 * `?replays=true` — annotate what is being served with what barreplay (the
 * sibling replay-playback deployment) has for each game, which is what lets a
 * page decide between a "replay" link, an hourglass and nothing at all (see
 * src/barreplay.ts). The three routes a replay link is drawn from share this,
 * so the flag, the `replay` field and the timing header mean the same thing on
 * all of them.
 *
 * Opt-in rather than always-on for two reasons: it costs an outbound request
 * that the API's other readers (the bot, the tools) have no use for, and the
 * annotated and unannotated bodies then sit under DIFFERENT cache keys, which
 * the shared `Cache-Control` requires.
 *
 * Best-effort by contract (fetchReplayStatuses never throws): a game whose
 * status did not come back carries `replay: null`, which a page reads as "no
 * replay to link to" — the same thing most games genuinely are. How long the
 * lookup took, and what came of it, rides back in `Server-Timing`. A body
 * whose lookup FAILED outright is served `no-store` rather than under the
 * shared cache, so the linkless page is retried on the next load instead of
 * being what the reader sees for the next minute (replayCacheHeaders).
 */
async function replayAnnotated<T>(
  c: Context<{ Bindings: Env }>,
  ids: string[],
  build: (statuses: Record<string, ReplayStatus>) => T,
  cache: Record<string, string> = { "Cache-Control": CACHE_CONTROL },
) {
  const lookup = await fetchReplayStatuses(ids);
  return c.json(build(lookup.statuses), 200, {
    ...replayCacheHeaders(lookup, cache),
    "Server-Timing": replayTiming(lookup),
  });
}

/** A games LISTING, optionally replay-annotated — the two tables (the whole
 * list and one player's games) are drawn from these. */
async function gamesResponse<G extends { id: string }, R extends { games: G[] }>(
  c: Context<{ Bindings: Env }>,
  result: R,
) {
  const cache = readCache(c);
  if (c.req.query("replays") !== "true") {
    return c.json(result, 200, cache);
  }
  return replayAnnotated(c, result.games.map((g) => g.id), (statuses) => ({
    ...result,
    games: result.games.map((g) => ({ ...g, replay: statuses[g.id] ?? null })),
  }), cache);
}

/** ONE game, optionally replay-annotated — the game page's own read, which
 * asks about a single id rather than a page of them. */
async function gameResponse<G extends { id: string }>(c: Context<{ Bindings: Env }>, game: G) {
  const cache = readCache(c);
  if (c.req.query("replays") !== "true") {
    return c.json(game, 200, cache);
  }
  return replayAnnotated(c, [game.id], (statuses) => ({ ...game, replay: statuses[game.id] ?? null }), cache);
}

app.get("/api/games", async (c) => {
  const afterTime = c.req.query("afterTime");
  const afterId = c.req.query("afterId");
  if ((afterTime == null) !== (afterId == null)) {
    return errorResponse(c, "afterTime and afterId must be passed together", 400);
  }
  const page = intParam(c.req.query("page"));
  if (page != null && (afterTime != null || afterId != null)) {
    return errorResponse(c, "page cannot be combined with a keyset cursor", 400);
  }
  const includePrivate = await adminView(c);
  const result = await losStub(c.env).games({
    afterTime,
    afterId,
    page,
    limit: intParam(c.req.query("limit")),
    ratedOnly: c.req.query("rated") === "true",
    includePrivate,
  });
  return gamesResponse(c, view(includePrivate, result));
});

app.get("/api/games/:id", async (c) => {
  const includePrivate = await adminView(c);
  const game = await losStub(c.env).gameDetail(c.req.param("id"), { includePrivate });
  if (game == null) return errorResponse(c, "no such game", 404);
  return gameResponse(c, view(includePrivate, game));
});

/** Cap on one bulk name lookup — a full 8v8 roster plus slack. */
const MAX_LOOKUP_NAMES = 32;

// Bulk exact-name lookup (?names=a,b,c — lobby names carry no commas), for
// resolving a whole lobby roster in one edge-cacheable GET. Keyed by the
// LOWERCASED name; names no rated player currently carries are absent.
function lookupNames(c: Context<{ Bindings: Env }>): string[] | Response {
  const raw = c.req.query("names") ?? "";
  const names = raw
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  if (names.length === 0) return errorResponse(c, "names is required", 400);
  if (names.length > MAX_LOOKUP_NAMES) {
    return errorResponse(c, `too many names (${names.length} > ${MAX_LOOKUP_NAMES})`, 400);
  }
  return names;
}

// The bot's lookup: the real ratings it balances on, behind the bot's Access
// application (src/access.ts botIdentity) since LOS is not public any more.
app.get("/api/bot/players/lookup", async (c) => {
  if (!botAccessConfigured(c.env) && c.env.ADMIN_OPEN !== "true") {
    return c.json({ error: "bot access is not configured" }, 503, { "Cache-Control": "no-store" });
  }
  if ((await botIdentity(c.env, c.req.raw.headers)) === null) {
    return c.json({ error: "bot credential required" }, 401, { "Cache-Control": "no-store" });
  }
  const names = lookupNames(c);
  if (names instanceof Response) return names;
  return c.json(await losStub(c.env).playersByNames(names), 200, { "Cache-Control": "no-store" });
});

app.get("/api/players/lookup", async (c) => {
  const names = lookupNames(c);
  if (names instanceof Response) return names;
  const includePrivate = await adminView(c);
  const result = await losStub(c.env).playersByNames(names);
  return c.json(view(includePrivate, result), 200, readCache(c));
});

// Name search (?q=) — kept on the collection path, distinct from /:userId.
app.get("/api/players", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  if (q.length === 0) return errorResponse(c, "q is required", 400);
  const result = await losStub(c.env).searchPlayers(q);
  return c.json(view(await adminView(c), result), 200, readCache(c));
});

app.get("/api/players/:userId", async (c) => {
  const userId = intParam(c.req.param("userId"));
  if (userId == null) return errorResponse(c, "userId must be a number", 400);
  const includePrivate = await adminView(c);
  const player = await losStub(c.env).player(userId, { includePrivate });
  if (player == null) return errorResponse(c, "no such player", 404);
  if (includePrivate) return c.json(player, 200, readCache(c));
  // No leaderboard position on a visitor's profile: "#N of M" is the LOS order.
  const body = "rank" in player ? { ...player, rank: null, rankedOf: null } : player;
  return c.json(stripLos(body), 200, readCache(c));
});

// One player's games, newest first, numbered pages (?page=N&limit=M) — the
// player page's games table (recentGames on the profile stays the first 20).
// Takes `?replays=true` like the whole-list route: the same table is drawn
// there, so it needs the same annotation.
app.get("/api/players/:userId/games", async (c) => {
  const userId = intParam(c.req.param("userId"));
  if (userId == null) return errorResponse(c, "userId must be a number", 400);
  const includePrivate = await adminView(c);
  const result = await losStub(c.env).playerGames(userId, {
    page: intParam(c.req.query("page")),
    limit: intParam(c.req.query("limit")),
    includePrivate,
  });
  return gamesResponse(c, view(includePrivate, result));
});

app.get("/api/players/:userId/history", async (c) => {
  const userId = intParam(c.req.param("userId"));
  if (userId == null) return errorResponse(c, "userId must be a number", 400);
  const includePrivate = await adminView(c);
  // The history IS the LOS chart: nothing of it is served outside the admin view.
  if (!includePrivate) return c.json({ userId, points: [], losHidden: true }, 200, readCache(c));
  const history = await losStub(c.env).playerHistory(userId, { includePrivate });
  return c.json(history, 200, readCache(c));
});
