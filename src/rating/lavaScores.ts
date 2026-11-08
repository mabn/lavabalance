// Bulk Lavabar score (elo) lookup — the "📊 Fetch scores" button's data source.
//
// Lavabar's balancer endpoint takes a flat list of player names and answers with, among
// other things, a `ratings` array holding each player's elo:
//
//   curl -XPOST http://lavabar.skyride.org/api/balance -d '["huk123","No_Air",…]'
//   → {"ratings":[{"name","user_id","elo","games_played","wins","losses"},…],
//      "unknown_players":[…], "team0":…, "team1":…, …}
//
// We use it purely as a **bulk score source**: it resolves the whole roster in ONE request
// and knows more players than the per-name search-page scrape in `lavaRatings.ts`, which is
// why the button exists. The suggested split it also returns (`team0`/`team1`/win probs) is
// deliberately ignored — the button fills in scores, it does not balance anything.
//
// Pure transport + mapping (no `cloudflare:workers` import), like `lavaRatings.ts`, so it
// unit-tests in the Node pool. The elos it returns are persisted by RatingsDO.putScores into
// the `rating_hidden` column — and nothing else: the public `rating` column belongs to the
// search-page scrape. See src/rating/ratingsDO.ts for the two-column model.

import { normalizeName } from "./lavaRatings";

/** The balancer endpoint. https form of the documented http URL (same host, valid cert). */
const SCORES_URL = "https://lavabar.skyride.org/api/balance";
/** Per-request timeout. Bulk lookup, so a bit longer than the single-name scrape. */
const REQUEST_TIMEOUT_MS = 8000;
/**
 * Hard cap on how many names we forward — enforced HERE, on the server, so the public
 * relay can't be used to fan out arbitrarily large requests at Lavabar regardless of what
 * the client sends. 16 = a full 8v8 lava lobby's players (the UI sends players only, no
 * spectators), which is the largest roster this button is meant to resolve.
 */
export const MAX_SCORE_NAMES = 16;

/** One entry of the endpoint's `ratings` array. */
interface BalanceRating {
  name?: string;
  /** The player's BAR account id — NOT a Lavabar player id, so it can't build a profile URL. */
  user_id?: number;
  /** Lavabar elo — fractional (e.g. 3628.3277…). */
  elo?: number;
  games_played?: number;
  wins?: number;
  losses?: number;
}

/**
 * The balancer's answer. The score path consumes only `ratings` +
 * `unknown_players`; the suggested split and its aggregates are ignored (the
 * bot's balance path used to read them before it switched to LOS).
 */
interface BalancePayload {
  ratings?: BalanceRating[];
  unknown_players?: string[];
  team0?: string;
  team1?: string;
  team0_avg_rating?: number;
  team1_avg_rating?: number;
  /** Rating gap between the two suggested teams. */
  deviation?: number;
  /** Win probabilities as percentages (e.g. 95.5). */
  team0_win_prob?: number;
  team1_win_prob?: number;
  total_players?: number;
}

/** The balance endpoint's answer, reduced to what we persist: elos + truly-unknown names. */
export interface ScoresResult {
  /** Rounded elo per normalized name — destined for the `rating_hidden` column only. */
  elos: Record<string, number>;
  /** Names the balance endpoint itself doesn't know (no elo anywhere). */
  unknown: string[];
}

/**
 * Validate a request body into the name list to forward. Accepts `{names: ["a","b"]}` (what
 * the UI sends) or the bare array the endpoint itself takes. Trims entries, drops blanks and
 * drops case-insensitive duplicates (keeping the first spelling), then enforces
 * `MAX_SCORE_NAMES` on what's left — so the cap counts distinct players and can't be gamed
 * by padding the list. Throws with a client-facing message when the body isn't a usable
 * list or is over the cap; the route turns that into a 400.
 */
export function parseScoresRequest(body: unknown): string[] {
  return parseNameList(body, MAX_SCORE_NAMES);
}

