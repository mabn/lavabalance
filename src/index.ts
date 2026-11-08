// Worker entry point: a Hono control plane + UI in front of the Durable Objects
// (BotContainer, Dispatcher, TeiserverDO, RatingsDO, LosDO), calling their public
// methods directly over RPC.

import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { buildConfig, enabledSrcModes } from "./config";
import type { SrcMode } from "./config";
import { Dispatcher } from "./dispatcher";
import { fetchScores, parseScoresRequest } from "./rating/lavaScores";
import { ratingsStub } from "./rating/ratingsClient";
import { finalizeLobby, shapeScores, type LosLobby } from "./lobbyView";
import { fetchLosRatings } from "./losRatings";
import { stripLos } from "./los/tiers";
import {
  parseGameEndEvent,
  parseGameStartSnapshot,
  snapshotFresh,
  substituteRoster,
  type GameStartSnapshot,
} from "./gameStart";
import { avoidPairsOf, parseAvoidRequest, validAvoidName, type AvoidEntry } from "./avoids";
import type { TeiserverLobbyPlayer } from "./teiserver";
import { RatingsDO } from "./rating/ratingsDO";
import { lobbiesFromRtsApi, lobbyFromRtsApi, ranksFromRtsApi } from "./rtsapi";
import { TeiserverDO } from "./teiserverDO";
import { losApp } from "./los";
import { LosDO } from "./los/losDO";
import { losStub } from "./los";
import { BotContainer, botContainerStub, type BotContainerStatus, type JoinLobbyResult } from "./botContainer";
import { ALL_LOBBIES_HTML, BOT_HTML, DOES_IT_WORK_HTML, POLLS_HTML, GAME_HTML, GAMES_HTML, LOBBIES_HTML, LOBBY_HTML, LOGIN_HTML, PLAYER_HTML, RANKING_HTML, SCOUTING_HTML, SQL_HTML } from "./ui";
import { authApp } from "./authRoutes";
import { pollApp } from "./pollRoutes";
import { POLLS, findPoll, pollMetaTags } from "./polls";
import { scoutApp } from "./scoutRoutes";
import { scoutLobby, type ScoutCard } from "./scout";
import { accessConfigured, adminRequest, clearedAccessCookie, loginNext } from "./access";
import { adoptLavaLobby, ensureLavaLobbyConfigured } from "./autoLobby";

export { BotContainer, Dispatcher, LosDO, RatingsDO, TeiserverDO };

/** The single Dispatcher instance (persisted runtime config + tracker view). */
const DISPATCHER_NAME = "singleton";
/** The single TeiserverDO instance; holds one logged-in web session. */
const TEISERVER_NAME = "singleton";

function dispatcherStub(env: Env) {
  return env.DISPATCHER.get(env.DISPATCHER.idFromName(DISPATCHER_NAME));
}

function teiserverStub(env: Env) {
  return env.TEISERVER.get(env.TEISERVER.idFromName(TEISERVER_NAME));
}

// Cap on how much of an error message is logged. A relayed upstream error body can be
// arbitrarily large, so we log at most the first 1KB to keep it from flooding the logs.
const MAX_LOGGED_ERROR_LEN = 1024;

// Return a JSON error response, logging its message first. Messages longer than 1KB are
// truncated in the log (the full message is still sent to the client).
function errorResponse(
  c: Context<{ Bindings: Env }>,
  message: string,
  status: ContentfulStatusCode,
  headers?: Record<string, string>,
) {
  const logged =
    message.length > MAX_LOGGED_ERROR_LEN ? message.slice(0, MAX_LOGGED_ERROR_LEN) : message;
  console.error(`error response ${status}: ${logged}`);
  return c.json({ error: message }, status, headers);
}

const app = new Hono<{ Bindings: Env }>();

// ---- Superadmin (Cloudflare Access, src/access.ts) ----
//
// Admin mode is decided HERE, from a verified Access JWT in the
// CF_Authorization cookie (or the control token, or ADMIN_OPEN in dev) — no
// longer from ?admin=true in the URL. The pages learn it from the HTML itself
// (page() below), the admin reads (?includePrivate=true) and writes check it
// per request (isAdmin / requireAdmin).

/** Whether this request carries an admin credential (src/access.ts). */
async function isAdmin(c: Context<{ Bindings: Env }>): Promise<boolean> {
  return (await adminRequest(c.env, c.req.raw)) !== null;
}

