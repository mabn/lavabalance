// The scouting routes, /api/scout/* (the cards and what is built from them
// are described in src/scout.ts). Mounted into the main Hono app by
// src/index.ts; the lobby view reads the same store over RPC, not through
// these routes.
//
// Two kinds of caller:
//   • onetricklava, PUSHING cards (POST /api/scout/profiles). A forged push
//     would put words in players' mouths ("Comm bomber") on every lobby page,
//     so it takes a Cloudflare Access SERVICE TOKEN: a dedicated Access
//     application protects this one path with a Service Auth policy, OTL sends
//     CF-Access-Client-Id/-Secret, Access swaps them for a JWT, and
//     src/access.ts scoutIdentity verifies it against ACCESS_SCOUT_AUD (no
//     shared secret in the Worker at all). An admin credential (the control
//     token, an Access session, ADMIN_OPEN in dev) may push too, for manual
//     backfills. Without ACCESS_SCOUT_AUD only an admin can: FAILS CLOSED.
//   • everyone else, READING (the player page, the Scouting page, the bot's
//     `.scout`). Public and edge-cacheable, private LOS profiles filtered out
//     unless an admin asks for ?includePrivate=true.

import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { adminRequest, scoutAccessConfigured, scoutIdentity } from "./access";
import { losStub } from "./los";
import { parseScoutUpload } from "./scout";

type C = Context<{ Bindings: Env }>;

/** Cards change when OTL pushes (minutes apart), so reads cache briefly at the edge. */
const CACHE = { "Cache-Control": "public, max-age=120" };
const NO_STORE = { "Cache-Control": "no-store" };

/** Most names/ids one bulk read resolves (a 16v16 plus spectators). */
const MAX_LOOKUP = 64;

function errorResponse(c: C, message: string, status: ContentfulStatusCode) {
  console.error(`error response ${status}: ${message}`);
  return c.json({ error: message }, status, NO_STORE);
}

/** May this request push cards? OTL's Access service token, or any admin credential. */
async function mayPush(c: C): Promise<boolean> {
  if ((await scoutIdentity(c.env, c.req.raw.headers)) !== null) return true;
  return (await adminRequest(c.env, c.req.raw)) !== null;
}

/** ?includePrivate=true from a verified admin (as on the LOS reads). */
async function adminView(c: C): Promise<boolean> {
  return c.req.query("includePrivate") === "true" && (await adminRequest(c.env, c.req.raw)) !== null;
}

function readHeaders(c: C): Record<string, string> {
  return c.req.query("includePrivate") === "true" ? NO_STORE : CACHE;
}

function csv(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const scoutApp = new Hono<{ Bindings: Env }>();

// One push from onetricklava: `{profiles: [...], remove?: [ids], generatedAt?}`.
// Answers what it did: `{stored, unchanged, removed, total, skipped}`.
scoutApp.post("/api/scout/profiles", async (c) => {
  if (!(await mayPush(c))) {
    // Name the missing setup rather than a bare 401, like the bot's routes do.
    if (!scoutAccessConfigured(c.env)) {
      return errorResponse(c, "scouting push is disabled: ACCESS_TEAM_DOMAIN / ACCESS_SCOUT_AUD are not set", 503);
    }
    return errorResponse(c, "unauthorized", 401);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(c, "body must be JSON", 400);
  }
  let upload;
  try {
    upload = parseScoutUpload(body);
  } catch (e) {
    return errorResponse(c, e instanceof Error ? e.message : "invalid scout payload", 400);
  }
  const result = await losStub(c.env).putScout(upload);
  return c.json({ ...result, skipped: upload.skipped }, 200, NO_STORE);
});

// Drop every card. Admin only (the push token cannot wipe what it pushes).
scoutApp.post("/api/scout/reset", async (c) => {
  if ((await adminRequest(c.env, c.req.raw)) === null) return errorResponse(c, "admin sign-in required", 401);
  if (c.req.query("confirm") !== "true") {
    return errorResponse(c, "refusing to clear every scouting card without ?confirm=true", 400);
  }
  return c.json(await losStub(c.env).clearScout(), 200, NO_STORE);
});

// Bulk read for a roster: `?names=a,b` and/or `?ids=1,2` → `{cards: [...]}`.
// What the bot's `.scout` asks; ids win over names (a name can change hands).
scoutApp.get("/api/scout", async (c) => {
  const names = csv(c.req.query("names"));
  const ids = csv(c.req.query("ids")).map(Number);
  if (names.length + ids.length === 0) return errorResponse(c, "pass ?names=a,b or ?ids=1,2", 400);
  if (names.length + ids.length > MAX_LOOKUP) return errorResponse(c, `at most ${MAX_LOOKUP} names/ids`, 400);
  if (ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) return errorResponse(c, "ids must be account ids", 400);
  const out = await losStub(c.env).scoutCards(ids, names, { includePrivate: await adminView(c) });
  return c.json(out, 200, readHeaders(c));
});

// The Scouting page: watch list + lane kings, and when OTL last pushed.
scoutApp.get("/api/scout/boards", async (c) => {
  const keep = Number(c.req.query("limit") ?? 20);
  const out = await losStub(c.env).readScoutBoards({
    includePrivate: await adminView(c),
    keep: Number.isFinite(keep) ? keep : 20,
  });
  return c.json(out, 200, readHeaders(c));
});

// One player's card (the player page). 404 = OTL has no card for them;
// a private LOS profile answers `{private: true}` to a visitor.
scoutApp.get("/api/scout/:userId", async (c) => {
  const userId = Number(c.req.param("userId"));
  if (!Number.isSafeInteger(userId) || userId <= 0) return errorResponse(c, "invalid account id", 400);
  const out = await losStub(c.env).scoutCard(userId, { includePrivate: await adminView(c) });
  if (out == null) return c.json({ error: "no scouting card for this player" }, 404, readHeaders(c));
  return c.json(out, 200, readHeaders(c));
});