/**
 * The shared body → name-list validation. `max` is the caller's cap: the score lookup uses
 * `MAX_SCORE_NAMES` (one lobby), while the admin hide list allows a longer roster.
 */
export function parseNameList(body: unknown, max: number): string[] {
  const raw = Array.isArray(body)
    ? body
    : typeof body === "object" && body !== null && Array.isArray((body as { names?: unknown }).names)
      ? (body as { names: unknown[] }).names
      : null;
  if (!raw) throw new Error("expected {names: [...]} or a JSON array of player names");

  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") throw new Error("player names must be strings");
    const name = entry.trim();
    if (!name) continue;
    const key = normalizeName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (!names.length) throw new Error("no player names given");
  if (names.length > max) {
    throw new Error(
      `too many player names (${names.length} > ${max}) — this endpoint resolves ` +
        `at most one lobby's players`,
    );
  }
  return names;
}

/**
 * Reduce the endpoint's payload to `{elos, unknown}`. Elo is **rounded** to match the integer
 * ratings shown elsewhere. Names in `unknown_players` are skipped — Lavabar still returns a
 * placeholder rating row for them (1875 at the time of writing), and recording an invented
 * elo would poison the averages. Everything else the payload carries (wins/losses, the
 * suggested team split, `user_id` — a BAR account id, not a Lavabar player id) is
 * deliberately ignored: the balance endpoint populates `rating_hidden`, nothing more.
 */
export function mapBalanceScores(payload: BalancePayload): ScoresResult {
  const unknown = (payload.unknown_players ?? []).filter(
    (n): n is string => typeof n === "string" && n.trim() !== "",
  );
  const unknownKeys = new Set(unknown.map(normalizeName));

  const elos: Record<string, number> = {};
  for (const r of payload.ratings ?? []) {
    if (typeof r.name !== "string" || !r.name.trim()) continue;
    if (typeof r.elo !== "number" || !Number.isFinite(r.elo)) continue;
    const key = normalizeName(r.name);
    if (unknownKeys.has(key)) continue; // placeholder rating, not a real one
    elos[key] = Math.round(r.elo);
  }
  return { elos, unknown };
}

/**
 * POST the roster to Lavabar and return every score it knows (with a timeout). Throws on
 * non-2xx / network error, naming the request and distinguishing a timeout from a network
 * error (the raw AbortError is just "The operation was aborted") so the resulting 502 says
 * what actually failed — mirroring `lavaRatings.fetchOnce` / `rtsapi.fetchBattles`.
 */
export async function fetchScores(
  names: string[],
  opts: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<ScoresResult> {
  return mapBalanceScores(await requestBalance(names, opts));
}

/** The shared POST/timeout/tracing/error-tagging transport. */
async function requestBalance(
  names: string[],
  opts: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<BalancePayload> {
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  // Bind to globalThis: Workers' global `fetch` throws "Illegal invocation" when invoked
  // as a method (same reason as lavaRatings).
  const fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const started = Date.now();
  // Trace the request/response like the other upstreams (always on — public data). The
  // names are the payload, so log the count rather than the body.
  console.log(`→ lavabar POST ${SCORES_URL} (${names.length} players)`);
  try {
    const res = await fetchFn(SCORES_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(names),
      signal: controller.signal,
    });
    console.log(
      `← lavabar POST ${SCORES_URL} ${res.status} ${res.statusText} (${Date.now() - started}ms)`,
    );
    if (!res.ok) {
      throw new Error(`lavabar POST ${SCORES_URL} responded ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as BalancePayload;
  } catch (err) {
    if (timedOut) throw new Error(`lavabar POST ${SCORES_URL} timed out after ${timeoutMs}ms`);
    // Re-tag a bare network error with the URL; pass through our own already-tagged throws.
    if (err instanceof Error && err.message.startsWith("lavabar ")) throw err;
    throw new Error(
      `lavabar POST ${SCORES_URL} failed after ${Date.now() - started}ms: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    clearTimeout(timer);
  }
}
