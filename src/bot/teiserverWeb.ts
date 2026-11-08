// TeiserverWeb — a plain in-memory session to Teiserver's web UI (HTTP API).
//
// This is the transport/session core extracted from the old TeiserverDO: a cookie
// jar to https://server4.beyondallreason.info, lazy login (GET the login form for
// the CSRF token + session cookie, then POST email/password), authed fetches with
// an expired-session re-login retry, and password-redacted debug tracing.
//
// It is deliberately runtime-agnostic (global fetch/Headers only, no
// `cloudflare:workers`, no `node:*`), so it runs both in the Node bot
// (src/bot/bot.ts) and inside the Worker's TeiserverDO, which wraps it and
// persists the cookie jar in DO storage via the onCookiesChanged hook. Used
// standalone, the session lives purely in memory — a restart just logs in again.

import { extractCsrfToken } from "../teiserver";

/** Teiserver web base (HTTPS/443 — distinct from the lobby TCP port in config.ts). */
export const WEB_BASE = "https://server4.beyondallreason.info";
/** Per-request timeout for an upstream web fetch. */
const FETCH_TIMEOUT_MS = 8000;

/** Credentials + debug flag, read lazily on each use so late-bound config works. */
export interface TeiserverWebConfig {
  /** Account email for the web login form (NOT the lobby account name). */
  email?: string;
  /** Plaintext account password (the web form needs it raw, unlike the lobby md5). */
  password?: string;
  /** Trace every request/response (password redacted, bodies capped). */
  debug?: boolean;
  /** Override the web base URL (testing against a local stub); default WEB_BASE. */
  base?: string;
}

/** A logged-in, in-memory session to the Teiserver web UI. */
export class TeiserverWeb {
  /** Cookie jar (name → value), in memory only. */
  private cookies = new Map<string, string>();
  /** De-dupes concurrent logins so overlapping calls share one login round-trip. */
  private loginInflight?: Promise<void>;

  constructor(
    private readonly config: () => TeiserverWebConfig,
    /** Called with the whole jar whenever it changes (for optional persistence). */
    private readonly onCookiesChanged?: (cookies: Record<string, string>) => void | Promise<void>,
  ) {}

  /**
   * Seed the jar from persisted state (e.g. DO storage). In-memory cookies already
   * set take precedence — the live jar is newer than what was stored.
   */
  seedCookies(stored: Record<string, string>): void {
    for (const [name, value] of Object.entries(stored)) {
      if (!this.cookies.has(name)) this.cookies.set(name, value);
    }
  }

  /** Whether the jar carries a Guardian auth token (i.e. a live-looking session). */
  hasSession(): boolean {
    return this.cookies.has("guardian_default_token");
  }

  /**
   * Ensure a live session: reuse an existing Guardian cookie, otherwise log in once.
   * The login is de-duped so overlapping callers share one round-trip.
   */
  ensureLogin(): Promise<void> {
    if (this.hasSession()) return Promise.resolve();
    if (!this.loginInflight) {
      this.loginInflight = this.login().finally(() => {
        this.loginInflight = undefined;
      });
    }
    return this.loginInflight;
  }