/** 401 for a request with no admin credential, naming the login. */
const requireAdmin = async (c: Context<{ Bindings: Env }>, next: Next) => {
  if (!(await isAdmin(c))) {
    const configured = accessConfigured(c.env);
    return c.json(
      {
        error: configured ? "admin sign-in required" : "admin login is not configured on this deployment",
        login: "/admin/login",
        configured,
      },
      401,
      { "Cache-Control": "no-store" },
    );
  }
  await next();
};

/** The marker SHARED_JS reads admin mode from (src/ui.ts ADMIN_MODE). */
const ADMIN_MARKER = "/*ADMIN_MODE*/false";

/**
 * Serve one of the pages, in admin mode when the request is an admin's: the
 * marker in SHARED_JS becomes `true`. Admin copies are never stored anywhere,
 * and every page varies on the cookie that decides it.
 */
async function page(c: Context<{ Bindings: Env }>, html: string, headers: Record<string, string> = {}) {
  if (await isAdmin(c)) {
    return c.html(html.replaceAll(ADMIN_MARKER, "true"), 200, {
      ...headers,
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    });
  }
  return c.html(html, 200, { ...headers, Vary: "Cookie" });
}

// The one path the Access application protects. Reaching this handler on the
// custom domain means Access already authenticated the visitor and set the
// CF_Authorization cookie for the hostname; all that is left is to send them
// back where they came from. Nothing here TRUSTS having been reached (on
// workers.dev no Access rule runs): every admin check verifies the token
// itself. loginNext keeps the destination on this site. Registered before the
// /admin/* control-token middleware below, so it needs no bearer.
app.get("/admin/login", (c) => c.redirect(loginNext(c.req.query("next")), 302));

// Admin sign-out: drop the Access cookie on this hostname and go home.
app.get("/admin/logout", (c) => {
  const secure = new URL(c.req.url).protocol === "https:";
  return new Response(null, {
    status: 302,
    headers: { location: "/", "set-cookie": clearedAccessCookie(secure), "Cache-Control": "no-store" },
  });
});

// Main page: land IN a lobby — redirect to the FIRST open lobby (same source
// resolution and lava filter as /api/lobbies, ?src=/?all= carried through, so the
// URL bar ends up on /lobby/:id). With no open lobby (or a failing source) it
// falls back to serving the list page, whose own fetch shows the empty/error
// state (and offers the all-lobbies picker). Any other lobby opens directly by id
// at /lobby/:id.
//
// When NO lava lobby is configured at all, the page first tries to configure one
// itself: Teiserver's open lobbies whose name contains "lava", the one with the
// most players (src/autoLobby.ts) — throttled to once per 5 minutes via the
// Dispatcher, so a stream of visits with nothing to pick doesn't hammer Teiserver.
app.get("/", async (c) => {
  const resolved = resolveSrc(c);
  if (!("error" in resolved)) {
    const all = c.req.query("all") === "true";
    try {
      const { lava_lobbies } = await ensureLavaLobbyConfigured({
        dispatcher: dispatcherStub(c.env),
        teiserver: teiserverStub(c.env),
      });
      let lobbies: { battleId: number }[] = [];
      if (resolved.src === "proxy") {
        lobbies = await dispatcherStub(c.env).lobbies(all);
      } else if (resolved.src === "teiserver") {
        const result = await teiserverStub(c.env).lobbies(lava_lobbies, all);
        if (result.ok) lobbies = result.lobbies;
      } else {
        lobbies = await lobbiesFromRtsApi(lava_lobbies, all);
      }
      if (lobbies.length > 0) {
        const query = new URL(c.req.url).search;
        return c.redirect(`/lobby/${lobbies[0].battleId}${query}`, 302);
      }
    } catch {
      // fall through to the list page
    }
  }
  return page(c, LOBBIES_HTML);
});

// The all-lobbies picker: every open lobby on Teiserver with at least one player,
// as a table (GET /api/lobbies/all); a row opens /lobby/:id. Linked from the empty
// state of the list page and the "View all lobbies" header button.
app.get("/lobbies", (c) => page(c, ALL_LOBBIES_HTML));

