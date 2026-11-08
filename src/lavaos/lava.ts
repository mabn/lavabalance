// Identifying "lava games" — games hosted by the Supreme LAVA lobby — in
// scraped replay details, plus the eligibility rules for LOS rating.
//
// The replay data carries no lobby title, so the lobby is recognized by its
// tweak stack: the lava lobby runs a large tweakdefs/tweakunits set
// whose file headers are stable
// across versions even as the bodies change. A game counts as lava when its
// decoded tweaks contain a core lava signature ("LavaPack", "Lava QoL",
// "Lava Sky Ops") plus at least one other known signature — individual files
// like OneBigNuke circulate in other lobbies too, so one hit is not enough.

import { BETA, phiMajor, type Rating } from "./openskill";
import type { ReplayDetail } from "./types";

/**
 * Rookie handicap: players in their first lava games perform well below the
 * rating the model assumes for them, and lava skill is uncorrelated with BAR
 * OS and BAR rank (hours played), so no seed helps. A flat lower starting mu
 * can NOT express this — OpenSkill is invariant under shifting every
 * player's mu equally — so instead a player's mu is temporarily discounted,
 * relative to the pool, wherever team strength is computed (rate() inputs
 * and predictWin) while they are new. The handicap is display- and
 * storage-invisible: the stored mu stays the undiscounted estimate.
 *
 * The curve: ROOKIE_MU_HANDICAP_START · e^(−priorGames / ROOKIE_MU_HANDICAP_DECAY)
 * for the first ROOKIE_MU_HANDICAP_GAMES games, then 0. 13 mu in a player's
 * first game, ~11.1 in their fifth, ~9.1 in their tenth, ~6.1 in their
 * twentieth, ~3.3 in their thirty-fifth.
 *
 * CHANGE 2026-09-27 (ALGO_VERSION 3). Version 2 (8.5·e^(−prior/15) over 20
 * games, 2026-09-16) was fitted by applying each candidate curve at
 * prediction time to ratings already folded under the old one, so a bigger
 * discount never got to change how much mu rookies lose. On the games since
 * 2026-09-04 it still left each extra player in their first 20 games costing
 * their side ~4 pp of win rate beyond the prediction (t = −2.6). Refolding
 * the whole history for every candidate and scoring every outcome gives this
 * curve; a leave-one-month-out fit chose it (A 13–14) in every month, beat v2
 * in 9 of 10 months and cut pooled log-loss 0.489 → 0.483. It shrinks the
 * September rookie-count effect to ~1.5 pp per extra rookie (t = −0.9). The
 * per-player β stays as it is: held-out September calibrates at slope 0.98
 * with it. Details: docs/los-rookie-handicap-2026-09-27.md.
 *
 * CHANGE 2026-09-16 (ALGO_VERSION 2). The first fit (Aug 2026, 602 games)
 * was 3.9 / 3.4 / 2.4 for games 1–3 and nothing after. With the full
 * history (4,204 games with complete ratings, Jan–Sep 2026) that turned out
 * too small and too short: in near-even games a side with one extra player
 * in their first ten lava games won 39%, with two extra 30%, and the
 * residual per player-game was −2 pp in games 4–10 and +3 pp in games
 * 21–200. v2 was fitted by maximum likelihood on Jun–Aug.
 * Details: docs/los-rookie-handicap-2026-09-16.md. Any change here changes
 * every stored rating: bump ALGO_VERSION and refold (rebase from the first
 * game, or reset + re-upload).
 */
export const ROOKIE_MU_HANDICAP_START = 13;
export const ROOKIE_MU_HANDICAP_DECAY = 25;
export const ROOKIE_MU_HANDICAP_GAMES = 35;

export function rookieHandicap(priorGames: number): number {
  if (!(priorGames >= 0) || priorGames >= ROOKIE_MU_HANDICAP_GAMES) return 0;
  return ROOKIE_MU_HANDICAP_START * Math.exp(-priorGames / ROOKIE_MU_HANDICAP_DECAY);
}

/** The rating to feed into rate()/predictWin() for a player with this many
 * prior rated lava games. */
export function losEffectiveRating(r: Rating, priorGames: number): Rating {
  return { mu: r.mu - rookieHandicap(priorGames), sigma: r.sigma };
}

/** One team's summed effective rating: Σμ, Σσ² and how many players made it. */
export interface TeamSum {
  mu: number;
  variance: number;
  players: number;
}

