// Alternate data source for GET /api/lobbies?src=rtsapi.
//
// Instead of rebuilding lobby state from the proxied protocol stream (the Dispatcher
// Durable Object), this path is handled entirely by the Worker: it fetches the public
// BAR live battle list from https://api.bar-rts.com/battles and maps it into the SAME
// JSON shape the Dispatcher's `lobbies()` returns, so the existing UI consumes it
// unchanged. Per the chosen scope it is filtered to the configured `lava_lobbies`.
//
// The bar-rts list is itself produced by bar-db's lobby-service, which logs into the
// same Teiserver lobby and enriches each battle by querying SPADS (`getFullStatus`).
//
// KNOWN GAPS vs the Dispatcher view (the public API simply does not carry these):
//   • ally team — there is NO allyteam anywhere in the API or bar-db; each player has a
//     single unique `teamId` (their SPADS slot, 1..N). We cannot reconstruct the two
//     sides, so every non-spectator is reported as `ally: 0` (one team per lobby).
//   • engineVersion, sync (downloading), bosses, balanceMode — not exposed; reported as
//     ""/0/[]/null/false.
// Derived fields: `spectator` = no slot (`teamId == null`); `skill` parsed out of the
// bracketed OS string ("[18.2 ???]" → 18.2); `rank` shifted from bar-rts's raw 0-7 to
// the 1-8 display level the rank icons use (matching the Dispatcher view).


/** Public BAR live battle list. */
const BATTLES_URL = "https://api.bar-rts.com/battles";
/** Per-request timeout for the upstream fetch. */
const FETCH_TIMEOUT_MS = 5000;

// ---- Subset of the bar-rts /battles response we consume (see the analysis above). ----

interface BarRtsStatus {
  ingame?: boolean;
  away?: boolean;
  /** Raw account rank, 0-7 (bots report 0). */
  rank?: number;
  moderator?: boolean;
  bot?: boolean;
}

interface BarRtsPlayer {
  username: string;
  status?: BarRtsStatus;
  /** Bracketed OS string, e.g. "[18.2 ???]" (the ?s are uncertainty markers). */
  skill?: string;
  /** SPADS slot id (1..N), or absent/null for a lobby spectator. */
  teamId?: number | null;
  /** "Yes" / "No" (absent for spectators). */
  lobbyReady?: string;
}

interface BarRtsBattle {
  battleId: number;
  founder?: { username?: string; status?: BarRtsStatus };
  title?: string;
  map?: string;
  /** Game + version string, e.g. "Beyond All Reason test-30505-12db645". */
  game?: string;
  maxPlayers?: number;
  passworded?: boolean;
  locked?: boolean;
  /** Server-reported spectator count. */
  spectators?: number;
  players?: BarRtsPlayer[];
}

// ---- Output shape: identical to Dispatcher.lobbies() so the UI is unchanged. ----

export interface RtsApiLobbyPlayer {
  name: string;
  skill: number | null;
  /** Party grouping is not exposed by the public API; always null. */
  party: string | null;
  rank: number | null;
  inGame: boolean;
  away: boolean;
  ready: boolean;
  spectator: boolean;
  /** Not available from this source; always 0 (unknown). */
  sync: number;
  /** Not available from this source; always 0 (no allyteam in the API — see file header). */
  ally: number;
  /** SPADS slot id (0 for spectators). */
  team: number;
  /** Not available from this source; always false. */
  boss: boolean;
  statusKnown: boolean;
}

export interface RtsApiLobby {
  battleId: number;
  founder: string;
  title: string;
  map: string;
  gameName: string;
  /** Not available from this source; always "". */
  engineVersion: string;
  maxPlayers: number;
  passworded: boolean;
  locked: boolean;
  /** The founder is in-game (how the protocol defines a battle "in progress"). */
  inProgress: boolean;
  /** Elapsed match time is not exposed by the public API; always null. */
  inProgressSec: number | null;
  /** Not available from this source; always null. */
  balanceAlgorithm: string | null;
  /** The SPADS balanceMode; not available from this source, always null. */
  balanceMode: string | null;
  spectatorCount: number;
  /** Not available from this source; always []. */
  bosses: string[];
  playerCount: number;
  players: RtsApiLobbyPlayer[];
}

/** Extract the leading OS number from a bracketed skill string ("[18.2 ???]" → 18.2). */
export function parseSkill(skill?: string): number | null {
  if (typeof skill !== "string") return null;
  const m = skill.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** Shift bar-rts's raw 0-7 rank to the 1-8 display level the rank icons use. */
function displayRank(raw?: number): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.min(8, Math.max(1, raw + 1));
}

/** A player has a real lobby slot iff `teamId` is a finite number; otherwise a spectator. */
function hasSlot(teamId?: number | null): boolean {
  return typeof teamId === "number" && Number.isFinite(teamId);
}

/**
 * Map the raw bar-rts battle list into the `lobbies()` contract, filtered to the
 * configured lava lobbies. `all` ignores `lavaIds` and maps every battle instead.
 * (Ratings — LOS — are layered on by the detail route via finalizeLobby, not here.)
 */