// Detail page for a single lobby: the dense per-team roster view. The page reads the
// :id from its own URL path, polls /api/lobbies, and renders the matching lobby (or a
// "not open" note). Served for any :id — the client resolves whether it exists.
app.get("/lobby/:id", (c) => page(c, LOBBY_HTML));
// LOS pages: the paged leaderboard, and one player's profile/chart/recent games.
// Both are static shells over the LOS API (/api/ranking, /api/players/...).
app.get("/ranking", (c) => page(c, RANKING_HTML));
app.get("/player/:userId", (c) => page(c, PLAYER_HTML));
// Games pages: the paged games table and one game's detail (both over /api/games).
app.get("/games", (c) => page(c, GAMES_HTML));
app.get("/scouting", (c) => page(c, SCOUTING_HTML));
// Polls (src/polls.ts): /polls shows the newest poll, /polls/:slug any one.
// The page reads the slug from its URL; the API is pollApp.
app.get("/polls", (c) => c.redirect(`/polls/${POLLS[0].slug}`, 302));
// Served with the poll's link-preview tags (Open Graph) in <head>, so a pasted
// link unfurls in Discord as the poll; the page's own <title> gives way to it.
app.get("/polls/:slug", (c) => {
  const poll = findPoll(c.req.param("slug"));
  if (!poll) return page(c, POLLS_HTML);
  const html = POLLS_HTML.replace(
    "<!--POLL_META--><title>lavabalance · polls</title>",
    pollMetaTags(poll, new URL(c.req.url).origin),
  );
  return page(c, html);
});
app.route("/", pollApp);
// The balance report for players ("Does it work?"), framed from public/reports/.
app.get("/does-it-work", (c) => page(c, DOES_IT_WORK_HTML));
app.get("/game/:id", (c) => page(c, GAME_HTML));
// Website login with a BAR account (src/auth.ts): the steps, and — opened from
// the link the bot whispers — the "Continue as" button. The API is authApp.
app.get("/login", (c) => page(c, LOGIN_HTML, { "Cache-Control": "no-store" }));
app.route("/", authApp);
// OneTrickLava scouting cards (src/scoutRoutes.ts): the push from OTL and the reads.
app.route("/", scoutApp);
app.get("/health", (c) => c.json({ service: "lavabalance", ok: true }));

// Data backing the main page: per-lobby status + players. Public (like the page).
//
// `?src=` selects the data source. The set of enabled sources — and which one is the
// default when `?src=` is omitted (the first listed) — comes from the `SRC_MODES` var
// (see src/config.ts enabledSrcModes), so a deployment can turn individual sources off
// without a code change. All consult the Dispatcher only for the lava lobby id list
// (getConfig) — except `proxy`, which IS the Dispatcher view — and map into the same shape:
//   • `teiserver` — delegated to the TeiserverDO, which holds a logged-in session to
//                  Teiserver's web UI and scrapes the lobby pages (see src/teiserver.ts).
//   • `proxy`    — the Dispatcher DO's own view, rebuilt from the proxied protocol stream.
//   • `rtsapi`   — the Worker fetches the public BAR battle list from api.bar-rts.com
//                  (see src/rtsapi.ts; gaps: no allyteam/sync/bosses).
// A disabled or unknown `src` → 400; an alternate's upstream/login failure → 502.
//
// Resolve `?src=` against the enabled modes. Returns the chosen mode (the default when
// omitted), or an error Response when it names a disabled/unknown mode.
function resolveSrc(
  c: Context<{ Bindings: Env }>,
): { src: SrcMode } | { error: Response } {
  const { modes, defaultMode } = enabledSrcModes(c.env);
  const src = c.req.query("src") ?? defaultMode;
  if (!modes.includes(src as SrcMode)) {
    return {
      error: errorResponse(
        c,
        `unsupported src '${src}' (enabled: ${modes.join(", ")})`,
        400,
      ),
    };
  }
  // The includes() check above confirms `src` is an enabled SrcMode at runtime.
  return { src: src as SrcMode };
}

app.get("/api/lobbies", async (c) => {
  const resolved = resolveSrc(c);
  if ("error" in resolved) return resolved.error;
  const { src } = resolved;
  // `?all=true` returns every open battle, not just the configured lava_lobbies.
  const all = c.req.query("all") === "true";
  if (src === "proxy") {
    return c.json(await dispatcherStub(c.env).lobbies(all));
  }
  const { lava_lobbies } = await dispatcherStub(c.env).getConfig();

  if (src === "teiserver") {
    // The DO returns a discriminated result instead of throwing: a login/scrape failure
    // comes back as {ok:false, error} (the error names the failing upstream request) so we
    // relay it as a 502 here without a rejection crossing the RPC boundary (which would log
    // a misleading "Uncaught (in promise)"). An unexpected throw still falls through to 502.
    try {
      const result = await teiserverStub(c.env).lobbies(lava_lobbies, all);
      if (!result.ok) return errorResponse(c, result.error, 502);
      return c.json(result.lobbies);
    } catch (e) {
      return errorResponse(
        c,
        e instanceof Error ? e.message : "failed to fetch teiserver lobbies",
        502,
      );
    }
  }

  // src === "rtsapi": the Worker fetches the public battle list and maps it (no ratings
  // for the list — see the detail endpoint below).
  try {
    return c.json(await lobbiesFromRtsApi(lava_lobbies, all));
  } catch (e) {
    return errorResponse(
      c,
      e instanceof Error ? e.message : "failed to fetch rtsapi battles",
      502,
    );
  }
});

