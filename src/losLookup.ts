// LOS bulk name lookup over the bot's HTTP API (GET /api/bot/players/lookup) —
// runtime-agnostic (global fetch only, no cloudflare:* / node:*), used by the
// Node bot. The Worker resolves LOS through a direct DO RPC instead
// (src/losRatings.ts); this client exists for consumers outside the Worker.

/** One player's current LOS state, as /api/players/lookup returns it. */
export interface LosPlayerInfo {
  /** Stable BAR account id. */
  userId: number;
  name: string;
  /** Shown LOS = max(mu − rookieHandicap(games) − sigma, 0). */
  los: number;
  mu: number;
  sigma: number;
  /** Rated lava games played. */
  games: number;
  wins: number;
}

/** Default LOS service base URL (the merged Worker's custom domain). */
export const DEFAULT_LOS_BASE = "https://lavabalance.fogofwar.dev";

/** The lookup endpoint's per-request name cap (MAX_LOOKUP_NAMES in src/los/). */
const LOOKUP_CHUNK = 32;

/** Per-request timeout. */
const FETCH_TIMEOUT_MS = 8000;

/**
 * Resolve LOS for the given lobby names, keyed by LOWERCASED name (names LOS has
 * never rated are absent). Chunks requests under the endpoint's 32-name cap.
 * Throws on any failed request. Network-level failures (Node's bare "fetch failed"
 * TypeError, an abort on timeout) are wrapped so the error names the URL, with the
 * original error kept as `cause` — callers log it; they must not show it to players.
 */
export async function fetchLosPlayers(
  base: string,
  names: string[],
  /** The bot's Access service token: LOS is not public, so the lookup sits
   * behind the bot's Access application with the other /api/bot routes. */
  access: { clientId?: string; clientSecret?: string } = {},
): Promise<Record<string, LosPlayerInfo>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (access.clientId && access.clientSecret) {
    headers["CF-Access-Client-Id"] = access.clientId;
    headers["CF-Access-Client-Secret"] = access.clientSecret;
  }
  const root = base.replace(/\/+$/, "");
  const wanted = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))];
  const out: Record<string, LosPlayerInfo> = {};
  for (let i = 0; i < wanted.length; i += LOOKUP_CHUNK) {
    const chunk = wanted.slice(i, i + LOOKUP_CHUNK);
    const url = `${root}/api/bot/players/lookup?names=${encodeURIComponent(chunk.join(","))}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await fetch(url, {
          headers,
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
        throw new Error(`lavaos GET ${url} failed: ${why}`, { cause: e });
      }
      if (!res.ok) throw new Error(`lavaos GET ${url} responded ${res.status} ${res.statusText}`);
      const body = (await res.json()) as { players?: Record<string, LosPlayerInfo> };
      for (const [key, p] of Object.entries(body.players ?? {})) {
        if (
          typeof p?.userId === "number" &&
          typeof p.los === "number" &&
          typeof p.mu === "number" &&
          typeof p.sigma === "number" &&
          typeof p.games === "number"
        ) {
          out[key.toLowerCase()] = p;
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}
