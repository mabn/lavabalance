// Local team balancer — party-aware, LOS-native.
//
// Historically this reproduced Lavabar's /api/balance split (minimise the gap in
// average elo; see CLAUDE.md "How Lavabar's /api/balance picks the teams" for the
// reverse-engineering record). Since the bot switched to LOS, the objective is the
// rating model's own: pick the split whose OpenSkill **predictWin is closest to
// 50/50**, computed over every player's μ/σ with the rookie handicap applied —
// exactly the predictor the LOS fold is calibrated with (and the same one the web
// UI's matchup strip shows). The size rule is kept from before:
//   1. minimise |sizeA − sizeB|   (Lavabar's hard ⌈n/2⌉/⌊n/2⌋ rule, when parties allow)
//   2. then minimise |P(team A wins) − ½|
//
// PARTIES: players in a party must land on the same team, so the search runs over
// subsets of GROUPS (one per party + a singleton per unpartied player). Exhaustive:
// 2^g halved by pinning the first group — ≤32k combos for a 16-player lobby, and a
// candidate's win probability is O(1) from the groups' summed μ / σ². Parties can
// make an even split unreachable (a party of 3 among 4 forces 3v1), hence the
// lexicographic objective; `sizeCompromised` flags when the ideal sizes were lost.
//
// AVOIDS: players who asked not to be teamed with each other (src/avoids.ts) are
// a SOFT constraint on the same search — the split that honours the most of them
// wins, but only among candidates whose win chance still lands inside
// AVOID_WIN_BAND (40-60%). A lobby where keeping two people apart would skew the
// match past that band is balanced as if nobody had asked, and the result says so
// (`avoid.skippedForBalance`): a fair game comes first.
//
// ROOKIES: a TIE-BREAK after all of the above. Among the splits whose win chance
// is within ROOKIE_SPLIT_TOLERANCE (2 pp) of the chosen one — same team sizes, no
// more avoid pairs left together — the one splitting the unpartied players in
// their first ROOKIE_SPLIT_GAMES rated games most evenly wins. The rookie
// handicap already prices them in; this hedges against a cohort weaker than the
// handicap assumes, at almost no cost in balance (2026-09-27 analysis:
// docs/los-rookie-handicap-2026-09-27.md).

import { avoidKey, type AvoidPair } from "../avoids";
import { losEffectiveRating, predictWinFromSums, rookieHandicap } from "../lavaos/lava";
import { MU, SIGMA } from "../lavaos/openskill";
import { losOf, shownLosOf as shownLosOfState } from "../los/losGames";

/** A player's current LOS rating state (mu/sigma/rated-game count). */
export interface LosState {
  mu: number;
  sigma: number;
  games: number;
}

/** The state assumed for a player with no rated lava game: a debutant. */
export const UNRATED_STATE: LosState = { mu: MU, sigma: SIGMA, games: 0 };

/**
 * The LOS shown/averaged for an unrated player: a debutant's effective rating
 * (μ discounted by the game-0 rookie handicap, minus σ) ≈ 3.7. Matches
 * UNRATED_LOS in src/lobbyView.ts, which governs the website the same way.
 */
export const UNRATED_LOS = losOf(MU - rookieHandicap(0), SIGMA);

export interface BalancePlayer {
  name: string;
  /** LOS rating state; null/undefined (never rated) ⇒ a debutant is assumed. */
  rating?: LosState | null;
  /**
   * Party identifier. Players sharing a non-empty partyId are kept together;
   * null/undefined means the player is unpartied (their own group of one).
   */
  partyId?: string | null;
}

export interface BalanceTeam {
  players: BalancePlayer[];
  /** Mean shown LOS (unrated counted as UNRATED_LOS) — the display value. */
  avg: number;
}

export interface BalanceResult {
  teamA: BalanceTeam;
  teamB: BalanceTeam;
  /** P(team A wins) under OpenSkill predictWin; the objective drives this to ½. */
  winProbA: number;
  /** |teamA.avg − teamB.avg| in LOS — informational, not the objective. */
  deviation: number;
  /** Names with no rating, counted as debutants. */
  unrated: string[];
  /** True when the party sizes prevented the ideal ⌈n/2⌉/⌊n/2⌋ split. */
  sizeCompromised: boolean;
  /**
   * True when keeping the parties together was too imbalanced (either side's
   * win chance above PARTY_SPLIT_MAX_WIN) and the returned split ignores them
   * — see balanceTeamsWithPartySplit. balanceTeams itself never sets it.
   */
  partiesIgnored: boolean;
  /** What became of the avoid requests this lobby carries. */
  avoid: AvoidOutcome;
  /** How the chosen split spreads the rookies (see ROOKIE_SPLIT_GAMES). */
  rookies: RookieOutcome;
}