// Single-lobby detail for the /lobby/:id page. Unlike /api/lobbies (the list), this DOES
// resolve ratings — LOS, from the lavaos Worker (one bulk lookup bounded by the one
// lobby's roster; see src/losRatings.ts) — and attaches the per-team aggregates + win
// probability via finalizeLobby. Returns the lobby object, or `null` when the id isn't
// currently an open lobby. Same `?src=`/`?all=true` as the list; disabled/unknown `src`
// → 400, invalid id → 400, upstream/login failure → 502 (a LOS lookup failure only
// degrades the roster to unrated — it never 502s the view).
// Every open lobby on Teiserver (the /battle/lobbies index — no per-lobby roster
// scrape, so it's one cheap request) with at least one player, most players first.
// Backs the /lobbies picker page. Always the Teiserver index whatever SRC_MODES says:
// it is the server's own lobby list, not one of the lava-filtered views. Registered
// before /api/lobbies/:id so "all" isn't taken for an id. Login/upstream failure → 502.
app.get("/api/lobbies/all", async (c) => {
  try {
    const result = await teiserverStub(c.env).lobbyIndex();
    if (!result.ok) return errorResponse(c, result.error, 502);
    // Lava lobbies first (the picker's reason to exist), then most players first.
    const isLava = (l: { name: string }) => l.name.toLowerCase().includes("lava");
    const lobbies = result.lobbies
      .filter((l) => l.playerCount >= 1)
      .sort(
        (a, b) =>
          Number(isLava(b)) - Number(isLava(a)) || b.playerCount - a.playerCount || a.id - b.id,
      );
    return c.json(lobbies);
  } catch (e) {
    return errorResponse(
      c,
      e instanceof Error ? e.message : "failed to fetch teiserver lobbies",
      502,
    );
  }
});