export function mapBattlesToLobbies(
  battles: BarRtsBattle[],
  lavaIds: Iterable<number>,
  all = false,
): RtsApiLobby[] {
  const wanted = new Set(lavaIds);
  const out: RtsApiLobby[] = [];

  for (const b of battles) {
    if (!all && !wanted.has(b.battleId)) continue;
    const players = b.players ?? [];

    const mapped: RtsApiLobbyPlayer[] = players.map((p) => {
      const slot = hasSlot(p.teamId);
      return {
        name: p.username,
        skill: parseSkill(p.skill),
        party: null,
        rank: displayRank(p.status?.rank),
        inGame: p.status?.ingame ?? false,
        away: p.status?.away ?? false,
        ready: p.lobbyReady === "Yes",
        spectator: !slot,
        sync: 0,
        ally: 0,
        team: slot ? (p.teamId as number) : 0,
        boss: false,
        statusKnown: true,
      };
    });

    // Match the Dispatcher view: players ordered by OS (skill) high→low, unknown last.
    mapped.sort((a, b) => (b.skill ?? -Infinity) - (a.skill ?? -Infinity));

    out.push({
      battleId: b.battleId,
      founder: b.founder?.username ?? "",
      title: b.title ?? "",
      map: b.map ?? "",
      gameName: b.game ?? "",
      engineVersion: "",
      maxPlayers: b.maxPlayers ?? 0,
      passworded: b.passworded ?? false,
      locked: b.locked ?? false,
      inProgress: players.find((p) => p.username === b.founder?.username)?.status?.ingame ?? false,
      inProgressSec: null,
      balanceAlgorithm: null,
      balanceMode: null,
      spectatorCount: b.spectators ?? 0,
      bosses: [],
      playerCount: players.length,
      players: mapped,
    });
  }

  return out;
}

/**
 * Fetch the public bar-rts battle list (with a timeout). Throws on non-2xx / network error,
 * naming the URL and distinguishing a timeout from a network error (the raw AbortError is
 * just "The operation was aborted") so the resulting 502 says what actually failed.
 */
export async function fetchBattles(timeoutMs = FETCH_TIMEOUT_MS): Promise<BarRtsBattle[]> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const started = Date.now();
  // Trace the outgoing request/response (always on — these are public, no secrets) so the
  // src=rtsapi path is observable, mirroring the teiserver scraper's →/← logging.
  console.log(`→ bar-rts GET ${BATTLES_URL}`);
  try {
    const res = await fetch(BATTLES_URL, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    console.log(
      `← bar-rts GET ${BATTLES_URL} ${res.status} ${res.statusText} (${Date.now() - started}ms)`,
    );
    if (!res.ok) {
      throw new Error(`bar-rts GET ${BATTLES_URL} responded ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as BarRtsBattle[];
  } catch (err) {
    if (timedOut) throw new Error(`bar-rts GET ${BATTLES_URL} timed out after ${timeoutMs}ms`);
    // Re-tag a bare network error with the URL; pass through our own already-tagged throws.
    if (err instanceof Error && err.message.startsWith("bar-rts ")) throw err;
    const elapsed = Date.now() - started;
    throw new Error(
      `bar-rts GET ${BATTLES_URL} failed after ${elapsed}ms: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the lobby LIST for `?src=rtsapi`: fetch the public battle list and map the
 * configured lava lobbies into the `lobbies()` contract. Throws if the upstream
 * battle-list fetch fails. `all` ignores `lavaIds` and returns every open battle instead.
 */
export async function lobbiesFromRtsApi(
  lavaIds: number[],
  all = false,
): Promise<RtsApiLobby[]> {
  const battles = await fetchBattles();
  return mapBattlesToLobbies(battles, lavaIds, all);
}

/**
 * Build ONE lobby (by id) for `?src=rtsapi`'s detail view. Returns null when the id
 * isn't an open battle (honoring the lava filter unless `all`). Throws if the upstream
 * battle-list fetch fails. LOS ratings are layered on by the route, not here.
 */
export async function lobbyFromRtsApi(
  id: number,
  lavaIds: number[],
  all = false,
): Promise<RtsApiLobby | null> {
  if (!all && !lavaIds.includes(id)) return null;
  const battles = await fetchBattles();
  const battle = battles.find((b) => b.battleId === id);
  if (!battle) return null;
  const [lobby] = mapBattlesToLobbies([battle], [id]);
  return lobby ?? null;
}

/** The last battle list fetched for rank fill-ins, reused for RANK_CACHE_MS. */
let rankCache: { at: number; battles: Promise<BarRtsBattle[]> } | null = null;
const RANK_CACHE_MS = 30_000;

/**
 * Account ranks (1-8 display levels) by lowercased name, from the public battle
 * list, for the players of battle `id`. The fill-in for roster rows whose rank
 * the bot never learned: it only knows a rank from a CLIENTSTATUS line, and some
 * players never send it one, while bar-rts carries every player's. One fetch per
 * 30 s per isolate at most, and only when a roster has a gap.
 */
export async function ranksFromRtsApi(id: number, now = Date.now()): Promise<Map<string, number>> {
  if (!rankCache || now - rankCache.at > RANK_CACHE_MS) {
    const battles = fetchBattles(3000);
    rankCache = { at: now, battles };
    // A failed fetch must not be cached for the next 30 s.
    battles.catch(() => {
      if (rankCache?.battles === battles) rankCache = null;
    });
  }
  const battle = (await rankCache.battles).find((b) => b.battleId === id);
  const out = new Map<string, number>();
  for (const p of battle?.players ?? []) {
    const rank = displayRank(p.status?.rank);
    if (rank != null) out.set(p.username.toLowerCase(), rank);
  }
  return out;
}
