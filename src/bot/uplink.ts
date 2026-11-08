// The bot's game-start uplink: two small POSTs to the Worker (the same base URL
// as the LOS lookups) telling it "this roster just launched" / "the game is
// over", so the lobby page can show the launch teams while the game runs. See
// src/gameStart.ts for the wire shape and the serving side.
//
// FIRE AND FORGET. The callers sit on the tracker-queue path, so nothing here
// may throw or be awaited: a failed upload costs the website its frozen-roster
// view and NOTHING else. One retry after a short delay, then give up with a log
// line. No auth header — the endpoints are open for now (auth deferred).
//
// Runtime-agnostic like losLookup.ts (global fetch only): unit-tested with an
// injected fetch.

import type { GameEndEvent, GameStartSnapshot } from "../gameStart";

/** Per-request timeout, matching losLookup's. */
const FETCH_TIMEOUT_MS = 8000;
/** One retry after this delay, then give up. */
const RETRY_DELAY_MS = 5000;

export interface UplinkOptions {
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to console.log. */
  log?: (line: string) => void;
  retryDelayMs?: number;
}

export interface Uplink {
  /** POST the launch roster; resolves once sent (or given up). Never rejects. */
  gameStart(snap: GameStartSnapshot): Promise<void>;
  /** POST the game-over notice; resolves once sent (or given up). Never rejects. */
  gameEnd(ev: GameEndEvent): Promise<void>;
}

export function createUplink(base: string, opts: UplinkOptions = {}): Uplink {
  const root = base.replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((line: string) => console.log(line));
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;

  async function postOnce(path: string, body: unknown): Promise<void> {
    const url = `${root}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        const why = controller.signal.aborted
          ? `timed out after ${FETCH_TIMEOUT_MS}ms`
          : e instanceof Error
            ? e.message
            : String(e);
        throw new Error(`uplink POST ${url} failed: ${why}`, { cause: e });
      }
      if (!res.ok) {
        // Consume the body so the connection is reusable; the status is the story.
        await res.text().catch(() => "");
        throw new Error(`uplink POST ${url} responded ${res.status} ${res.statusText}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function post(what: string, path: string, body: unknown): Promise<void> {
    try {
      await postOnce(path, body);
      log(`[uplink] ${what} sent`);
      return;
    } catch (first) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      try {
        await postOnce(path, body);
        log(`[uplink] ${what} sent (after retry)`);
      } catch (second) {
        // Both attempts down: say so once and move on — the bot's job is the
        // lobby, not the website.
        log(
          `[uplink] ${what} dropped after retry: ` +
            (second instanceof Error ? second.message : String(second)) +
            ` (first attempt: ${first instanceof Error ? first.message : String(first)})`,
        );
      }
    }
  }

  return {
    gameStart: (snap) =>
      post(
        `game-start roster for battle ${snap.battleId} (${snap.players.length} players)`,
        "/api/gamestart",
        snap,
      ),
    gameEnd: (ev) =>
      post(`game-end (${ev.reason}) for battle ${ev.battleId}`, "/api/gameend", ev),
  };
}