app.get("/api/lobbies/:id", async (c) => {
  const resolved = resolveSrc(c);
  if ("error" in resolved) return resolved.error;
  const { src } = resolved;
  // An explicit id is an explicit ask: the detail endpoint serves ANY open battle
  // (the configured-lava filter applies to the LIST only), so /lobby/1627 works
  // for whatever lobby 1627 is. Sources treat this as their all=true mode.
  const all = true;
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return errorResponse(c, "invalid lobby id", 400);
  const view = async <
    L extends LosLobby & {
      battleId: number;
      title: string;
      inProgress: boolean;
      map?: string | null;
      players: TeiserverLobbyPlayer[];
    },
  >(lobby: L | null) => {
    if (!lobby) return null;
    // Side effect: viewing a "lava" lobby makes it THE configured lava lobby (the one
    // GET / lands in) — unless the currently configured one is still open with players
    // (src/autoLobby.ts adoptLavaLobby). Runs after the response, never delays it.
    // Always counts the LIVE roster: it reasons about the open lobby, not the match.
    c.executionCtx.waitUntil(
      adoptLavaLobby(
        { dispatcher: dispatcherStub(c.env), teiserver: teiserverStub(c.env) },
        { id: lobby.battleId, title: lobby.title, playerCount: lobby.players.filter((p) => !p.spectator).length },
      ),
    );
    // The bot-uploaded game-start roster (src/gameStart.ts): while the game runs,
    // the launch roster is served in place of the live one — the lobby keeps
    // changing during a game and stops matching who is playing. `?roster=live`
    // is the page's toggle back to the live view. A lookup failure degrades to
    // live, like a LOS failure degrades to unrated.
    const wantLive = c.req.query("roster") === "live";
    let snap: GameStartSnapshot | null = null;
    try {
      snap = await losStub(c.env).getGameStart(lobby.battleId);
    } catch (e) {
      console.warn(
        `game-start lookup failed (serving live roster): ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
    const fresh = snap !== null && snapshotFresh(snap, lobby.inProgress, Date.now());
    let players =
      fresh && !wantLive && snap ? substituteRoster(snap, lobby.players) : lobby.players;
    // The bot knows a player's account rank (the chevron) only from a CLIENTSTATUS
    // line, and for some players it never gets one; bar-rts has every player's.
    // Only consulted when there is a gap; a failure leaves the gap.
    if (players.some((p) => p.rank == null)) {
      try {
        const ranks = await ranksFromRtsApi(lobby.battleId);
        players = players.map((p) =>
          p.rank != null ? p : { ...p, rank: ranks.get(p.name.toLowerCase()) ?? null },
        );
      } catch (e) {
        console.warn(`rank fill-in failed: ` + (e instanceof Error ? e.message : String(e)));
      }
    }
    const names = players.filter((p) => !p.spectator).map((p) => p.name);
    // ?includePrivate=true asks for the admin view, as everywhere else (the page
    // sends it in admin mode); it is granted only to a verified admin.
    const admin = c.req.query("includePrivate") === "true" && (await isAdmin(c));
    const finalized = finalizeLobby({ ...lobby, players }, await fetchLosRatings(c.env, names), {
      includePrivate: admin,
    });
    // Who in this roster is avoiding whom (src/avoids.ts) — ADMIN VIEW ONLY. An
    // avoid list is between the player and the bot; it is not part of the lobby
    // everyone reads, so the public response carries no trace of one. A lookup
    // failure degrades to "no avoids", like a LOS failure degrades to unrated.
    let avoids: AvoidEntry[] = [];
    if (admin) {
      try {
        avoids = (await losStub(c.env).avoidsFor(names)).entries;
      } catch (e) {
        console.warn(
          `avoid lookup failed (serving the lobby without them): ` +
            (e instanceof Error ? e.message : String(e)),
        );
      }
    }
    // OneTrickLava's play-style cards for this roster (src/scout.ts): a badge
    // strip per player plus the lobby's scouting report — the lane forecast
    // and each team's threats. Private LOS profiles get no card unless an admin
    // asks. A lookup failure degrades to "no scouting", like everything else
    // layered on here.
    let cards: ScoutCard[] = [];
    try {
      const ids = finalized.players
        .filter((p) => !p.spectator && p.losUserId != null)
        .map((p) => p.losUserId as number);
      cards = (await losStub(c.env).scoutCards(ids, names, { includePrivate: admin })).cards;
    } catch (e) {
      console.warn(
        `scouting lookup failed (serving the lobby without it): ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
    const scouted = scoutLobby(finalized.players, cards, lobby.map);
    const body = {
      ...finalized,
      players: scouted.players,
      scouting: scouted.scouting,
      avoids,
      // Which roster the body carries; `botRoster` is set on BOTH views while a
      // fresh snapshot exists, so the live view can still render the toggle.
      rosterSource: fresh ? (wantLive ? "live" : "bot") : "live",
      botRoster:
        fresh && snap
          ? { gameStartAt: snap.startedAt, botBalanced: snap.botBalanced }
          : null,
    };
    // LOS is admin-only: a visitor gets the rank tiers and the win chance.
    return admin ? body : stripLos(body);
  };

  if (src === "proxy") {
    return c.json(await view(await dispatcherStub(c.env).lobby(id, all)));
  }
  const { lava_lobbies } = await dispatcherStub(c.env).getConfig();

  if (src === "teiserver") {
    try {
      const result = await teiserverStub(c.env).lobby(id, lava_lobbies, all);
      if (!result.ok) return errorResponse(c, result.error, 502);
      return c.json(await view(result.lobby));
    } catch (e) {
      return errorResponse(
        c,
        e instanceof Error ? e.message : "failed to fetch teiserver lobby",
        502,
      );
    }
  }

  // src === "rtsapi"
  try {
    return c.json(await view(await lobbyFromRtsApi(id, lava_lobbies, all)));
  } catch (e) {
    return errorResponse(
      c,
      e instanceof Error ? e.message : "failed to fetch rtsapi battle",
      502,
    );
  }
});

// Bulk Lavabar elos for the "📊 Fetch scores" button. Body `{"names": ["huk123", …]}` (a
// bare array works too) → `{scores: {<lowercased name>: <public record> | {"hidden": true}},
// unknown: [...], cached: bool}`.
//
// THE TWO-COLUMN MODEL: the per-name search-page scrape populates the `rating` column (the
// player's PUBLIC rating — the only displayable value), while this route's upstream — the
// balance endpoint, relayed because it sends no Access-Control-Allow-Origin — populates ONLY
// `rating_hidden`. A player the balance endpoint rates but the public site doesn't is hidden
// BY DATA: their elo feeds teamStats / win chance / elo swing but is only sent with
// `?show_hidden_score=true`. Names are trimmed, de-duplicated and capped at 16 server-side.
app.post("/api/scores", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(c, "invalid JSON body", 400);
  }
  let names: string[];
  try {
    names = parseScoresRequest(body);
  } catch (e) {
    return errorResponse(c, e instanceof Error ? e.message : "invalid player list", 400);
  }

  const ratings = ratingsStub(c.env);
  const showHidden = c.req.query("show_hidden_score") === "true";
  try {
    // The button is an explicit user action on a bounded roster (max 16 names), so it ALWAYS
    // asks the balance endpoint — no cache-freshness dance, no state that can go stale or get
    // poisoned. The elos land in the rating_hidden column; get() then serves the merged
    // two-column view (and schedules the public-side scrape for names it hasn't seen).
    const { elos, unknown } = await fetchScores(names);
    await ratings.putScores(elos);
    const stored = await ratings.get(names);
    return c.json({ scores: shapeScores(stored, showHidden), unknown, cached: false });
  } catch (e) {
    // Upstream down: serve whatever the cache holds rather than failing the button outright.
    const stored = await ratings.get(names);
    if (Object.keys(stored).length) {
      console.warn(
        `lavabar balance fetch failed, serving ${Object.keys(stored).length} cached: ` +
          (e instanceof Error ? e.message : String(e)),
      );
      return c.json({
        scores: shapeScores(stored, showHidden),
        unknown: [],
        cached: true,
        stale: true,
      });
    }
    return errorResponse(
      c,
      e instanceof Error ? e.message : "failed to fetch lavabar scores",
      502,
    );
  }
});