/** The rookie tie-break's view of the chosen split. */
export interface RookieOutcome {
  /** Unpartied players with fewer than ROOKIE_SPLIT_GAMES rated games (unrated included). */
  count: number;
  /** |rookies on team A − rookies on team B| in the chosen split. */
  gap: number;
  /** True when the tie-break moved the pick off the best-balanced split. */
  tieBreak: boolean;
}

/** How the chosen split treated the avoid requests (src/avoids.ts). */
export interface AvoidOutcome {
  /** The pairs that applied here: both people in the lobby, deduplicated. */
  requested: AvoidPair[];
  /** Of those, the ones the chosen split puts on opposite teams. */
  honoured: AvoidPair[];
  /** Of those, the ones it still leaves together. */
  violated: AvoidPair[];
  /** True when honouring them is what picked this split over the pure-balance one. */
  applied: boolean;
  /**
   * True when a split honouring MORE of them exists but its win chance falls
   * outside AVOID_WIN_BAND — the requests were dropped to keep the game fair.
   */
  skippedForBalance: boolean;
}

/**
 * The win-chance band an avoid-honouring split has to stay inside. Outside it
 * the avoid requests are dropped and the lobby is balanced as if nobody had
 * asked: a 70/30 game to keep two people apart is not a trade worth making.
 */
export const AVOID_WIN_MIN = 0.4;
export const AVOID_WIN_MAX = 0.6;

/**
 * The rookie tie-break (see the header): a player counts as a rookie while they
 * have fewer than ROOKIE_SPLIT_GAMES rated lava games, and a split may trade up
 * to ROOKIE_SPLIT_TOLERANCE of win chance (0.02 = 2 pp) for a more even
 * spread of them. Party members are exempt: they go where their party goes.
 */
export const ROOKIE_SPLIT_GAMES = 10;
export const ROOKIE_SPLIT_TOLERANCE = 0.02;

const NO_ROOKIES: RookieOutcome = { count: 0, gap: 0, tieBreak: false };

export interface BalanceOptions {
  /**
   * Pairs to keep on opposite teams, LOWERCASED (src/avoids.ts avoidPairsOf).
   * A soft constraint — see AVOID_WIN_MIN/MAX.
   */
  avoid?: readonly AvoidPair[];
}

const NO_AVOIDS: AvoidOutcome = {
  requested: [],
  honoured: [],
  violated: [],
  applied: false,
  skippedForBalance: false,
};

/** One candidate split, as the search scores it. */
interface Candidate {
  sizeGap: number;
  /** Avoid pairs this split leaves on the same team. */
  violations: number;
  imbalance: number;
  /** |rookies on A − rookies on B| (unpartied rookies only). */
  rookieGap: number;
  /** P(team A wins) — kept so the tie-break can re-check the avoid band. */
  winA: number;
  mask: number;
}

/** Lexicographic (sizeGap, violations, imbalance) — the avoid-aware objective. */
function betterWithAvoids(c: Candidate, best: Candidate | null): boolean {
  if (best === null) return true;
  if (c.sizeGap !== best.sizeGap) return c.sizeGap < best.sizeGap;
  if (c.violations !== best.violations) return c.violations < best.violations;
  return c.imbalance < best.imbalance;
}

/** Lexicographic (sizeGap, imbalance) — the objective with no avoids in it. */
function betterPlain(c: Candidate, best: Candidate | null): boolean {
  if (best === null) return true;
  if (c.sizeGap !== best.sizeGap) return c.sizeGap < best.sizeGap;
  return c.imbalance < best.imbalance;
}

/**
 * The win chance above which a party-constrained split is abandoned and the
 * lobby is re-balanced with parties ignored (balanceTeamsWithPartySplit).
 */
export const PARTY_SPLIT_MAX_WIN = 0.75;

/** One party (or a lone player) treated as an indivisible unit. */
interface Group {
  players: BalancePlayer[];
  /** Σ effective μ (rookie-handicapped) over members. */
  effMu: number;
  /** Σ effective σ² over members. */
  effVar: number;
  /** Σ shown LOS over members (unrated as UNRATED_LOS). */
  shownLos: number;
  weight: number;
  /** Unpartied members still counting as rookies (0 for a party). */
  rookies: number;
}

