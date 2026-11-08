// The bot's scouting client: GET /api/scout?names= behind the `.scout <player>`
// command (src/scout.ts has the card shape and the one-line rendering).
//
// The cards live in the Worker (pushed there by onetricklava); the bot only
// reads the PUBLIC route, so it gets exactly what a visitor gets — no card for
// a private LOS profile.
//
// Runtime-agnostic like losLookup.ts / avoidClient.ts (global fetch only):
// unit-tested with an injected fetch. Errors THROW here — the command handler
// catches them and tells the asker the feature is unavailable.

import type { ScoutCard } from "../scout";

/** Per-request timeout, matching the LOS lookup's. */
const FETCH_TIMEOUT_MS = 8000;

export interface ScoutClient {
  /** The card for this lobby name (case-insensitive), or null when OTL has none. */
  card(name: string): Promise<ScoutCard | null>;
}

export function createScoutClient(base: string, opts: { fetchImpl?: typeof fetch } = {}): ScoutClient {
  const root = base.replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async card(name: string) {
      const wanted = name.trim();
      if (!wanted) return null;
      const url = `${root}/api/scout?names=${encodeURIComponent(wanted)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        let res: Response;
        try {
          res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal });
        } catch (e) {
          const why = controller.signal.aborted
            ? `timed out after ${FETCH_TIMEOUT_MS}ms`
            : e instanceof Error
              ? e.message
              : String(e);
          throw new Error(`scout lookup GET ${url} failed: ${why}`, { cause: e });
        }
        if (!res.ok) throw new Error(`scout lookup GET ${url} returned ${res.status}`);
        const body = (await res.json()) as { cards?: ScoutCard[] };
        const key = wanted.toLowerCase();
        return (body.cards ?? []).find((c) => c.name.toLowerCase() === key) ?? body.cards?.[0] ?? null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
