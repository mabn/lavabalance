// Auto-selecting the main lava lobby.
//
// Two paths write `lava_lobbies` from here:
//   • ensureLavaLobbyConfigured — GET / with an EMPTY config: pick the best lava
//     lobby from Teiserver's index (throttled).
//   • adoptLavaLobby — a side effect of GET /api/lobbies/:id: the viewed lobby, if its
//     title contains "lava", becomes the configured one — but ONLY while the current
//     configured lobby is empty or gone (it is sticky otherwise).
//
// `GET /` (the land-in-a-lobby redirect) needs a configured `lava_lobbies` list to
// know where to send the visitor. When that list is EMPTY, the Worker asks Teiserver
// for every open lobby, keeps the ones whose name contains "lava" (case-insensitive)
// and configures the one with the most players as the main lava lobby. The lookup is
// throttled to once per AUTO_PICK_INTERVAL_MS (the Dispatcher owns the timestamp, so
// the limit holds across Worker isolates); a failed or empty lookup still spends the
// slot, so a broken Teiserver session is retried at most that often too.

import type { IndexLobby } from "./teiserver";

/** Minimum gap between two auto-pick lookups. */
export const AUTO_PICK_INTERVAL_MS = 5 * 60 * 1000;

/** Does a lobby name/title mark it as a lava lobby? */
export function isLavaName(name: string): boolean {
  return name.toLowerCase().includes("lava");
}

/**
 * Pick the main lava lobby from Teiserver's lobby index: the lobby whose name contains
 * "lava" (case-insensitive) with the most players (spectators don't count). Ties keep
 * the earlier entry. `null` when no lobby qualifies.
 */
export function pickLavaLobby(index: IndexLobby[]): IndexLobby | null {
  let best: IndexLobby | null = null;
  for (const lobby of index) {
    if (!isLavaName(lobby.name)) continue;
    if (!best || lobby.playerCount > best.playerCount) best = lobby;
  }
  return best;
}

/** The two Durable Object stubs the auto-pick talks to (narrowed to what it uses). */
export interface AutoPickDeps {
  dispatcher: {
    getConfig(): Promise<{ lava_lobbies: number[] }>;
    setConfig(input: unknown): Promise<unknown>;
    claimAutoPick(minIntervalMs: number, now?: number): Promise<boolean>;
  };
  teiserver: {
    lobbyIndex(): Promise<{ ok: true; lobbies: IndexLobby[] } | { ok: false; error: string }>;
  };
}

/**
 * If no lava lobby is configured, try (at most once per AUTO_PICK_INTERVAL_MS) to pick
 * one from Teiserver and persist it as the sole `lava_lobbies` entry. Returns the
 * resulting config — the updated one when a lobby was picked, otherwise the current
 * one. Never throws: a Teiserver failure just leaves the config as it was.
 */
export async function ensureLavaLobbyConfigured(
  deps: AutoPickDeps,
): Promise<{ lava_lobbies: number[] }> {
  const cfg = await deps.dispatcher.getConfig();
  if (cfg.lava_lobbies.length > 0) return cfg;
  if (!(await deps.dispatcher.claimAutoPick(AUTO_PICK_INTERVAL_MS))) return cfg;
  try {
    const index = await deps.teiserver.lobbyIndex();
    if (!index.ok) {
      console.warn(`[autoLobby] lookup failed: ${index.error}`);
      return cfg;
    }
    const picked = pickLavaLobby(index.lobbies);
    if (!picked) {
      console.log("[autoLobby] no open lobby with 'lava' in its name; nothing configured");
      return cfg;
    }
    await deps.dispatcher.setConfig({ ...cfg, lava_lobbies: [picked.id] });
    console.log(
      `[autoLobby] configured lava lobby #${picked.id} "${picked.name}" (${picked.playerCount} players)`,
    );
    return { ...cfg, lava_lobbies: [picked.id] };
  } catch (e) {
    console.warn(`[autoLobby] lookup failed: ${e instanceof Error ? e.message : e}`);
    return cfg;
  }
}