// The bot's game-start roster upload (src/gameStart.ts): the container bot POSTs
// the tracked roster the moment it observes the founder's in-game bit go up, and
// a game-end notice when the match is over. Stored per battle id in the LosDO's
// lobby_states table; /api/lobbies/:id serves it in place of the live roster
// while the game runs. Open endpoints for now (auth deferred, like the LOS API);
// the strict payload validators are the only gate.
app.post("/api/gamestart", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(c, "invalid JSON body", 400);
  }
  let snap;
  try {
    snap = parseGameStartSnapshot(body);
  } catch (e) {
    return errorResponse(c, e instanceof Error ? e.message : "invalid game-start payload", 400);
  }
  return c.json(await losStub(c.env).putGameStart(snap));
});

app.post("/api/gameend", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(c, "invalid JSON body", 400);
  }
  try {
    const ev = parseGameEndEvent(body);
    return c.json(await losStub(c.env).clearGameStart(ev.battleId));
  } catch (e) {
    return errorResponse(c, e instanceof Error ? e.message : "invalid game-end payload", 400);
  }
});

// Auth for the control plane (only enforced if CONTROL_TOKEN is set): the
// bearer token, or a superadmin signed in with Access (src/access.ts), so the
// Bot page works from the Access cookie alone.
const requireControlToken = async (c: Context<{ Bindings: Env }>, next: Next) => {
  const { controlToken } = buildConfig(c.env);
  if (controlToken && !(await isAdmin(c))) return errorResponse(c, "unauthorized", 401);
  await next();
};
// The bot admin page (admin-only, like /sql: the sidebar entry and the page's
// content show only in admin mode, i.e. to a superadmin signed in with Access).
// The PAGE is public — registered before the /bot/* auth middleware so serving
// the HTML never needs a credential — while everything it calls (GET
// /bot/status, POST /bot/start|stop below) stays behind requireControlToken:
// the Access cookie, or the bearer token from the page's token field.
app.get("/bot", (c) => page(c, BOT_HTML));

app.use("/battles/*", requireControlToken);
app.use("/admin/*", requireControlToken);
app.use("/bot/*", requireControlToken);

// --- Avoid lists (src/avoids.ts) ---
//
// "Don't put me on the same team as X": one row per request, stored in the
// LosDO, written ONLY through the bot's .avoid/.avoidremove whispers
// — the lobby session is what proves who is asking, which no HTTP caller can.
// Hence the control token (when CONTROL_TOKEN is set; the bot gets it as
// BOT_CONTROL_TOKEN): unlike the open /api/gamestart upload, a forged write
// here edits somebody else's list in their name. The lobby page does NOT read
// these routes — its admin view gets the roster's entries from
// /api/lobbies/:id, alongside everything else it draws.
app.use("/api/avoids/*", requireControlToken);

