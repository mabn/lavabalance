// The bot's website-login client: the two /api/bot/auth calls behind the
// `.login` and `.logout` whispers (the flow is described in src/auth.ts).
//
// The bot is what vouches for who is asking — the whispering account — so the
// Worker accepts these calls only through Cloudflare Access: the bot sends its
// Access SERVICE TOKEN (BOT_ACCESS_CLIENT_ID / BOT_ACCESS_CLIENT_SECRET,
// handed to the container by BotContainer) and Access, fronting /api/bot/* on
// the custom domain, swaps it for the JWT the Worker verifies.
//
// Runtime-agnostic like avoidClient.ts (global fetch only): unit-tested with an
// injected fetch. Errors THROW here; the command handler logs them and tells
// the asker the login is unavailable.

/** Per-request timeout, matching the avoid client's. */
const FETCH_TIMEOUT_MS = 8000;

export interface LoginLink {
  /** The one-time link to whisper back. */
  url: string;
  /** Epoch ms after which the link no longer works. */
  expiresAt: number;
}

export interface AuthClient {
  /** A one-time website login link for this account. */
  issue(name: string, userId: number): Promise<LoginLink>;
  /** End every website session of this account; returns how many ended. */
  revoke(userId: number): Promise<number>;
}

export interface AuthClientOptions {
  /** The Access service token's client id; omitted/empty = no Access headers. */
  accessClientId?: string;
  /** The Access service token's client secret. */
  accessClientSecret?: string;
  fetchImpl?: typeof fetch;
}

export function createAuthClient(base: string, opts: AuthClientOptions = {}): AuthClient {
  const root = base.replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const clientId = (opts.accessClientId ?? "").trim();
  const clientSecret = (opts.accessClientSecret ?? "").trim();

  async function post(path: string, body: unknown): Promise<unknown> {
    const url = `${root}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        "content-type": "application/json",
      };
      if (clientId && clientSecret) {
        headers["CF-Access-Client-Id"] = clientId;
        headers["CF-Access-Client-Secret"] = clientSecret;
      }
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
          // Access answers a request it does not let through with a redirect
          // to its login page; following it would hand us that page's HTML.
          redirect: "manual",
        });
      } catch (e) {
        const why = controller.signal.aborted
          ? `timed out after ${FETCH_TIMEOUT_MS}ms`
          : e instanceof Error
            ? e.message
            : String(e);
        throw new Error(`auth POST ${url} failed: ${why}`, { cause: e });
      }
      if (res.status >= 300 && res.status < 400) {
        throw new Error(
          `auth POST ${url}: Cloudflare Access did not let the bot through (HTTP ${res.status} to ` +
            `${res.headers.get("location") ?? "?"}) — check the ACCESS_BOT_CLIENT_ID / ` +
            `ACCESS_BOT_CLIENT_SECRET secrets and that the bot application has a Service Auth policy ` +
            `for that token`,
        );
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`auth POST ${url} responded ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
      }
      const type = res.headers.get("content-type") ?? "";
      if (!type.includes("application/json")) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `auth POST ${url} answered ${res.status} with ${type || "no content type"}, not JSON ` +
            `(a Cloudflare Access page?): ${text.slice(0, 120)}`,
        );
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async issue(name, userId) {
      const r = (await post("/api/bot/auth/issue", { name, userId })) as Partial<LoginLink>;
      if (typeof r.url !== "string" || !/^https?:\/\//.test(r.url)) {
        throw new Error("auth issue: response carries no link");
      }
      return { url: r.url, expiresAt: typeof r.expiresAt === "number" ? r.expiresAt : 0 };
    },
    async revoke(userId) {
      const r = (await post("/api/bot/auth/revoke", { userId })) as { ended?: unknown };
      return typeof r.ended === "number" ? r.ended : 0;
    },
  };
}
