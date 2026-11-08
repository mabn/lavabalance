// TeiserverDO — a singleton Durable Object that scrapes Teiserver's lobby pages on
// demand for GET /api/lobbies?src=teiserver.
//
// The web login/session/fetch core is NOT here anymore: it lives in the plain
// in-memory `TeiserverWeb` class (src/bot/teiserverWeb.ts), shared with the Node
// bot. This DO wraps one TeiserverWeb instance and adds the Worker-side concerns:
// persisting the cookie jar in DO storage (so a session survives DO eviction — a
// fresh instance seeds the jar from storage instead of re-logging-in), the 5s
// scrape caches, and the lobbies()/lobby() RPCs. (Ratings — LOS — are layered on
// by the detail route via finalizeLobby, not by this DO.)

import { DurableObject } from "cloudflare:workers";
import { TeiserverWeb } from "./bot/teiserverWeb";
import {
  buildLobby,
  parseLobbyIndex,
  parseLobbyShow,
  type IndexLobby,
  type ShowLobby,
  type TeiserverLobby,
} from "./teiserver";

/** How long a scraped page (the lobby list, or one lobby's roster) stays fresh. */
const CACHE_TTL_MS = 5000;

/** A parsed page plus when it was fetched, for the short-lived scrape cache. */
interface Cached<T> {
  at: number;
  value: T;
}

/**
 * Result of `lobbies()`. A discriminated union so a failure is RETURNED (and mapped to a
 * 502 by the Worker) rather than thrown across the DO RPC boundary — see `lobbies()`.
 */
export type LobbiesResult =
  | { ok: true; lobbies: TeiserverLobby[] }
  | { ok: false; error: string };

/** Result of `lobbyIndex()` — every open lobby's index row, same discriminated-union pattern. */
export type IndexResult =
  | { ok: true; lobbies: IndexLobby[] }
  | { ok: false; error: string };

/** Result of `lobby()` — one lobby (or null if not open), same discriminated-union pattern. */
export type LobbyResult =
  | { ok: true; lobby: TeiserverLobby | null }
  | { ok: false; error: string };

/** DO-storage key under which the cookie jar is persisted (survives eviction). */
const COOKIE_STORE_KEY = "teiserver:cookies";

/** The Worker's stateful host for a TeiserverWeb session + the scrape caches. */
export class TeiserverDO extends DurableObject<Env> {
  /** The shared web session: credentials read lazily from env, jar persisted to storage. */
  private web = new TeiserverWeb(
    () => ({
      email: this.env.TEISERVER_EMAIL,
      password: this.env.TEISERVER_PASSWORD,
      debug: this.env.DEBUG === "true",
    }),
    (cookies) => this.ctx.storage.put(COOKIE_STORE_KEY, cookies),
  );
  /** Loads the persisted cookie jar into the session once per instance (see hydrate). */
  private hydrateInflight?: Promise<void>;
  /** 5s cache of the parsed lobby list (one entry — the whole index). */
  private listCache?: Cached<IndexLobby[]>;
  /** 5s cache of parsed per-lobby roster pages, keyed by battle id (null = closed/gone). */
  private showCache = new Map<number, Cached<ShowLobby | null>>();

  /**
   * Public RPC: the parsed /battle/lobbies list (every open lobby on the server). Cached
   * for 5s so repeated polls reuse one scrape. Logs in first if the session isn't live.
   */
  async listLobbies(): Promise<IndexLobby[]> {
    if (this.listCache && Date.now() - this.listCache.at < CACHE_TTL_MS) {
      return this.listCache.value;
    }
    await this.ensureLogin();
    const value = [...parseLobbyIndex(await this.web.authedFetch("/battle/lobbies")).values()];
    this.listCache = { at: Date.now(), value };
    return value;
  }

  /**
   * Public RPC: `listLobbies()` as a discriminated result (a login/scrape failure is
   * RETURNED as `{ok:false, error}` rather than thrown across the RPC boundary — see
   * `lobbies()` for why). Backs GET /api/lobbies/all and the auto-pick (src/autoLobby.ts).
   */
  async lobbyIndex(): Promise<IndexResult> {
    try {
      return { ok: true, lobbies: await this.listLobbies() };
    } catch (e) {
      const error = e instanceof Error ? e.message : "failed to fetch teiserver lobby list";
      console.error(`teiserver lobbyIndex() failed: ${error}`);
      return { ok: false, error };
    }
  }