/** Longest roster one /api/avoids/pairs lookup accepts (a 16v16 plus spectators). */
const MAX_AVOID_LOOKUP_NAMES = 64;

// One player's own list: `{owner, entries, limit}`. Backs the bot's `.avoid`.
app.get("/api/avoids/list", async (c) => {
  const player = c.req.query("player") ?? "";
  if (!validAvoidName(player)) return errorResponse(c, "player must be a lobby account name", 400);
  return c.json(await losStub(c.env).listAvoids(player), 200, { "Cache-Control": "no-store" });
});

// The avoid constraints for a roster: every stored entry touching one of these
// names, plus `pairs` — the ones BOTH of whose people are in it, which is all
// the balancer can act on. What the bot asks for before every .balance.
app.get("/api/avoids/pairs", async (c) => {
  const names = (c.req.query("names") ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  if (names.length === 0) return errorResponse(c, "names is required", 400);
  if (names.length > MAX_AVOID_LOOKUP_NAMES) {
    return errorResponse(c, `too many names (${names.length} > ${MAX_AVOID_LOOKUP_NAMES})`, 400);
  }
  const { entries } = await losStub(c.env).avoidsFor(names);
  return c.json({ entries, pairs: avoidPairsOf(entries, names) }, 200, {
    "Cache-Control": "no-store",
  });
});

// Add an entry. Body {"player": "<asker>", "avoid": "<name>"}. The refusals are
// values, not errors — the bot words each one — but they carry a matching
// status: 404 when the ranking has no such player (with near misses), 409 for
// a duplicate, the 10-per-player limit, or naming yourself.
app.post("/api/avoids/add", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(c, "invalid JSON body", 400);
  }
  let req: { player: string; avoid: string };
  try {
    req = parseAvoidRequest(body);
  } catch (e) {
    return errorResponse(c, e instanceof Error ? e.message : "invalid avoid payload", 400);
  }
  const result = await losStub(c.env).addAvoid(req.player, req.avoid);
  const status = result.ok ? 200 : result.reason === "unknown-player" ? 404 : 409;
  return c.json(result, status, { "Cache-Control": "no-store" });
});

// Wipe every list. `?confirm=true` like /api/reset, and separate from it on
// purpose: the LOS reset rebuilds the fold from the uploads, while an avoid
// list is something a person typed and no upload can restore.
app.post("/api/avoids/reset", async (c) => {
  if (c.req.query("confirm") !== "true") {
    return errorResponse(c, "refusing to clear every avoid list without ?confirm=true", 400);
  }
  return c.json(await losStub(c.env).clearAvoids(), 200, { "Cache-Control": "no-store" });
});

// Drop an entry. Same body; removing something that was never there is a 200
// with `removed: false` — the bot says "not on your list" and nothing broke.
app.post("/api/avoids/remove", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(c, "invalid JSON body", 400);
  }
  let req: { player: string; avoid: string };
  try {
    req = parseAvoidRequest(body);
  } catch (e) {
    return errorResponse(c, e instanceof Error ? e.message : "invalid avoid payload", 400);
  }
  return c.json(await losStub(c.env).removeAvoid(req.player, req.avoid), 200, {
    "Cache-Control": "no-store",
  });
});

// The bot: src/bot/bot.ts in a Cloudflare Container supervised by the BotContainer
// DO (src/botContainer.ts). `start` persists the intent and boots the container;
// the cron trigger (`scheduled` below) restarts it after platform restarts until
// `stop`. `status` = persisted intent + the instance's actual state.
// `start` answers 503 (with the same status body) when the container did not come
// up — e.g. the bot died on a DENIED login; `lastError` says why.
app.post("/bot/start", async (c) => {
  const status: BotContainerStatus = await botContainerStub(c.env).startBot();
  const up = status.status === "running" || status.status === "healthy";
  return c.json(status, up ? 200 : 503);
});
// Restart: stop the current instance (if any), wait for it to exit, start
// fresh. What the post-deploy kick uses — /bot/start no-ops while the
// PRE-rollout instance is still up, so kicking with it raced the image
// rollout and left the bot down until the cron (see BotContainer.restartBot).
app.post("/bot/restart", async (c) => {
  const status: BotContainerStatus = await botContainerStub(c.env).restartBot();
  const up = status.status === "running" || status.status === "healthy";
  return c.json(status, up ? 200 : 503);
});
app.post("/bot/stop", async (c) => c.json(await botContainerStub(c.env).stopBot()));
app.get("/bot/status", async (c) => c.json(await botContainerStub(c.env).botStatus()));

