// The bot-uploaded game-start roster — the one wire shape shared by the bot's
// uplink (src/bot/uplink.ts), the LosDO's `lobby_states` storage and the
// /api/lobbies/:id substitution.
//
// Why it exists: the lobby keeps changing while a game runs (players leave, new
// ones join and queue), so the live Teiserver scrape stops matching who is
// actually PLAYING. The bot observes the launch precisely (the founder's
// in-game bit going 0→1) and uploads the roster it tracked at that moment;
// the detail view then serves that frozen roster — by default, with
// `?roster=live` for the live lobby — until the game ends.
//
// Pure TypeScript, no `cloudflare:*` / `node:*` — unit-testable in the Node
// pool, importable by the Worker and the container bot alike.

import type { TrackedPlayer } from "./tracker";
import type { TeiserverLobbyPlayer } from "./teiserver";

/** One roster entry as the bot saw it at launch — the tracker's merge, verbatim. */
export type GameStartPlayer = TrackedPlayer;

export interface GameStartSnapshot {
  battleId: number;
  /** Epoch ms when the bot observed the founder's in-game bit go 0→1. */
  startedAt: number;
  /** The FULL tracked roster at launch: players AND spectators. */
  players: GameStartPlayer[];
  /** The battle's founder/title at launch ("" when unknown). */
  founder: string;
  title: string;
  /** Whether the launched teams were the bot's last forced arrangement (null = unknown). */
  botBalanced: boolean | null;
  /** The win chance the bot announced for team 1, if it balanced (null otherwise). */
  predictedFirstWin: number | null;
}

/** The bot's game-over notice; clears the stored snapshot. */
export interface GameEndEvent {
  battleId: number;
  endedAt: number;
  /** "result" = the host's verdict; "ingame-clear" = the founder's in-game bit dropping. */
  reason: "result" | "ingame-clear";
}

/** Snapshots older than this are stale whatever else says (games rarely exceed ~2h). */
export const GAME_START_TTL_MS = 3 * 3600_000;
/**
 * Serve the snapshot this long even while the live lobby still says
 * !inProgress: the teiserver scrape is 5s-cached and the index can lag the
 * launch, while the bot's upload arrives within a second of it. Past the
 * grace, a live !inProgress means the game is over (the fallback clear for a
 * bot that died before sending its game-end).
 */
export const GAME_START_GRACE_MS = 2 * 60_000;

function fail(what: string): never {
  throw new Error(`invalid game-start payload: ${what}`);
}