/**
 * P(team a beats team b) — the LOS win predictor, from the two teams' sums.
 * `predictWin` below is the member-list form; the balancer calls this one
 * with group sums, so it must only ever consume the sums plus the player
 * count. See `predictWin` for what differs from the library and why.
 */
export function predictWinFromSums(a: TeamSum, b: TeamSum): number {
  return phiMajor(
    (a.mu - b.mu) / Math.sqrt((a.players + b.players) * BETA * BETA + a.variance + b.variance),
  );
}

/**
 * Win probability per team, in team order, over member ratings (already
 * rookie-handicapped by the caller). Two teams: [P(a), 1−P(a)]. More teams:
 * the library's pairwise average. This is THE win chance LOS shows and
 * balances with: the API's `predictedWin` for every game (computed on read
 * from the stored pre-game ratings, so a change here re-scores past games),
 * the lobby matchup strip, the bot's announcement, and the balancer's
 * objective.
 *
 * CHANGE 2026-09-15 — not the library's formula any more. openskill's
 * predict_win is Φ((μ_a−μ_b)/√(n·β² + σ_a² + σ_b²)) with n = number of
 * TEAMS, i.e. it adds β² (one player's game-to-game performance variance)
 * once per team, 2β² ≈ 35 for any 2-team game. That is right for a 1v1; in
 * an 8v8 the sixteen σ² terms add ~400 and the β term all but vanishes, so a
 * 20-point μ gap read as a near certainty. Measured over Aug 15 – Sep 15
 * 2026 (393 games): predictions of 90%+ won 94.5%, calibration slope 0.80
 * (1 = tuned). This version adds β² once per PLAYER, (|a|+|b|)·β² = 16β²
 * for an 8v8, which is what independent per-player performance noise
 * implies: 90%+ predictions then win 96.1%, slope 0.93. Details and the
 * variants tried: docs/los-calibration-2026-09.md. The library-exact form
 * survives as `predictWinLib` in openskill.ts for the test-vector pin.
 * Only the shown/optimised chance changed: rate() never used this, so
 * stored ratings are identical, and the balancer still picks the same split
 * (the change is monotone and every split of a lobby has the same player
 * count).
 */
export function predictWin(teams: Rating[][]): number[] {
  const sums: TeamSum[] = teams.map((t) => ({
    mu: t.reduce((s, r) => s + r.mu, 0),
    variance: t.reduce((s, r) => s + r.sigma * r.sigma, 0),
    players: t.length,
  }));
  const n = sums.length;
  const pairs = (n * (n - 1)) / 2;
  return sums.map((a, i) => {
    let sum = 0;
    for (let q = 0; q < n; q++) if (q !== i) sum += predictWinFromSums(a, sums[q]);
    return sum / pairs;
  });
}

const CORE_SIGNATURES = ["lavapack", "lava qol", "lava sky ops"];
const EXTRA_SIGNATURES = [
  "onebignuke",
  "riot titan",
  "roomba",
  "tacmissilenerf",
  "legendary converter",
];

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Lenient base64 → latin1 text. Some API values have corrupted padding
 * (length ≡ 1 mod 4), which strict decoders reject; skipping every
 * non-alphabet character and emitting whatever full bytes accumulate handles
 * that naturally. Dependency-free so the Worker can use it (no Buffer, and
 * the signature search below only needs ASCII to survive decoding). */
function b64ToText(v: string): string {
  let out = "";
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < v.length; i++) {
    const x = B64.indexOf(v[i]);
    if (x < 0) continue;
    buf = (buf << 6) | x;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buf >> bits) & 0xff);
    }
  }
  return out;
}

/** Decoded text of every non-empty tweakdefs/tweakunits slot, lowercased. */
function decodedTweaks(replay: ReplayDetail): string {
  const gs = replay.gameSettings ?? {};
  const parts: string[] = [];
  for (const [key, value] of Object.entries(gs)) {
    if (!/tweak(defs|units)/.test(key)) continue;
    if (typeof value !== "string" || value === "" || value === "0") continue;
    parts.push(b64ToText(value));
  }
  return parts.join("\n").toLowerCase();
}

export function isLavaGame(replay: ReplayDetail): boolean {
  const text = decodedTweaks(replay);
  if (!text) return false;
  const core = CORE_SIGNATURES.filter((s) => text.includes(s)).length;
  const extra = EXTRA_SIGNATURES.filter((s) => text.includes(s)).length;
  return core >= 1 && core + extra >= 2;
}

