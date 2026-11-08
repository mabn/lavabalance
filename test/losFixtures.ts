// Synthetic ReplayDetail builder for the LOS tests: a minimal-but-valid lava
// 8v8 in the verbatim api.bar-rts.com shape (src/lavaos/types.ts). The tweak
// payload carries two CORE lava signatures ("LavaPack", "Lava QoL"), which
// satisfies the classifier's "≥1 core + ≥2 total" rule.

import type { DetailAllyTeam, DetailPlayer, ReplayDetail } from "../src/lavaos/types";

const LAVA_TWEAKS = btoa("-- LavaPack (Djarshi)\n-- Lava QoL tweaks\n");

export interface FixtureOpts {
  id: string;
  startTime: string;
  /** userIds of team 0 then team 1 (8 each by default). */
  teams?: [number[], number[]];
  /** Which team wins (default 0); null = no winner (unrateable). */
  winner?: number | null;
  durationMs?: number;
  endedNormally?: boolean;
  hasBots?: boolean;
  mapName?: string;
  /** Overrides the lava tweak payload (e.g. {} = not a lava game). */
  gameSettings?: Record<string, unknown>;
  /** The startmetalstorage modoption (default "4000", the rated value);
   * null leaves it out. Ignored when gameSettings is given. */
  startMetalStorage?: string | null;
  /** Per-userId lobby-shown skill strings, e.g. {101: "[30.9]"}. */
  skills?: Record<number, string>;
  /** Per-userId chevron levels, e.g. {101: 5}. Absent = the API's own null.
   * Note 0 is a real level, so `ranks` must be consulted with `in`. */
  ranks?: Record<number, number>;
}

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

export function lavaReplay(opts: FixtureOpts): ReplayDetail {
  const teams = opts.teams ?? [range(101, 8), range(201, 8)];
  const winner = opts.winner === undefined ? 0 : opts.winner;
  const allyTeams: DetailAllyTeam[] = teams.map((userIds, ti) => ({
    id: ti,
    allyTeamId: ti,
    startBox: null,
    winningTeam: winner === ti,
    AIs: [],
    Players: userIds.map(
      (userId, pi): DetailPlayer => ({
        id: ti * 100 + pi,
        playerId: ti * 8 + pi,
        name: `player${userId}`,
        teamId: ti * 8 + pi,
        handicap: 0,
        faction: ti === 0 ? "Cortex" : "Armada",
        countryCode: null,
        rgbColor: null,
        rank: opts.ranks && userId in opts.ranks ? opts.ranks[userId] : null,
        skillUncertainty: null,
        skill: opts.skills?.[userId] ?? null,
        trueSkill: null,
        startPos: null,
        clanId: null,
        allyTeamId: 5_000_000 + ti, // deliberately an API-internal row id, NOT 0/1
        userId,
      }),
    ),
  }));
  return {
    id: opts.id,
    fileName: `${opts.id}.sdfz`,
    engineVersion: "2026.01.10",
    gameVersion: "BAR test $VERSION",
    startTime: opts.startTime,
    durationMs: opts.durationMs ?? 20 * 60_000,
    fullDurationMs: opts.durationMs ?? 20 * 60_000,
    hostSettings: {},
    gameSettings: opts.gameSettings ?? {
      tweakdefs1: LAVA_TWEAKS,
      ...(opts.startMetalStorage === null ? {} : { startmetalstorage: opts.startMetalStorage ?? "4000" }),
    },
    mapSettings: {},
    spadsSettings: null,
    gameEndedNormally: opts.endedNormally ?? true,
    hasBots: opts.hasBots ?? false,
    preset: "team",
    reported: false,
    awards: null,
    createdAt: opts.startTime,
    updatedAt: opts.startTime,
    mapId: 1,
    Map: { fileName: null, scriptName: opts.mapName ?? "Supreme Isthmus v2.1" },
    Spectators: [],
    AllyTeams: allyTeams,
  };
}
