// Cloudflare Access as the superadmin login — the same scheme as barreplay
// (mabn/barreplay worker/src/worker/access.ts, which this file is ported from).
//
// The admin surface — admin mode on the pages (the hidden profiles, the avoid
// lines, the row menus, the Bot and SQL pages) and the routes behind it — used
// to be gated by nothing but `?admin=true` in the URL, a purely client-side
// switch. Now it is an identity Cloudflare Access issued:
//
//   • an Access APPLICATION in the Zero Trust dashboard protects ONE path of
//     the hostname, /admin/login, with a policy naming who may sign in;
//   • passing it leaves a `CF_Authorization` cookie for the whole hostname,
//     holding a JWT Access signed;
//   • this module VERIFIES that JWT (signature against the team's published
//     keys, audience against the application's AUD tag, issuer, expiry) on
//     every admin request. The edge rule is the login, the Worker is the gate:
//     every other path (and the workers.dev hostname) has no Access in front
//     of it, so nothing here trusts "Access let me through" — only a token
//     that verifies.
//
// Configuration is two vars: ACCESS_TEAM_DOMAIN ("<team>.cloudflareaccess.com"
// or just "<team>") and ACCESS_AUD (the application's Audience tag).
// FAIL-CLOSED: with either missing nobody is an admin through Access. Local
// dev, where no Access cookie can exist, opts in with ADMIN_OPEN=true in
// .dev.vars — never in wrangler.jsonc.
//
// The control token (CONTROL_TOKEN) is accepted as an admin credential too,
// when it is CONFIGURED and matches, so a script keeps driving the routes
// with the bearer it already has.
//
// The JWT work itself is jose's (jwtVerify + createRemoteJWKSet); the JWKS
// fetch is globalThis.fetch read at call time, so the Node tests stub it.

import { createRemoteJWKSet, customFetch, decodeJwt, errors, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { sameOrigin } from "./auth";

/** Where a team's Access signing keys are published. */
export const accessCertsURL = (teamDomain: string): string =>
  `https://${normalizeTeamDomain(teamDomain)}/cdn-cgi/access/certs`;

/** The `iss` claim Access stamps: the team domain, with scheme, no path. */
export const accessIssuer = (teamDomain: string): string => `https://${normalizeTeamDomain(teamDomain)}`;

/** normalizeTeamDomain accepts what a person pastes — "mabn",
 * "mabn.cloudflareaccess.com", "https://mabn.cloudflareaccess.com/" — and
 * returns the bare hostname. */
export function normalizeTeamDomain(raw: string): string {
  let d = raw.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!d.includes(".")) d = `${d}.cloudflareaccess.com`;
  return d.toLowerCase();
}

/** Who an admin request is from, once verified. `email` is what Access puts
 * in the token for a person; a service token has none (`sub` only). */
export interface AccessIdentity {
  email: string | null;
  sub: string;
}

/** How long jose trusts a fetched key set before re-reading it. Access keys
 * rotate rarely (and an unknown kid re-reads at once, below), so this only
 * bounds a stale set. */
export const JWKS_TTL_MS = 6 * 60 * 60 * 1000;
/** The floor between two key-set fetches provoked by an UNKNOWN kid. A token
 * naming a kid the set does not have is what key rotation looks like — and
 * also what a forged token looks like, and the second must not turn into one
 * outbound fetch per request. jose's cooldownDuration. */
export const JWKS_REFETCH_MIN_MS = 60 * 1000;

export interface VerifyOptions {
  teamDomain: string;
  aud: string;
  /** Unix milliseconds; defaults to Date.now(). Only the claims (exp/nbf)
   * read it — the key-set cache keeps jose's own clock. */
  now?: number;
}

export interface VerifierOptions {
  /** Override of JWKS_REFETCH_MIN_MS (tests: 0 makes a rotation visible
   * without waiting a minute). */
  cooldownMs?: number;
  /** Override of JWKS_TTL_MS. */
  cacheMaxAgeMs?: number;
}

/** The jose errors that mean "this token is no good" — answered with null.
 * Everything else jose throws (a key set that cannot be fetched or parsed,
 * a timeout) is an outage and propagates. */
const BAD_TOKEN_ERRORS = [
  errors.JWTClaimValidationFailed,
  errors.JWTExpired,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JWTInvalid,
  errors.JWKInvalid,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];

/** AccessVerifier verifies Access JWTs for one team + application with jose
 * (jwtVerify over createRemoteJWKSet, which owns the key-set cache, its
 * TTL and the unknown-kid refetch cooldown). One instance lives for the
 * isolate's life (adminVerifier below). */
