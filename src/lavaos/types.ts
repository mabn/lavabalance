// Shapes of the api.bar-rts.com replay endpoints, as observed live (2026-08).
// The scraper stores detail responses verbatim, so these types describe the
// on-disk day files too. Fields the rating code doesn't need are typed
// loosely on purpose — the API is not ours and drifts.

/** GET /replays — one page of the replay list. */
export interface ReplayListPage {
  /** -1: the API has result counting disabled; paginate until a short page. */
  totalResults: number;
  page: number;
  limit: number;
  data: ReplaySummary[];
}

export interface ReplaySummary {
  id: string;
  /** ISO-8601 UTC, e.g. "2026-08-15T20:43:04.000Z". */
  startTime: string;
  durationMs: number;
  Map: ReplayMap;
  AllyTeams: SummaryAllyTeam[];
}

export interface ReplayMap {
  fileName: string | null;
  /** Display name, e.g. "Supreme Isthmus v2.1". */
  scriptName: string;
}

export interface SummaryAllyTeam {
  winningTeam: boolean;
  Players: { name: string }[];
  AIs: { shortName: string }[];
}

/** GET /replays/:id — the full replay detail (stored verbatim per game). */
export interface ReplayDetail {
  id: string;
  fileName: string;
  engineVersion: string;
  gameVersion: string;
  startTime: string;
  durationMs: number;
  fullDurationMs: number;
  hostSettings: Record<string, unknown>;
  gameSettings: Record<string, unknown>;
  mapSettings: Record<string, unknown>;
  spadsSettings: Record<string, unknown> | null;
  gameEndedNormally: boolean;
  hasBots: boolean;
  /** e.g. "duel" | "team" | "ffa". */
  preset: string | null;
  reported: boolean;
  awards: unknown;
  createdAt: string;
  updatedAt: string;
  mapId: number;
  Map: ReplayMap;
  Spectators: unknown[];
  AllyTeams: DetailAllyTeam[];
  /** EXTRA top-level fields barreplay's lava sync rides on the verbatim
   * detail when its teiserver poll matched a lobby onto the game (the BAR
   * API reply carries neither key): the lobby's name and its observed
   * detail — locked/passworded/member counts plus the per-player roster
   * with party keys. Typed loosely on purpose — the shape is barreplay's
   * (worker/src/worker/teiserver.ts LobbyDetails) and is stored verbatim. */
  lobbyName?: string | null;
  lobbyDetails?: unknown;
}

export interface DetailAllyTeam {
  id: number;
  allyTeamId: number;
  startBox: unknown;
  winningTeam: boolean;
  Players: DetailPlayer[];
  AIs: unknown[];
}

export interface DetailPlayer {
  id: number;
  playerId: number;
  /** Lobby name at game time — may change between games; prefer userId. */
  name: string;
  teamId: number;
  handicap: number;
  faction: string;
  countryCode: string | null;
  rgbColor: { r: number; g: number; b: number } | null;
  rank: number | null;
  skillUncertainty: number | null;
  /** Bracketed OpenSkill string as shown in the lobby, e.g. "[12.93]". */
  skill: string | null;
  trueSkill: number | null;
  startPos: { x: number; y: number; z: number } | null;
  clanId: number | null;
  allyTeamId: number;
  /** Stable BAR account id — the player identity for rating work. */
  userId: number;
}