function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${what} must be a finite number`);
  return v;
}

function numOrNull(v: unknown, what: string): number | null {
  if (v === null || v === undefined) return null;
  return num(v, what);
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") fail(`${what} must be a boolean`);
  return v;
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string") fail(`${what} must be a string`);
  return v;
}

function parsePlayer(v: unknown, i: number): GameStartPlayer {
  if (typeof v !== "object" || v === null) fail(`players[${i}] must be an object`);
  const p = v as Record<string, unknown>;
  const name = str(p.name, `players[${i}].name`);
  if (!name.trim()) fail(`players[${i}].name must be non-empty`);
  return {
    name,
    skill: numOrNull(p.skill, `players[${i}].skill`),
    rank: numOrNull(p.rank, `players[${i}].rank`),
    inGame: bool(p.inGame ?? false, `players[${i}].inGame`),
    away: bool(p.away ?? false, `players[${i}].away`),
    ready: bool(p.ready ?? false, `players[${i}].ready`),
    spectator: bool(p.spectator ?? false, `players[${i}].spectator`),
    sync: num(p.sync ?? 0, `players[${i}].sync`),
    ally: num(p.ally ?? 0, `players[${i}].ally`),
    team: num(p.team ?? 0, `players[${i}].team`),
    boss: bool(p.boss ?? false, `players[${i}].boss`),
    statusKnown: bool(p.statusKnown ?? false, `players[${i}].statusKnown`),
  };
}

/** Strict body validator for POST /api/gamestart. Throws a descriptive Error on garbage. */
export function parseGameStartSnapshot(input: unknown): GameStartSnapshot {
  if (typeof input !== "object" || input === null) fail("body must be an object");
  const b = input as Record<string, unknown>;
  const battleId = num(b.battleId, "battleId");
  if (!Number.isInteger(battleId) || battleId <= 0) fail("battleId must be a positive integer");
  const startedAt = num(b.startedAt, "startedAt");
  if (startedAt <= 0) fail("startedAt must be a positive epoch-ms timestamp");
  if (!Array.isArray(b.players)) fail("players must be an array");
  if (b.players.length > 256) fail("players is implausibly large");
  return {
    battleId,
    startedAt,
    players: b.players.map(parsePlayer),
    founder: str(b.founder ?? "", "founder"),
    title: str(b.title ?? "", "title"),
    botBalanced: b.botBalanced === null || b.botBalanced === undefined ? null : bool(b.botBalanced, "botBalanced"),
    predictedFirstWin: numOrNull(b.predictedFirstWin, "predictedFirstWin"),
  };
}

/**
 * How long after the launch the bot waits before confirming the roster against
 * the players' own in-game bits. Every client that really plays launches the
 * engine within seconds of the host and its CLIENTSTATUS in-game bit goes up.
 */
export const LAUNCH_CONFIRM_MS = 30_000;

/**
 * The launch roster minus the players that never actually went in game.
 *
 * Why: the tracker's roster can hold GHOSTS. For a bot client Teiserver
 * suppresses most LEFTBATTLE broadcasts, so a player who left the lobby without
 * a REMOVESCRIPTTAGS / REMOVEUSER the bot saw lingers on the roster with their
 * last (unready) status. Captured verbatim at the founder's in-game edge, a
 * ghost turned an 8v8 into "8v9" on the lobby page (battle 5775, 2026-11-01:
 * Karakar, unready, sharing team slot 2 with a real player, not in the lobby).
 *
 * Spectators pass through untouched: they don't change the matchup. Returns null
 * when nothing should change: no player dropped, or NO player went in game
 * (the in-game bits were never seen — keep the roster rather than empty it).
 */
export function confirmLaunchRoster<P extends { name: string; spectator: boolean }>(
  players: readonly P[],
  inGame: (name: string) => boolean,
): P[] | null {
  const playing = players.filter((p) => !p.spectator);
  const confirmed = playing.filter((p) => inGame(p.name));
  if (confirmed.length === 0 || confirmed.length === playing.length) return null;
  return players.filter((p) => p.spectator || inGame(p.name));
}

/** Strict body validator for POST /api/gameend. */
export function parseGameEndEvent(input: unknown): GameEndEvent {
  if (typeof input !== "object" || input === null) fail("body must be an object");
  const b = input as Record<string, unknown>;
  const battleId = num(b.battleId, "battleId");
  if (!Number.isInteger(battleId) || battleId <= 0) fail("battleId must be a positive integer");
  const reason = b.reason === "result" || b.reason === "ingame-clear" ? b.reason : null;
  if (!reason) fail(`reason must be "result" or "ingame-clear"`);
  return { battleId, endedAt: num(b.endedAt ?? 0, "endedAt"), reason };
}

/**
 * Is the snapshot the roster to show right now? Fresh = inside the TTL AND the
 * live lobby agrees a game is running — softened by a short grace after launch,
 * covering the scrape-cache lag between the bot's upload and the live
 * `inProgress` flipping. Past the grace, a live !inProgress means the game
 * ended (and the bot's game-end never arrived).
 */
export function snapshotFresh(
  snap: GameStartSnapshot,
  liveInProgress: boolean,
  now: number,
): boolean {
  const age = now - snap.startedAt;
  if (age < 0 || age >= GAME_START_TTL_MS) return false;
  return liveInProgress || age < GAME_START_GRACE_MS;
}

/**
 * Map the snapshot's tracked roster into the lobby-player shape the detail view
 * serves. Every field is launch-time truth from the tracker except `party`,
 * which only Teiserver's show page knows: it is merged from the LIVE roster by
 * lowercased name (null for a player no longer in the lobby). LOS fields are
 * attached later by finalizeLobby, so pills and teamStats stay consistent.
 */
export function substituteRoster(
  snap: GameStartSnapshot,
  live: readonly TeiserverLobbyPlayer[],
): TeiserverLobbyPlayer[] {
  const partyByName = new Map<string, string | null>();
  for (const p of live) partyByName.set(p.name.toLowerCase(), p.party ?? null);
  return snap.players.map((p) => ({
    name: p.name,
    skill: p.skill,
    party: partyByName.get(p.name.toLowerCase()) ?? null,
    rank: p.rank,
    inGame: p.inGame,
    away: p.away,
    ready: p.ready,
    spectator: p.spectator,
    sync: p.sync,
    ally: p.ally,
    team: p.team,
    boss: p.boss,
    statusKnown: p.statusKnown,
  }));
}
