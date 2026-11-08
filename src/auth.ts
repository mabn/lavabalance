// Website login with a BAR account — "whisper the bot".
//
// Nobody types a password into this site. A player proves they own a lobby
// account the same way the avoid list does (src/avoids.ts): by whispering the
// bot from it.
//
//   1. The player whispers `.login` to the bot in the BAR lobby.
//   2. The bot (src/bot/bot.ts) calls POST /api/bot/auth/issue with the
//      sender's name and Teiserver user id (from the server's ADDUSER line),
//      behind Cloudflare Access (src/access.ts botIdentity). The Worker stores the SHA-256 of a fresh random token
//      and answers with a one-time link: /login?t=<token>.
//   3. The bot whispers the link back. Only the account owner receives it.
//   4. GET /login?t=… shows "Continue as <name>"; nothing is consumed on GET,
//      so a chat client's link preview can neither burn nor use the link.
//   5. The button POSTs the token to /api/auth/redeem: single use, valid
//      LOGIN_LINK_TTL_MS. The Worker creates a session and sets the cookie.
//
// The link goes bot → player on purpose. The reverse ("the site shows a code,
// whisper it to the bot") can be phished: an attacker shows a victim their
// code, the victim whispers it, and the ATTACKER's browser is logged in as the
// victim.
//
// Only token HASHES are stored (the LosDO's auth_links / auth_sessions tables),
// so a copy of the database cannot be replayed as a login.
//
// Pure TypeScript over Web Crypto, no `cloudflare:*` / `node:*` — shared by the
// Worker routes and the DO, unit-testable in the Node pool.

/** How long a whispered login link stays usable. */
export const LOGIN_LINK_TTL_MS = 5 * 60_000;

/** How long a website session lasts from login. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * The session cookie. `__Host-` makes the browser refuse it unless it is
 * Secure, host-only (no Domain) and Path=/, so a sibling subdomain cannot set
 * or overwrite it.
 */
export const SESSION_COOKIE = "__Host-lb_session";

/** Longest accepted lobby name (Teiserver's own limit, with room). */
export const MAX_LOGIN_NAME_LEN = 64;

/** A logged-in website user: the BAR account the session belongs to. */
export interface AuthUser {
  /** Teiserver user id — the same id LOS keys players by. */
  userId: number;
  /** Lobby name as it was spelled when the link was issued. */
  name: string;
}

/** 32 random bytes as base64url (43 chars): a login-link or session token. */
export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** Whether a string has the exact shape newToken() produces. */
export function validToken(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{43}$/.test(raw);
}

/** SHA-256 of a token, hex — the only form a token is ever stored in. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fail(what: string): never {
  throw new Error(`invalid login request: ${what}`);
}

/** Parse the bot's `{name, userId}` (POST /api/bot/auth/issue) — throws with a usable message. */
export function parseIssueRequest(body: unknown): AuthUser {
  if (typeof body !== "object" || body === null) fail("body must be an object");
  const { name, userId } = body as { name?: unknown; userId?: unknown };
  if (typeof name !== "string") fail("name must be a lobby account name");
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LOGIN_NAME_LEN || /\s/.test(trimmed)) {
    fail("name must be a lobby account name");
  }
  if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0) {
    fail("userId must be a positive integer");
  }
  return { name: trimmed, userId };
}

/** The session token from a Cookie header, or null. */
export function sessionTokenFrom(cookieHeader: string | null | undefined): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return validToken(value) ? value : null;
  }
  return null;
}

/** Set-Cookie for a new session. */
export function sessionCookie(token: string, maxAgeMs = SESSION_TTL_MS): string {
  const maxAge = Math.floor(maxAgeMs / 1000);
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/** Set-Cookie that deletes the session cookie. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Whether a state-changing browser request comes from this site. Browsers send
 * Origin on every cross-origin POST (and on same-origin fetch POSTs), so a
 * missing header means a non-browser client, which carries no ambient cookie
 * worth forging. A present-but-different Origin is a cross-site form or fetch:
 * refused, which is what stops another site from logging a visitor out or into
 * an account of the attacker's choosing.
 */
export function sameOrigin(originHeader: string | null | undefined, requestUrl: string): boolean {
  if (!originHeader) return true;
  return originHeader === new URL(requestUrl).origin;
}

/**
 * Whether the dev-only "log in as any player" shortcut is on: the DEV_LOGIN
 * var is "true". It is set only in .dev.vars, which deploys never read.
 */
export function devLoginEnabled(flag: string | undefined): boolean {
  return flag === "true";
}