  /**
   * Public RPC: one lobby's parsed roster page (`null` if it can't be fetched — e.g. it
   * closed). Cached for 5s per id. Logs in first if the session isn't live.
   */
  async showLobby(id: number): Promise<ShowLobby | null> {
    const hit = this.showCache.get(id);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    await this.ensureLogin();
    let value: ShowLobby | null;
    try {
      value = parseLobbyShow(await this.web.authedFetch(`/battle/lobbies/show/${id}`));
    } catch (e) {
      // A lobby can close between the index and its show fetch; don't fail the whole
      // request over one roster, but log it so a lobby that silently drops out of the
      // list (a timeout, not just a close) is still observable. Cache the miss briefly.
      console.warn(`teiserver showLobby(${id}) failed: ${e instanceof Error ? e.message : e}`);
      value = null;
    }
    this.showCache.set(id, { at: Date.now(), value });
    return value;
  }

  /**
   * Public RPC: the configured lava lobbies, scraped from Teiserver's web UI and mapped
   * into the Dispatcher's `lobbies()` shape. Built from the two cached fetch methods
   * (`listLobbies` + `showLobby`), so repeated polls within 5s reuse the scrapes.
   *
   * `all` ignores `lavaIds` and returns every open lobby on the server instead.
   *
   * Returns a discriminated result rather than throwing: a login/scrape failure is caught
   * here and returned as `{ok:false, error}` (the Worker maps it to a 502). Throwing across
   * the DO RPC boundary surfaces as a confusing "Uncaught (in promise)" in the logs even
   * though the Worker catches it — the `error` string is the only useful signal, so we make
   * it the return value. The message names the failing upstream request (see TeiserverWeb).
   */
  async lobbies(lavaIds: number[], all = false): Promise<LobbiesResult> {
    try {
      const index = new Map((await this.listLobbies()).map((l) => [l.id, l]));
      const wanted = all ? [...index.keys()] : lavaIds.filter((id) => index.has(id));

      const shows = await Promise.all(
        wanted.map(async (id) => ({ id, show: await this.showLobby(id) })),
      );

      const out: TeiserverLobby[] = [];
      for (const s of shows) {
        if (s.show) out.push(buildLobby(index.get(s.id)!, s.show));
      }
      return { ok: true, lobbies: out };
    } catch (e) {
      const error = e instanceof Error ? e.message : "failed to fetch teiserver lobbies";
      console.error(`teiserver lobbies() failed: ${error}`);
      return { ok: false, error };
    }
  }

  /**
   * One lobby (by id) for the UI's detail page. Returns `{lobby: null}` when the id isn't
   * an open lobby (honoring the lava filter unless `all`). Same discriminated-result
   * pattern as `lobbies()` so a failure becomes a 502, not a throw.
   */
  async lobby(id: number, lavaIds: number[], all = false): Promise<LobbyResult> {
    try {
      if (!all && !lavaIds.includes(id)) return { ok: true, lobby: null };
      const index = new Map((await this.listLobbies()).map((l) => [l.id, l]));
      const row = index.get(id);
      const show = row ? await this.showLobby(id) : null;
      if (!row || !show) return { ok: true, lobby: null };
      return { ok: true, lobby: buildLobby(row, show) };
    } catch (e) {
      const error = e instanceof Error ? e.message : "failed to fetch teiserver lobby";
      console.error(`teiserver lobby(${id}) failed: ${error}`);
      return { ok: false, error };
    }
  }

  /** Hydrate the persisted cookie jar into the session, then ensure it's logged in. */
  private async ensureLogin(): Promise<void> {
    await this.hydrate();
    return this.web.ensureLogin();
  }

  /**
   * Load the cookie jar persisted in DO storage into the session, once per instance.
   * This is what lets a session outlive a DO eviction: a fresh instance reads the
   * stored Guardian token instead of logging in again. In-memory cookies already set
   * take precedence (the live jar is newer than what's on disk).
   */
  private hydrate(): Promise<void> {
    if (!this.hydrateInflight) {
      this.hydrateInflight = (async () => {
        const stored = await this.ctx.storage.get<Record<string, string>>(COOKIE_STORE_KEY);
        if (stored) this.web.seedCookies(stored);
      })();
    }
    return this.hydrateInflight;
  }
}