  /**
   * Log in to the Teiserver web UI: GET the login form (for the CSRF token + initial
   * session cookie), then POST the credentials. Success is a 3xx redirect that sets a
   * non-empty `guardian_default_token`; a failed login re-renders the form (200) with
   * an empty token.
   */
  private async login(): Promise<void> {
    const { email, password } = this.config();
    if (!email || !password) {
      throw new Error("TEISERVER_EMAIL/TEISERVER_PASSWORD are not configured");
    }
    this.cookies.clear();

    const page = await this.webFetch("/login", { redirect: "manual" });
    this.captureCookies(page);
    const token = extractCsrfToken(await page.text());
    if (!token) throw new Error("could not find a CSRF token on the login page");

    const body = new URLSearchParams();
    body.set("_csrf_token", token);
    body.set("user[email]", email);
    body.set("user[password]", password);
    const res = await this.webFetch("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });
    this.captureCookies(res);

    const redirected = res.status >= 300 && res.status < 400;
    if (!redirected || !this.cookies.get("guardian_default_token")) {
      throw new Error("teiserver login failed (invalid credentials?)");
    }
    // Hand the freshly-issued session to the persistence hook (if any).
    await this.notifyCookies();
  }

  /**
   * GET an authed page as text. If the session has expired (a redirect back to
   * /login), log in again and retry once.
   */
  async authedFetch(path: string): Promise<string> {
    let res = await this.webFetch(path, { redirect: "manual" });
    if (this.isLoginRedirect(res)) {
      this.cookies.delete("guardian_default_token");
      await this.ensureLogin();
      res = await this.webFetch(path, { redirect: "manual" });
    }
    // Keep any persisted jar in sync if the server rotated a cookie on this response.
    if (this.captureCookies(res)) await this.notifyCookies();
    if (res.status !== 200) {
      const message = `teiserver GET ${path} returned ${res.status} ${res.statusText}`;
      console.error(message);
      throw new Error(message);
    }
    return res.text();
  }

  private isLoginRedirect(res: Response): boolean {
    if (res.status < 300 || res.status >= 400) return false;
    return (res.headers.get("location") ?? "").includes("/login");
  }

  /**
   * fetch() against the web base, attaching the cookie jar and a timeout.
   *
   * On failure this throws an error that names the failing request (method + path)
   * and whether it was our timeout vs a network error — the raw AbortError is just
   * "The operation was aborted", with no clue which upstream call died. The failure
   * is also `console.error`'d here; the error names only the method/path, never a
   * body.
   *
   * With debug on, the full request/response — INCLUDING the login flow — is traced.
   * The account password is redacted wherever it appears (see redactPassword) and
   * bodies are capped/escaped (see formatBodyForLog), so the login POST is safe to
   * log.
   */
  private async webFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const method = init.method ?? "GET";
    const controller = new AbortController();
    // Distinguish OUR deadline (timedOut) from any other abort/network error.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    const headers = new Headers(init.headers);
    headers.set("accept", headers.get("accept") ?? "text/html");
    const cookie = this.cookieHeader();
    if (cookie) headers.set("cookie", cookie);
    const debug = this.config().debug === true;
    if (debug) {
      const reqBody = typeof init.body === "string" ? ` ${this.formatBodyForLog(init.body)}` : "";
      console.log(this.redactPassword(`→ teiserver ${method} ${path}${reqBody}`));
    }
    const started = Date.now();
    try {
      const res = await globalThis.fetch(`${this.config().base ?? WEB_BASE}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (debug) {
        // Read the body off a clone so the caller can still consume it.
        const body = await res.clone().text();
        console.log(
          this.redactPassword(`← teiserver ${method} ${path} ${res.status} ${res.statusText}`) +
            ` ${this.formatBodyForLog(body)}`,
        );
      }
      return res;
    } catch (err) {
      const elapsed = Date.now() - started;
      const reason = timedOut
        ? `timed out after ${FETCH_TIMEOUT_MS}ms`
        : `failed after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`;
      const message = `teiserver ${method} ${path} ${reason}`;
      console.error(message);
      throw new Error(message);
    } finally {
      clearTimeout(timer);
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /**
   * Replace the configured password with a placeholder wherever it appears in a log
   * string. The password shows up raw in our own messages and form-url-encoded in
   * the login POST body, so both forms are redacted. No-op when none is configured.
   */
  private redactPassword(s: string): string {
    const pw = this.config().password;
    if (!pw) return s;
    let out = s;
    for (const variant of new Set([
      pw,
      encodeURIComponent(pw),
      new URLSearchParams({ p: pw }).toString().slice(2), // x-www-form-urlencoded form
    ])) {
      if (variant) out = out.split(variant).join("REDACTED_TEISERVER_PASSWORD");
    }
    return out;
  }

  /**
   * Prepare a request/response body for a single-line debug log: redact the
   * password, cap at the first 200 characters, and escape newlines so it never
   * spills across log rows.
   */
  private formatBodyForLog(body: string): string {
    return this.redactPassword(body).slice(0, 200).replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  }

  /**
   * Merge a response's Set-Cookie headers into the jar (empty value = delete).
   * Returns whether the jar actually changed, so persistence runs only when needed.
   */
  private captureCookies(res: Response): boolean {
    let changed = false;
    for (const line of res.headers.getSetCookie()) {
      const first = line.split(";", 1)[0];
      const eq = first.indexOf("=");
      if (eq < 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (!name) continue;
      if (value === "") {
        if (this.cookies.delete(name)) changed = true;
      } else if (this.cookies.get(name) !== value) {
        this.cookies.set(name, value);
        changed = true;
      }
    }
    return changed;
  }

  private notifyCookies(): Promise<void> | void {
    return this.onCookiesChanged?.(Object.fromEntries(this.cookies));
  }
}
