// The website-login routes, /api/auth/* (the flow is described in src/auth.ts).
// Mounted into the main Hono app by src/index.ts; GET /login (the page) is
// registered there with the other pages.
//
// Two kinds of caller:
//   • the bot (POST /api/bot/auth/issue, /api/bot/auth/revoke) — it vouches
//     for who whispered it, so these REQUIRE a valid Cloudflare Access token
//     for the bot application (src/access.ts botIdentity: the bot's service
//     token, swapped by Access for a JWT with audience ACCESS_BOT_AUD) and fail
//     closed when that is not configured: an open issue route would let anybody
//     log in as anybody;
//   • the browser (link, redeem, me, logout) — cookie-based, and every POST
//     refuses a foreign Origin (src/auth.ts sameOrigin).
//
// State lives in the singleton LosDO (auth_links / auth_sessions); only token
// hashes cross the RPC boundary.

import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  LOGIN_LINK_TTL_MS,
  SESSION_TTL_MS,
  clearedSessionCookie,
  devLoginEnabled,
  hashToken,
  newToken,
  parseIssueRequest,
  sameOrigin,
  sessionCookie,
  sessionTokenFrom,
  validToken,
  type AuthUser,
} from "./auth";
import { botAccessConfigured, botIdentity } from "./access";
import { losStub } from "./los";

type C = Context<{ Bindings: Env }>;

const NO_STORE = { "Cache-Control": "no-store" };

export const authApp = new Hono<{ Bindings: Env }>();

function fail(c: C, message: string, status: ContentfulStatusCode) {
  return c.json({ error: message }, status, NO_STORE);
}

/**
 * The bot's routes: a valid Access token for the bot application, mandatory.
 * 503 when the deployment has no bot Access configured (login is then off),
 * 401 for a missing or invalid token.
 */
async function botAuthError(c: C) {
  if (c.env.ADMIN_OPEN !== "true" && !botAccessConfigured(c.env)) {
    return fail(c, "login is disabled: ACCESS_TEAM_DOMAIN / ACCESS_BOT_AUD are not set", 503);
  }
  if (!(await botIdentity(c.env, c.req.raw.headers))) return fail(c, "unauthorized", 401);
  return null;
}

/** The logged-in user of this request, or null. */
export async function currentUser(c: C): Promise<AuthUser | null> {
  const token = sessionTokenFrom(c.req.header("cookie"));
  if (!token) return null;
  return losStub(c.env).sessionUser(await hashToken(token));
}

// The bot asks for a login link for whoever whispered `.login`. Body
// {name, userId} (userId = the Teiserver account id from ADDUSER). Answers the
// full link on THIS host, so the bot needs no URL config of its own.
authApp.post("/api/bot/auth/issue", async (c) => {
  const denied = await botAuthError(c);
  if (denied) return denied;
  let user: AuthUser;
  try {
    user = parseIssueRequest(await c.req.json());
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "invalid JSON body", 400);
  }
  const token = newToken();
  const expiresAt = Date.now() + LOGIN_LINK_TTL_MS;
  await losStub(c.env).createLoginLink(await hashToken(token), user, expiresAt);
  const url = `${new URL(c.req.url).origin}/login?t=${token}`;
  console.log(`auth: login link issued for ${user.name} (${user.userId})`);
  return c.json({ url, expiresAt, name: user.name }, 200, NO_STORE);
});

// The bot's `.logout`: end every session (and pending link) of the whisperer's
// account. Body {userId}.
authApp.post("/api/bot/auth/revoke", async (c) => {
  const denied = await botAuthError(c);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => null)) as { userId?: unknown } | null;
  const userId = body?.userId;
  if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0) {
    return fail(c, "userId must be a positive integer", 400);
  }
  const ended = await losStub(c.env).deleteUserSessions(userId);
  console.log(`auth: ${ended} session(s) revoked for user ${userId}`);
  return c.json({ ended }, 200, NO_STORE);
});

// Who a link is for — what the login page shows on its "Continue as" button.
// Does NOT use the link up: chat clients and browsers prefetch links, and a GET
// that logged in (or burnt the link) would hand that to the prefetcher.
authApp.get("/api/auth/link", async (c) => {
  const t = c.req.query("t");
  if (!validToken(t)) return fail(c, "invalid login link", 400);
  const user = await losStub(c.env).peekLoginLink(await hashToken(t));
  if (!user) return fail(c, "this login link has expired or was already used", 404);
  return c.json({ user }, 200, NO_STORE);
});

// The button: trade the link for a session cookie. Body {token}.
authApp.post("/api/auth/redeem", async (c) => {
  if (!sameOrigin(c.req.header("origin"), c.req.url)) return fail(c, "cross-site request refused", 403);
  const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
  const t = body?.token;
  if (!validToken(t)) return fail(c, "invalid login link", 400);
  const session = newToken();
  const user = await losStub(c.env).redeemLoginLink(
    await hashToken(t),
    await hashToken(session),
    Date.now() + SESSION_TTL_MS,
  );
  if (!user) return fail(c, "this login link has expired or was already used", 404);
  return c.json({ user }, 200, { ...NO_STORE, "Set-Cookie": sessionCookie(session) });
});

// Who is logged in, plus the bot account to whisper (the login page's steps)
// and whether the dev-only fake login is on (the page's bottom section).
authApp.get("/api/auth/me", async (c) => {
  return c.json(
    {
      user: await currentUser(c),
      bot: c.env.BOT_USERNAME,
      devLogin: devLoginEnabled(c.env.DEV_LOGIN),
    },
    200,
    NO_STORE,
  );
});

// DEV ONLY: log in as any rated player by name, no bot involved. Exists only
// while DEV_LOGIN=true (set only in .dev.vars); otherwise it is a plain 404, as if the route did not exist. Body {name};
// the name must be in the ranking, which is where the real account id comes
// from.
authApp.post("/api/auth/dev-login", async (c) => {
  if (!devLoginEnabled(c.env.DEV_LOGIN)) return c.notFound();
  if (!sameOrigin(c.req.header("origin"), c.req.url)) return fail(c, "cross-site request refused", 403);
  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return fail(c, "name is required", 400);
  const found = (await losStub(c.env).playersByNames([name])).players[name.toLowerCase()];
  if (!found) return fail(c, `no rated player named ${name}`, 404);
  const user: AuthUser = { userId: found.userId, name: found.name };
  const session = newToken();
  await losStub(c.env).createSession(await hashToken(session), user, Date.now() + SESSION_TTL_MS);
  console.warn(`auth: DEV login as ${user.name} (${user.userId})`);
  return c.json({ user }, 200, { ...NO_STORE, "Set-Cookie": sessionCookie(session) });
});

// Log this browser out. Always clears the cookie, logged in or not.
authApp.post("/api/auth/logout", async (c) => {
  if (!sameOrigin(c.req.header("origin"), c.req.url)) return fail(c, "cross-site request refused", 403);
  const token = sessionTokenFrom(c.req.header("cookie"));
  if (token) await losStub(c.env).deleteSession(await hashToken(token));
  return c.json({ ok: true }, 200, { ...NO_STORE, "Set-Cookie": clearedSessionCookie() });
});