// Make the bot join a battle — the HTTP twin of the .join admin whisper. Body
// {"battle": <id>}, or an empty/id-less body to join the current MAIN lobby (the
// configured lava lobby, auto-picking one via the same throttled Teiserver lookup
// as GET / when nothing is configured). The join is async on the lobby protocol:
// a 200 means the bot accepted the request (JOINBATTLE sent, or it is already in
// that battle); the outcome lands in /bot/status's bot.battle / bot.pendingBattle.
// 400 = bad body; 409 = no main lobby resolvable; 502 = container down or the bot
// refused (e.g. not connected) — `error` says why, `status` is the fresh view.
app.post("/bot/join", async (c) => {
  let battle: number | null = null;
  const raw = await c.req.text();
  if (raw.trim()) {
    let parsed: { battle?: unknown };
    try {
      parsed = JSON.parse(raw) as { battle?: unknown };
    } catch {
      return errorResponse(c, "invalid JSON body", 400);
    }
    if (parsed.battle != null && parsed.battle !== "") {
      battle = Number(parsed.battle);
      if (!Number.isInteger(battle) || battle < 0) {
        return errorResponse(c, "battle must be a non-negative integer battle id", 400);
      }
    }
  }
  if (battle == null) {
    const { lava_lobbies } = await ensureLavaLobbyConfigured({
      dispatcher: dispatcherStub(c.env),
      teiserver: teiserverStub(c.env),
    });
    if (lava_lobbies.length === 0) {
      return errorResponse(c, "no main lava lobby is configured (and none could be auto-picked)", 409);
    }
    battle = lava_lobbies[0]!;
  }
  const result: JoinLobbyResult = await botContainerStub(c.env).joinLobby(battle);
  return c.json({ battle, ...result }, result.ok ? 200 : 502);
});

// Runtime configuration, persisted in the Dispatcher DO.
app.get("/admin/config", async (c) => c.json(await dispatcherStub(c.env).getConfig()));

// Set the runtime config. Body: a JSON object, e.g. {"lava_lobbies": [123, 456]}.
app.post("/admin/config", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(c, "invalid JSON body", 400);
  }
  try {
    const config = await dispatcherStub(c.env).setConfig(body);
    return c.json({ ok: true, config });
  } catch (e) {
    return errorResponse(c, e instanceof Error ? e.message : "invalid config", 400);
  }
});

// SQL cost accounting (admin-only — the /sql page, in the sidebar in admin
// mode; the route is behind requireAdmin): what each method of the two SQLite-backed Durable
// Objects (RatingsDO, LosDO) has cost in SQLite rows since its instance started.
// The tally is IN MEMORY only (src/sqlStats.ts: persisting a measurement of the
// write budget would spend it), so each DO's window is its own instance lifetime
// and each report carries its own `since`. Superadmin only, like barreplay's
// /api/admin/sqlstats.
app.get("/api/sqlstats", requireAdmin, async (c) => {
  const [ratings, los] = await Promise.all([
    ratingsStub(c.env).sqlStatsReport(),
    losStub(c.env).sqlStatsReport(),
  ]);
  return c.json({
    dos: [
      { name: "RatingsDO", description: "Lavabar rating cache", ...ratings },
      { name: "LosDO", description: "LOS store", ...los },
    ],
  });
});

// The SQL stats page. The route serves the page to anyone; the page itself only
// shows the tables in admin mode (the sidebar entry is hidden otherwise).
app.get("/sql", (c) => page(c, SQL_HTML));

// The LOS public API (src/los/index.ts): /api/games, /api/ranking, /api/players[…],
// /api/reset — historically its own "lavaos" Worker, now mounted here. Paths are
// disjoint from the lobby API above, so the public URLs are unchanged.
app.route("/", losApp);

app.get("/battles/:battle/status", async (c) =>
  c.json(await dispatcherStub(c.env).status(c.req.param("battle"))),
);

// In-memory protocol message log observed for a battle, most-recent-first.
// `?limit=N` (default 100, max 1000).
app.get("/battles/:battle/log", async (c) => {
  const limit = Number(c.req.query("limit"));
  return c.json(
    await dispatcherStub(c.env).log(
      c.req.param("battle"),
      Number.isFinite(limit) ? limit : undefined,
    ),
  );
});

export default {
  fetch: app.fetch,
  // Cron (cloudflare.config.ts `triggers.scheduled`): keep the bot container up. A no-op
  // unless /bot/start persisted the intent to run.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(botContainerStub(env).ensureRunning());
  },
} satisfies ExportedHandler<Env>;
