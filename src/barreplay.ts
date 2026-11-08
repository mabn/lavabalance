// Replay availability on barreplay (https://replay.fogofwar.dev), the sibling
// deployment that re-simulates BAR replays and plays them back in the browser.
//
// A lava game and a barreplay replay are the SAME BAR gameId, so the games list
// could link straight into the playback — except that most games have no replay
// there at all (nobody captured them), and one being re-simulated right now is
// up to an hour of engine time away from being watchable. A link that 404s half
// the time is worse than no column, so the rows are annotated from barreplay's
// own GET /api/games?id=<a,b,c>, which answers exactly the named games with the
// two fields that decide what the cell shows:
//   • published — a playable revision exists, so the link works;
//   • jobState  — what its pipeline is doing about the game, of which only
//     "processing" is worth showing (the replay is being made right now).
// An id barreplay does not know is simply ABSENT from the reply, which is the
// common case and reads the same as "no replay": no link.
//
// The lookup is BEST-EFFORT and never throws: barreplay is a separate
// deployment, and it being slow or down must cost the games list its replay
// links, not the games list. A failure comes back as an empty map plus the
// reason, which the route reports in Server-Timing rather than to the reader.

/** Where the replays live; also the base of the links the games list renders. */
export const BARREPLAY_BASE = "https://replay.fogofwar.dev";

/** The player page for one game — what "replay" links to. */
export function replayHref(id: string): string {
  return `${BARREPLAY_BASE}/replays/${encodeURIComponent(id)}`;
}

/** barreplay's own cap on ?id= (a 401st id would 400 the whole request, taking
 * the other 400 with it). A games page is at most 100 rows, so this never
 * truncates in practice; ids past it go unannotated, i.e. show no link. */
const MAX_IDS = 100;

/** The id shape barreplay's mirror accepts (its games.ts GAME_ID_RE). One id it
 * would refuse fails the WHOLE batch with a 400, so ids are filtered here
 * rather than sent and hoped for. */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Budget for the upstream call. The games list waits on it, so the ceiling is
 * "a reader would rather have the page without the links". */
const FETCH_TIMEOUT_MS = 3000;

/** What barreplay says about one game. */
export interface ReplayStatus {
  /** A playable revision exists — the link works. */
  published: boolean;
  /** State of the game's newest ingest job ("pending" | "processing" | "done" |
   * "error"), or null when it has never had one. */
  jobState: string | null;
}

/** One lookup: the statuses it could resolve, and what it cost. Never a throw —
 * `error` is set instead, and `statuses` is then empty. */
export interface ReplayStatusLookup {
  /** Keyed by game id; ids barreplay does not know are absent. */
  statuses: Record<string, ReplayStatus>;
  /** Ids actually asked about (after filtering and the cap). */
  asked: number;
  /** Wall time of the upstream request in ms (0 when nothing was asked). */
  durationMs: number;
  /** Why nothing came back; absent on success. */
  error?: string;
}

/** The reply shape we consume — everything else the row carries is ignored. */
interface BarreplayGame {
  id?: unknown;
  published?: unknown;
  jobState?: unknown;
}

/**
 * Look up the barreplay status of a batch of game ids in ONE request.
 *
 * `fetchImpl` is injected so the tests can drive this without a network (and so
 * a caller can hand it a service binding's fetch later); `base` points it at a
 * mock. Duplicate ids are collapsed — a page can list a game once, but the
 * caller should not have to know that.
 */
export async function fetchReplayStatuses(
  ids: readonly string[],
  opts: {
    fetchImpl?: typeof fetch;
    base?: string;
    timeoutMs?: number;
  } = {},
): Promise<ReplayStatusLookup> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.base ?? BARREPLAY_BASE;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;

  const wanted = [...new Set(ids.filter((id) => typeof id === "string" && ID_RE.test(id)))].slice(0, MAX_IDS);
  if (wanted.length === 0) return { statuses: {}, asked: 0, durationMs: 0 };

  const url = `${base}/api/games?id=${wanted.map(encodeURIComponent).join(",")}`;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      return fail(wanted.length, started, `barreplay responded ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { games?: unknown };
    if (!Array.isArray(body?.games)) {
      return fail(wanted.length, started, "barreplay reply carries no games array");
    }
    const statuses: Record<string, ReplayStatus> = {};
    for (const raw of body.games as BarreplayGame[]) {
      if (raw == null || typeof raw !== "object" || typeof raw.id !== "string") continue;
      statuses[raw.id] = {
        published: raw.published === true,
        jobState: typeof raw.jobState === "string" ? raw.jobState : null,
      };
    }
    return { statuses, asked: wanted.length, durationMs: Date.now() - started };
  } catch (err) {
    const why = timedOut
      ? `barreplay timed out after ${timeoutMs}ms`
      : `barreplay lookup failed: ${err instanceof Error ? err.message : String(err)}`;
    return fail(wanted.length, started, why);
  } finally {
    clearTimeout(timer);
  }
}

function fail(asked: number, started: number, error: string): ReplayStatusLookup {
  // Logged once here rather than at the call site: the caller's contract is that
  // this never fails, so nothing downstream would otherwise say that it did.
  console.warn(error);
  return { statuses: {}, asked, durationMs: Date.now() - started, error };
}

/**
 * The cache policy a replay-annotated body may be served under. A lookup that
 * came back EMPTY because barreplay was slow or down (`error` set) renders every
 * row without its link, and under the route's normal `public, max-age=60` that
 * linkless body is what a reload gets for the next minute — which is exactly how
 * the games page's default view (cold-started, first request of the visit) sat
 * without replay links while any other page size, being a different URL, had
 * them. Such a body is served `no-store` so the very next load asks again.
 */
export function replayCacheHeaders(
  lookup: ReplayStatusLookup,
  cache: Record<string, string>,
): Record<string, string> {
  return lookup.error == null ? cache : { ...cache, "Cache-Control": "no-store" };
}

/**
 * The lookup as a Server-Timing metric — how long the upstream call took, and
 * what came of it. `desc` is quoted per RFC, so the few characters that would
 * end the quoted string early are dropped.
 */
export function replayTiming(lookup: ReplayStatusLookup): string {
  const known = Object.keys(lookup.statuses).length;
  const desc = lookup.error ?? `${lookup.asked} asked, ${known} known`;
  return `barreplay;dur=${lookup.durationMs};desc="${desc.replace(/["\\\r\n]/g, " ")}"`;
}
