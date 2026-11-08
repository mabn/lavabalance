// Which battle is a player in? Behind `.join me`: the bot resolves the
// whisperer's battle and joins it as if its id had been typed.
//
// The bot's own SessionTracker cannot answer this: rosters are built from
// CLIENTBATTLESTATUS, which only arrives for the battle the bot is in, and a bot
// client gets few JOINEDBATTLE/LEFTBATTLE broadcasts for the others. The public
// bar-rts battle list (the same one `src=rtsapi` reads) lists every open battle
// with its founder and every member, spectators included — one GET answers it.
//
// Runtime-agnostic (global fetch only), unit-tested with an injected fetch.
// Errors THROW; the command handler logs them and tells the asker it failed.

const BATTLES_URL = "https://api.bar-rts.com/battles";
const FETCH_TIMEOUT_MS = 8000;

interface BarRtsBattle {
  battleId?: number;
  founder?: { username?: string };
  players?: { username?: string }[];
}

/**
 * The id of the battle `name` is in (as a member, spectator or founder;
 * case-insensitive), or null when they are in none.
 */
export async function findPlayerBattle(
  name: string,
  opts: { fetchImpl?: typeof fetch; url?: string } = {},
): Promise<number | null> {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  const url = opts.url ?? BATTLES_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
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
      throw new Error(`battle list GET ${url} failed: ${why}`, { cause: e });
    }
    if (!res.ok) throw new Error(`battle list GET ${url} returned ${res.status}`);
    const battles = (await res.json()) as BarRtsBattle[];
    if (!Array.isArray(battles)) throw new Error(`battle list GET ${url}: not an array`);
    for (const b of battles) {
      if (!Number.isInteger(b.battleId)) continue;
      const isKey = (u?: string) => (u ?? "").toLowerCase() === key;
      if (isKey(b.founder?.username) || (b.players ?? []).some((p) => isKey(p.username))) {
        return b.battleId as number;
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