const stateOf = (p: BalancePlayer): LosState =>
  p.rating && Number.isFinite(p.rating.mu) && Number.isFinite(p.rating.sigma)
    ? p.rating
    : UNRATED_STATE;

const isRookie = (p: BalancePlayer): boolean => stateOf(p).games < ROOKIE_SPLIT_GAMES;

const shownLosOf = (p: BalancePlayer): number => {
  const s = stateOf(p);
  return s === UNRATED_STATE ? UNRATED_LOS : shownLosOfState(s.mu, s.sigma, s.games);
};

/**
 * P(a beats b) for two member lists given as (effective μ, effective σ²) sums
 * and player counts — the LOS predictor, which only ever consumes those.
 */
function winProbOf(
  muA: number,
  varA: number,
  nA: number,
  muB: number,
  varB: number,
  nB: number,
): number {
  return predictWinFromSums(
    { mu: muA, variance: varA, players: nA },
    { mu: muB, variance: varB, players: nB },
  );
}

/**
 * Collapse players into indivisible groups: one per party, plus a singleton per
 * unpartied player. Group order follows first appearance so the result is a
 * deterministic function of the input.
 */
function toGroups(players: BalancePlayer[]): Group[] {
  const byParty = new Map<string, Group>();
  const groups: Group[] = [];
  for (const p of players) {
    const eff = losEffectiveRating(stateOf(p), stateOf(p).games);
    const contrib = {
      effMu: eff.mu,
      effVar: eff.sigma * eff.sigma,
      shownLos: shownLosOf(p),
    };
    const party = (p.partyId ?? "").trim();
    if (!party) {
      groups.push({ players: [p], weight: 1, rookies: isRookie(p) ? 1 : 0, ...contrib });
      continue;
    }
    const existing = byParty.get(party);
    if (existing) {
      existing.players.push(p);
      existing.effMu += contrib.effMu;
      existing.effVar += contrib.effVar;
      existing.shownLos += contrib.shownLos;
      existing.weight += 1;
    } else {
      const g: Group = { players: [p], weight: 1, rookies: 0, ...contrib };
      byParty.set(party, g);
      groups.push(g);
    }
  }
  return groups;
}

function makeTeam(groups: Group[]): BalanceTeam {
  const players = groups.flatMap((g) => g.players);
  const shown = groups.reduce((s, g) => s + g.shownLos, 0);
  return { players, avg: players.length ? shown / players.length : 0 };
}

/**
 * The avoid pairs that actually apply to this lobby: both people present,
 * deduplicated, ordered — the shape the outcome reports and the search counts.
 */
function applicablePairs(
  pairs: readonly AvoidPair[],
  players: BalancePlayer[],
): AvoidPair[] {
  const present = new Set(players.map((p) => avoidKey(p.name)));
  const seen = new Set<string>();
  const out: AvoidPair[] = [];
  for (const raw of pairs) {
    const a = avoidKey(raw.a);
    const b = avoidKey(raw.b);
    if (!a || !b || a === b) continue;
    if (!present.has(a) || !present.has(b)) continue;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${lo}\u0000${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a: lo, b: hi });
  }
  return out;
}

/** Whether a split puts both sides of a pair on the same team. */
const sameSide = (mask: number, gi: number, gj: number): boolean =>
  ((mask >> gi) & 1) === ((mask >> gj) & 1);

/**
 * Split `players` into two teams, keeping parties intact, minimising first the
 * size imbalance and then the distance of the OpenSkill win probability from ½.
 *
 * `opts.avoid` adds the soft avoid constraint: among the candidates whose win
 * chance stays inside [AVOID_WIN_MIN, AVOID_WIN_MAX] the one leaving the fewest
 * avoid pairs together wins, and only if it beats what pure balance would have
 * done anyway. When no such candidate exists the pure-balance split is returned
 * with `avoid.skippedForBalance` set.
 */
