// The bot's avoid-list client: the four /api/avoids calls behind the
// .avoid/.avoidremove whispers and the balancer's constraint lookup.
//
// The lists live in the Worker (LosDO), not in the container: the bot's disk is
// ephemeral — a restart, and everybody's list would be gone. The routes are
// behind the control token when the deployment sets one (BOT_CONTROL_TOKEN,
// handed to the container by BotContainer), because a write here edits somebody
// else's list in their name; the lobby session is what proves who is asking.
//
// Runtime-agnostic like losLookup.ts / uplink.ts (global fetch only): unit-tested
// with an injected fetch. Errors THROW here — the command handlers catch them
// and tell the asker the feature is unavailable rather than going silent.

import type { AddAvoidResult, AvoidEntry, AvoidPair, RemoveAvoidResult } from "../avoids";

/** Per-request timeout, matching the LOS lookup's. */
const FETCH_TIMEOUT_MS = 8000;

export interface AvoidList {
  owner: string;
  entries: AvoidEntry[];
  limit: number;
}

export interface AvoidClient {
  /** One player's own list. */
  list(player: string): Promise<AvoidList>;
  /** Add an entry; a refusal comes back as a value, not a throw. */
  add(player: string, avoid: string): Promise<AddAvoidResult>;
  /** Remove an entry; removing something absent is a success with removed=false. */
  remove(player: string, avoid: string): Promise<RemoveAvoidResult>;
  /** The pairs a roster's entries impose — both people present, deduplicated. */
  pairs(names: string[]): Promise<AvoidPair[]>;
}

export interface AvoidClientOptions {
  /** Control token for the /api/avoids routes; omitted/empty = no auth header. */
  token?: string;
  fetchImpl?: typeof fetch;
}

export function createAvoidClient(base: string, opts: AvoidClientOptions = {}): AvoidClient {
  const root = base.replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = (opts.token ?? "").trim();

  async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    const url = `${root}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      let res: Response;
      const headers: Record<string, string> = { accept: "application/json" };
      if (init.body != null) headers["content-type"] = "application/json";
      if (token) headers.authorization = `Bearer ${token}`;
      try {
        res = await fetchImpl(url, { ...init, headers, signal: controller.signal });
      } catch (e) {
        const why = controller.signal.aborted
          ? `timed out after ${FETCH_TIMEOUT_MS}ms`
          : e instanceof Error
            ? e.message
            : String(e);
        throw new Error(`avoids ${init.method ?? "GET"} ${url} failed: ${why}`, { cause: e });
      }
      // 404/409 are the add route's own refusals and carry a result body; every
      // other non-2xx is a real failure (401 = the token is wrong, 5xx = down).
      const refusal = res.status === 404 || res.status === 409;
      if (!res.ok && !refusal) {
        await res.text().catch(() => "");
        throw new Error(`avoids ${init.method ?? "GET"} ${url} responded ${res.status} ${res.statusText}`);
      }
      return { status: res.status, body: await res.json() };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async list(player) {
      const { body } = await call(`/api/avoids/list?player=${encodeURIComponent(player)}`);
      const r = body as Partial<AvoidList>;
      return {
        owner: typeof r.owner === "string" ? r.owner : player,
        entries: Array.isArray(r.entries) ? r.entries : [],
        limit: typeof r.limit === "number" ? r.limit : 0,
      };
    },
    async add(player, avoid) {
      const { body } = await call(`/api/avoids/add`, {
        method: "POST",
        body: JSON.stringify({ player, avoid }),
      });
      return body as AddAvoidResult;
    },
    async remove(player, avoid) {
      const { body } = await call(`/api/avoids/remove`, {
        method: "POST",
        body: JSON.stringify({ player, avoid }),
      });
      return body as RemoveAvoidResult;
    },
    async pairs(names) {
      const wanted = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))];
      if (wanted.length === 0) return [];
      const { body } = await call(`/api/avoids/pairs?names=${encodeURIComponent(wanted.join(","))}`);
      const r = body as { pairs?: unknown };
      return Array.isArray(r.pairs) ? (r.pairs as AvoidPair[]) : [];
    },
  };
}