export class AccessVerifier {
  private jwks: { href: string; get: ReturnType<typeof createRemoteJWKSet> } | null = null;
  private readonly cooldownMs: number;
  private readonly cacheMaxAgeMs: number;

  constructor(opts: VerifierOptions = {}) {
    this.cooldownMs = opts.cooldownMs ?? JWKS_REFETCH_MIN_MS;
    this.cacheMaxAgeMs = opts.cacheMaxAgeMs ?? JWKS_TTL_MS;
  }

  /** verify returns the token's identity, or null for anything short of a
   * valid, unexpired token for THIS application. It never throws for a bad
   * token; it throws only when the key set cannot be read at all, which is
   * an outage, not an answer. */
  async verify(token: string, opts: VerifyOptions): Promise<AccessIdentity | null> {
    const now = opts.now ?? Date.now();
    const issuer = accessIssuer(opts.teamDomain);

    // A cheap look at the claims first (no signature, no key set): a token
    // for another issuer or application, or one already expired, is not
    // worth a key lookup, which may be a fetch.
    let claims: JWTPayload;
    try {
      claims = decodeJwt(token);
    } catch {
      return null;
    }
    if (claims.iss !== issuer) return null;
    const aud = claims.aud;
    if (!(Array.isArray(aud) ? aud.includes(opts.aud) : aud === opts.aud)) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;

    const url = new URL(accessCertsURL(opts.teamDomain));
    if (!this.jwks || this.jwks.href !== url.href) {
      this.jwks = {
        href: url.href,
        get: createRemoteJWKSet(url, {
          cooldownDuration: this.cooldownMs,
          cacheMaxAge: this.cacheMaxAgeMs,
          // globalThis.fetch at call time, never captured at import: the
          // tests stub it per test, and a captured reference would outlive
          // the stub.
          [customFetch]: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
        }),
      };
    }
    try {
      const { payload } = await jwtVerify(token, this.jwks.get, {
        issuer,
        audience: opts.aud,
        algorithms: ["RS256"],
        currentDate: new Date(now),
        requiredClaims: ["exp", "sub"],
      });
      return {
        email: typeof payload.email === "string" ? payload.email : null,
        sub: payload.sub as string,
      };
    } catch (e) {
      if (BAD_TOKEN_ERRORS.some((cls) => e instanceof cls)) return null;
      throw e;
    }
  }

  /** forget drops the key-set cache (tests). */
  forget(): void {
    this.jwks = null;
  }
}

/** accessToken finds the Access JWT on a request. On the path the Access
 * application protects, Access itself adds the assertion header; everywhere
 * else the browser sends the cookie Access set for the hostname, which is
 * what every admin API call carries. */
export function accessToken(headers: { get(name: string): string | null }): string | null {
  const h = headers.get("cf-access-jwt-assertion");
  if (h) return h.trim();
  const cookie = headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === "CF_Authorization") return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/** loginNext keeps a post-login destination on this site: a path, never a
 * URL — an open redirect on the one page every admin passes through would
 * be a phishing tool. Anything else lands on the main page. */
export function loginNext(raw: string | null | undefined): string {
  if (typeof raw === "string" && /^\/(?!\/)[^\r\n\\]*$/.test(raw) && raw.length <= 2048) return raw;
  return "/";
}


/** The env vars the admin check reads (declared on Env in src/config.ts). */
export interface AdminEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** The AUD of the Access application fronting /api/bot/* (botIdentity). */
  ACCESS_BOT_AUD?: string;
  /** The AUD of the Access application fronting /api/scout/profiles (scoutIdentity). */
  ACCESS_SCOUT_AUD?: string;
  /** "true" makes every request an admin. Local dev only (.dev.vars). */
  ADMIN_OPEN?: string;
  CONTROL_TOKEN?: string;
}

/** Who an admin request is from, and by which credential. */
export interface AdminIdentity {
  email: string | null;
  via: "open" | "token" | "access";
}

/** Whether Access is configured on this deployment (both vars set). */
export function accessConfigured(env: AdminEnv): boolean {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
}

/** Constant-time string compare (the control token is a secret). */
function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** One verifier per isolate: it caches the team's signing keys. */
const adminVerifier = new AccessVerifier();

/**
 * adminIdentity: who is asking, when it is an admin; null for everyone else.
 * Three ways in, tried in order: ADMIN_OPEN=true (local dev only); the control
 * token, when CONFIGURED and matching; a valid Access token for this
 * application (the CF_Authorization cookie, or Access's own assertion header
 * on the path it protects). A key set that cannot be fetched counts as "not
 * an admin" (logged): an Access outage must not take the public pages down.
 */