export function balanceTeams(players: BalancePlayer[], opts: BalanceOptions = {}): BalanceResult {
  const unrated = players
    .filter((p) => !(p.rating && Number.isFinite(p.rating.mu) && Number.isFinite(p.rating.sigma)))
    .map((p) => p.name);
  if (players.length < 2) {
    const only = makeTeam(toGroups(players));
    const empty: BalanceTeam = { players: [], avg: 0 };
    return {
      teamA: only,
      teamB: empty,
      winProbA: 1,
      deviation: 0,
      unrated,
      sizeCompromised: false,
      partiesIgnored: false,
      avoid: NO_AVOIDS,
      rookies: NO_ROOKIES,
    };
  }

  const groups = toGroups(players);
  const n = players.length;
  const totalMu = groups.reduce((s, g) => s + g.effMu, 0);
  const totalVar = groups.reduce((s, g) => s + g.effVar, 0);
  const totalRookies = groups.reduce((s, g) => s + g.rookies, 0);

  // Avoid pairs as GROUP indices: a pair inside one party can never be split,
  // and is counted as a violation of every candidate rather than dropped — the
  // outcome then reports honestly that it was not honoured.
  const requested = applicablePairs(opts.avoid ?? [], players);
  const groupOfName = new Map<string, number>();
  groups.forEach((g, i) => g.players.forEach((p) => groupOfName.set(avoidKey(p.name), i)));
  const pairGroups = requested.map((pair) => [
    groupOfName.get(pair.a) ?? -1,
    groupOfName.get(pair.b) ?? -1,
  ]);

  // Three bests over the same enumeration: what pure balance would pick, the
  // best avoid-aware split INSIDE the win band (the only one we may act on),
  // and the best avoid-aware split at all — which is what tells us whether
  // dropping the requests was the band's doing (skippedForBalance).
  let bestPlain: Candidate | null = null;
  let bestAvoidInBand: Candidate | null = null;
  let bestAvoidAnywhere: Candidate | null = null;
  // Every candidate, for the rookie tie-break once the pick is known.
  const candidates: Candidate[] = [];
  // Pin group 0 to team A: every split is then counted once instead of twice.
  const combos = 1 << (groups.length - 1);
  for (let bits = 0; bits < combos; bits++) {
    const mask = (bits << 1) | 1;
    let weightA = 0;
    let muA = 0;
    let varA = 0;
    let rookiesA = 0;
    for (let i = 0; i < groups.length; i++) {
      if (mask & (1 << i)) {
        weightA += groups[i].weight;
        muA += groups[i].effMu;
        varA += groups[i].effVar;
        rookiesA += groups[i].rookies;
      }
    }
    const weightB = n - weightA;
    if (weightB === 0) continue; // everyone on one side is not a split
    const winA = winProbOf(muA, varA, weightA, totalMu - muA, totalVar - varA, weightB);
    let violations = 0;
    for (const [gi, gj] of pairGroups) if (sameSide(mask, gi, gj)) violations++;
    const candidate: Candidate = {
      sizeGap: Math.abs(weightA - weightB),
      violations,
      imbalance: Math.abs(winA - 0.5),
      rookieGap: Math.abs(2 * rookiesA - totalRookies),
      winA,
      mask,
    };
    if (totalRookies > 1) candidates.push(candidate);
    if (betterPlain(candidate, bestPlain)) bestPlain = candidate;
    if (pairGroups.length === 0) continue;
    if (betterWithAvoids(candidate, bestAvoidAnywhere)) bestAvoidAnywhere = candidate;
    if (winA >= AVOID_WIN_MIN && winA <= AVOID_WIN_MAX) {
      if (betterWithAvoids(candidate, bestAvoidInBand)) bestAvoidInBand = candidate;
    }
  }

  if (bestPlain === null) {
    // No legal split exists — every player is in one party, so they all play
    // together and there is no second team to balance against.
    const only = makeTeam(groups);
    const empty: BalanceTeam = { players: [], avg: 0 };
    return {
      teamA: only,
      teamB: empty,
      winProbA: 1,
      deviation: 0,
      unrated,
      sizeCompromised: true,
      partiesIgnored: false,
      avoid: { ...NO_AVOIDS, requested, violated: requested },
      rookies: NO_ROOKIES,
    };
  }

  // Honour the requests only when a split inside the band does better than the
  // one balance alone would have chosen; otherwise the lobby is balanced as if
  // nobody had asked.
  // Never at the cost of the team SIZES: bestPlain holds the smallest size gap
  // there is, so an in-band candidate that needs a bigger one (a 3v1 that
  // happens to land in the band) is not a trade an avoid request may make.
  const applied =
    bestAvoidInBand !== null &&
    bestAvoidInBand.violations < bestPlain.violations &&
    bestAvoidInBand.sizeGap <= bestPlain.sizeGap;
  const balanced = applied && bestAvoidInBand !== null ? bestAvoidInBand : bestPlain;
  const skippedForBalance =
    bestAvoidAnywhere !== null && balanced.violations > bestAvoidAnywhere.violations;

  // The rookie tie-break: within ROOKIE_SPLIT_TOLERANCE of the balanced pick's
  // win chance, never at the cost of the team sizes, an avoid pair, or (when
  // the avoids decided the pick) the avoid band, spread the rookies most evenly.
  let chosen = balanced;
  for (const c of candidates) {
    if (c.sizeGap !== balanced.sizeGap || c.violations > balanced.violations) continue;
    if (c.imbalance > balanced.imbalance + ROOKIE_SPLIT_TOLERANCE) continue;
    if (applied && (c.winA < AVOID_WIN_MIN || c.winA > AVOID_WIN_MAX)) continue;
    if (
      c.rookieGap < chosen.rookieGap ||
      (c.rookieGap === chosen.rookieGap && c.imbalance < chosen.imbalance)
    ) {
      chosen = c;
    }
  }

  const inA = groups.filter((_, i) => chosen.mask & (1 << i));
  const inB = groups.filter((_, i) => !(chosen.mask & (1 << i)));
  // Report the bigger side as teamA, matching the ⌈n/2⌉-first convention; ties keep
  // the pinned-group side first so the output stays deterministic.
  const [ga, gb] =
    makeTeam(inA).players.length >= makeTeam(inB).players.length ? [inA, inB] : [inB, inA];
  const teamA = makeTeam(ga);
  const teamB = makeTeam(gb);
  const sum = (gs: Group[], k: "effMu" | "effVar") => gs.reduce((s, g) => s + g[k], 0);
  const together = (i: number) => sameSide(chosen.mask, pairGroups[i][0], pairGroups[i][1]);
  const honoured = requested.filter((_, i) => !together(i));
  const violated = requested.filter((_, i) => together(i));
  return {
    teamA,
    teamB,
    winProbA: winProbOf(
      sum(ga, "effMu"),
      sum(ga, "effVar"),
      teamA.players.length,
      sum(gb, "effMu"),
      sum(gb, "effVar"),
      teamB.players.length,
    ),
    deviation: Math.abs(teamA.avg - teamB.avg),
    unrated,
    sizeCompromised: chosen.sizeGap > (n % 2 === 0 ? 0 : 1),
    partiesIgnored: false,
    avoid: { requested, honoured, violated, applied, skippedForBalance },
    rookies: {
      count: totalRookies,
      gap: chosen.rookieGap,
      tieBreak: chosen.rookieGap < balanced.rookieGap,
    },
  };
}