/** Whether the game ran on the map the RATING is defined over. Any Supreme
 * Isthmus version counts (the scrape is pinned to v2.1 today, but a map
 * update shouldn't silently split the rating history). Split out of
 * unrateableReason because it does not drop a game (nor does the start-metal
 * rule below): an off-map lava game meeting every OTHER rule is stored
 * unranked (status "ignored") rather than skipped — see classifyReplay. */
export function onRatedMap(replay: ReplayDetail): boolean {
  return isRatedMapName(replay.Map?.scriptName);
}

/** The same rule over a stored map name — what LosDO.rebase judges by, since
 * a stored game's reason label can be wrong (a backfill once labelled off-map
 * rows "uploaded too late") but its map cannot. One predicate, two callers. */
export function isRatedMapName(map: string | null | undefined): boolean {
  return map?.startsWith("Supreme Isthmus") ?? false;
}

/** Why a lava game is excluded from rating, or null if it is rateable.
 * The map rule, eligibilityReason and the start-metal rule — what the RATED fold gates
 * on, and tools/lavaos/los.ts (the offline verification oracle) uses it
 * unchanged, so the rated set cannot drift between the two consumers. */
export function unrateableReason(replay: ReplayDetail): string | null {
  if (!onRatedMap(replay)) return "wrong map";
  return eligibilityReason(replay) ?? startMetalReason(replay.startTime, startMetalStorage(replay));
}

/**
 * The start-metal-storage rule (2026-10-12, ALGO_VERSION 4): from
 * START_METAL_RULE_FROM on, a game is rated only when it started with
 * REQUIRED_START_METAL_STORAGE metal storage (the lava lobby's standard
 * `startmetalstorage` modoption); before it, every value counts, as it
 * always did. Like the map rule this does not drop the game: one that passes
 * every other rule is stored unranked (reason "start metal storage") — see
 * classifyReplay. A game from the cutoff on whose replay carries no value at
 * all is malformed for this purpose and skipped (`eligibilityReason`).
 */
export const START_METAL_RULE_FROM = "2026-10-01T00:00:00.000Z";
export const REQUIRED_START_METAL_STORAGE = 4000;

/** The `startmetalstorage` modoption (a string in gameSettings, e.g. "4000"),
 * or null when the replay carries none or it is not a number. */
export function startMetalStorage(replay: ReplayDetail): number | null {
  const v = replay.gameSettings?.startmetalstorage;
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Whether a game's start time falls under the start-metal rule. ISO-8601 UTC
 * instants, so the string compare is the time compare. */
export function underStartMetalRule(startTime: string): boolean {
  return startTime >= START_METAL_RULE_FROM;
}

/** Why the start-metal rule leaves a game unrated, or null when it does not.
 * Over a start time and a value rather than a replay so the rebase can judge a
 * stored row by the same predicate; a null value under the rule fails. */
export function startMetalReason(startTime: string, storage: number | null): string | null {
  if (!underStartMetalRule(startTime)) return null;
  if (storage == null) return "no start metal storage";
  return storage === REQUIRED_START_METAL_STORAGE ? null : "start metal storage";
}

/** The map-independent eligibility rules, or null when they all pass.
 * Mirrors Teiserver's MatchRatingLib.rate_match checks — except the
 * ranked_game modoption, which is deliberately ignored: tweaked (lava) games
 * are exactly the unranked games this rating exists for. A game failing
 * these is malformed for ANY purpose (rating or unranked storage), which is
 * what separates them from the map rule above. */
export function eligibilityReason(replay: ReplayDetail): string | null {
  const teams = (replay.AllyTeams ?? []).filter(
    (t) => (t.Players?.length ?? 0) > 0 || (t.AIs?.length ?? 0) > 0,
  );
  if (teams.length !== 2) return "not 2 teams";
  if (teams.some((t) => (t.AIs?.length ?? 0) > 0) || replay.hasBots) return "has bots";
  const winners = teams.filter((t) => t.winningTeam);
  if (winners.length !== 1) return "no winning team";
  if (teams.some((t) => t.Players.length !== 8)) return "not 8v8";
  if (!replay.gameEndedNormally) return "did not end normally";
  // Stricter than BAR's own 90s ("matchmaking.Time to treat game as ranked"):
  // real lava 8v8s run 10min+, so anything shorter is a rush-kill oddity or a
  // mass resign we'd rather not rate.
  if (replay.durationMs < 6 * 60_000) return "too short";
  // Under the start-metal rule the value must at least be THERE: a replay
  // without it cannot be judged, by the upload or by any later rebase.
  if (underStartMetalRule(replay.startTime) && startMetalStorage(replay) == null) {
    return "no start metal storage";
  }
  return null;
}