export async function adminIdentity(
  env: AdminEnv,
  headers: { get(name: string): string | null },
): Promise<AdminIdentity | null> {
  if (env.ADMIN_OPEN === "true") return { email: null, via: "open" };
  const control = env.CONTROL_TOKEN;
  const auth = headers.get("authorization");
  if (control && auth && /^Bearer\s+/i.test(auth) && timingSafeEqual(auth.replace(/^Bearer\s+/i, ""), control)) {
    return { email: null, via: "token" };
  }
  const { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud } = env;
  if (!teamDomain || !aud) return null;
  const jwt = accessToken(headers);
  if (!jwt) return null;
  try {
    const id = await adminVerifier.verify(jwt, { teamDomain, aud });
    return id ? { email: id.email, via: "access" } : null;
  } catch (e) {
    console.error(`Access key set unreadable, treating the request as non-admin: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * adminRequest: adminIdentity for a whole request, refusing a write from a
 * foreign Origin first. The Access cookie is ambient, so without this another
 * site could post a form at an admin route from a signed-in admin's browser
 * (the same rule the BAR-account login's POSTs follow, src/auth.ts sameOrigin).
 */
export async function adminRequest(env: AdminEnv, req: Request): Promise<AdminIdentity | null> {
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req.headers.get("origin"), req.url)) return null;
  return adminIdentity(env, req.headers);
}

/** Whether the bot routes' Access check is configured (team + bot AUD). */
export function botAccessConfigured(env: AdminEnv): boolean {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_BOT_AUD);
}

/** Whether the scouting push's Access check is configured (team + scout AUD). */
export function scoutAccessConfigured(env: AdminEnv): boolean {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_SCOUT_AUD);
}

/**
 * serviceIdentity: whether a request carries a valid Access token for ONE
 * machine-to-machine Access application, named by its audience. The caller
 * holds an Access SERVICE TOKEN (CF-Access-Client-Id/-Secret headers); Access
 * swaps it for the Cf-Access-Jwt-Assertion header this reads, and the Worker
 * verifies that JWT itself (signature, issuer, expiry, THIS audience) — so a
 * request that skipped Access (the workers.dev hostname) or brought another
 * application's token, an admin's browser cookie included, gets nothing. No
 * control-token fallback. Fail-closed without a team domain or audience;
 * ADMIN_OPEN=true (local dev only) opens it like the admin check.
 */
async function serviceIdentity(
  env: AdminEnv,
  headers: { get(name: string): string | null },
  aud: string | undefined,
  who: string,
): Promise<AccessIdentity | null> {
  if (env.ADMIN_OPEN === "true") return { email: null, sub: "dev" };
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  if (!teamDomain || !aud) return null;
  const jwt = accessToken(headers);
  if (!jwt) return null;
  try {
    return await adminVerifier.verify(jwt, { teamDomain, aud });
  } catch (e) {
    console.error(`Access key set unreadable, refusing the ${who} request: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * botIdentity: a request to the bot's routes (/api/bot/*) from the bot — a
 * token for the BOT application (ACCESS_BOT_AUD), so an admin's browser cookie
 * (ACCESS_AUD) does not pass here and the bot's credential does not pass the
 * admin check.
 */
export function botIdentity(
  env: AdminEnv,
  headers: { get(name: string): string | null },
): Promise<AccessIdentity | null> {
  return serviceIdentity(env, headers, env.ACCESS_BOT_AUD, "bot");
}

/**
 * scoutIdentity: a scouting push (POST /api/scout/profiles) from onetricklava —
 * a token for the SCOUT application (ACCESS_SCOUT_AUD), its own service token
 * and its own audience, so neither the bot's credential nor an admin cookie
 * can push cards, and OTL's token can do nothing else on this site.
 */
export function scoutIdentity(
  env: AdminEnv,
  headers: { get(name: string): string | null },
): Promise<AccessIdentity | null> {
  return serviceIdentity(env, headers, env.ACCESS_SCOUT_AUD, "scout");
}

/** The Set-Cookie value that drops the Access cookie on this hostname — the
 * admin sign-out. Access sets CF_Authorization host-only with Path=/, so the
 * same name and path expire it. (Access's own session, on the team domain,
 * lives on; signing in again then skips the PIN while it lasts.) */
export function clearedAccessCookie(secure: boolean): string {
  return ["CF_Authorization=", "Path=/", "HttpOnly", "SameSite=Lax", ...(secure ? ["Secure"] : []), "Max-Age=0"].join("; ");
}