/**
 * Party splitting: balance with the parties intact, but when even the best
 * party-constrained split leaves either side's win chance above
 * PARTY_SPLIT_MAX_WIN, the parties themselves are what makes the game unfair
 * (strong players stacked in one party) — so the assignment is thrown away and
 * the lobby re-balanced as balance mode "skill" would (every player
 * individual), flagged `partiesIgnored` so the caller can say so.
 *
 * The party-free search space contains every party-constrained split, so the
 * re-run can only do as well or better on the lexicographic objective.
 */
export function balanceTeamsWithPartySplit(
  players: BalancePlayer[],
  opts: BalanceOptions = {},
): BalanceResult {
  const constrained = balanceTeams(players, opts);
  if (!players.some((p) => (p.partyId ?? "").trim() !== "")) return constrained;
  if (Math.max(constrained.winProbA, 1 - constrained.winProbA) <= PARTY_SPLIT_MAX_WIN) {
    return constrained;
  }
  const free = balanceTeams(
    players.map((p) => ({ ...p, partyId: null })),
    opts,
  );
  return { ...free, partiesIgnored: true };
}

/**
 * P(team A wins) for two rosters given as LOS states (null = unrated debutant),
 * rookie handicap applied — the same predictor the balancer optimizes and the web
 * UI's matchup strip shows. For the bot's .status matchup line.
 */
export function teamsWinProb(a: (LosState | null)[], b: (LosState | null)[]): number {
  const agg = (team: (LosState | null)[]) => {
    let mu = 0;
    let v = 0;
    for (const r of team) {
      const s = r ?? UNRATED_STATE;
      const eff = losEffectiveRating(s, s.games);
      mu += eff.mu;
      v += eff.sigma * eff.sigma;
    }
    return { mu, v };
  };
  const ta = agg(a);
  const tb = agg(b);
  return winProbOf(ta.mu, ta.v, a.length, tb.mu, tb.v, b.length);
}

/** The shown LOS for a rating state (rookie handicap applied), or the unrated
 * assumption. For displays. */
export function shownLos(r: LosState | null | undefined): number {
  return r && Number.isFinite(r.mu) && Number.isFinite(r.sigma)
    ? shownLosOfState(r.mu, r.sigma, r.games)
    : UNRATED_LOS;
}