/**
 * Which battle should the bot auto-join when its container starts? The lobby it
 * was LAST in (persisted by the BotContainer supervisor), as long as Teiserver's
 * index still lists it; otherwise the MAIN lava lobby (the configured one,
 * auto-picking one via ensureLavaLobbyConfigured when nothing is configured).
 * `null` when neither resolves (no last battle, nothing configured, no pick).
 * An index failure keeps the last battle — it is the most recent knowledge, and
 * a join of a really-gone lobby just fails on the protocol. Never throws.
 */
export async function resolveAutoJoinBattle(
  deps: AutoPickDeps,
  lastBattle: number | null,
): Promise<number | null> {
  try {
    if (lastBattle !== null) {
      const index = await deps.teiserver.lobbyIndex();
      if (!index.ok) {
        console.warn(
          `[autoLobby] autojoin index lookup failed, keeping last battle #${lastBattle}: ${index.error}`,
        );
        return lastBattle;
      }
      if (index.lobbies.some((l) => l.id === lastBattle)) return lastBattle;
      console.log(`[autoLobby] last battle #${lastBattle} is gone, falling back to the main lobby`);
    }
    const { lava_lobbies } = await ensureLavaLobbyConfigured(deps);
    return lava_lobbies[0] ?? null;
  } catch (e) {
    console.warn(`[autoLobby] autojoin resolution failed: ${e instanceof Error ? e.message : e}`);
    return lastBattle;
  }
}

/** What adoptLavaLobby needs to know about the lobby being viewed. */
export interface ViewedLobby {
  id: number;
  title: string;
  /** Non-spectator members. */
  playerCount: number;
}

/**
 * Pure decision for adoptLavaLobby: should `viewed` replace the configured lava set?
 * Yes when it is a lava lobby, isn't already configured, and NO configured lobby is
 * still open with players (per Teiserver's index) — the configured lobby is sticky
 * until it is empty or gone. `index` null (lookup failed) → never adopt over an existing
 * config (we can't tell it's gone), but an empty config still adopts.
 */
export function shouldAdopt(
  configured: number[],
  index: IndexLobby[] | null,
  viewed: ViewedLobby,
): boolean {
  if (!isLavaName(viewed.title)) return false;
  if (configured.includes(viewed.id)) return false;
  if (configured.length === 0) return true;
  if (!index) return false;
  const alive = configured.some((id) => {
    const row = index.find((l) => l.id === id);
    return row !== undefined && row.playerCount > 0;
  });
  return !alive;
}

/**
 * Side effect of viewing a lobby (GET /api/lobbies/:id): adopt it as THE configured
 * lava lobby per `shouldAdopt`. Skips the Teiserver lookup entirely in the common cases
 * (not a lava lobby, or already configured). Never throws.
 */
export async function adoptLavaLobby(deps: AutoPickDeps, viewed: ViewedLobby): Promise<boolean> {
  try {
    if (!isLavaName(viewed.title)) return false;
    const cfg = await deps.dispatcher.getConfig();
    if (cfg.lava_lobbies.includes(viewed.id)) return false;
    let index: IndexLobby[] | null = null;
    if (cfg.lava_lobbies.length > 0) {
      const result = await deps.teiserver.lobbyIndex();
      if (result.ok) index = result.lobbies;
      else console.warn(`[autoLobby] index lookup failed, keeping config: ${result.error}`);
    }
    if (!shouldAdopt(cfg.lava_lobbies, index, viewed)) return false;
    await deps.dispatcher.setConfig({ ...cfg, lava_lobbies: [viewed.id] });
    console.log(
      `[autoLobby] adopted lava lobby #${viewed.id} "${viewed.title}" (${viewed.playerCount} players) ` +
        `over [${cfg.lava_lobbies.join(", ")}]`,
    );
    return true;
  } catch (e) {
    console.warn(`[autoLobby] adopt failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}
