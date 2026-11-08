// Port of BAR's OpenSkill rating, faithful to the code Teiserver actually runs:
//   github.com/beyond-all-reason/openskill.ex        (PlackettLuce model)
//   teiserver lib/teiserver/game/libs/match_rating_lib.ex  (how matches feed it)
//   teiserver lib/teiserver/battle/libs/balance_lib.ex     (displayed values)
//
// Teiserver rates a 2-team match as rate([winnerTeam, loserTeam]) with
// tau = 1/3 (site config "rating.Tau" default) and prevent_sigma_increase =
// true; the displayed "OS" is max(mu - sigma, 0) and the leaderboard value is
// max(mu - 3*sigma, 0). Team rank = list order; ties are not supported by the
// Elixir PlackettLuce implementation and are not supported here either.

export interface Rating {
  mu: number;
  sigma: number;
}

export const MU = 25;
export const Z = 3;
export const SIGMA = MU / Z; // 8.333...
export const BETA = SIGMA / 2; // 4.1666...
export const EPSILON = 0.0001;
export const TAU = 1 / 3; // teiserver site config "rating.Tau" default
export const PREVENT_SIGMA_INCREASE = true; // teiserver rate_with_ids default

const BETASQ = BETA * BETA;

export function defaultRating(): Rating {
  return { mu: MU, sigma: SIGMA };
}

/** BAR's displayed "OS" / rating_value (BalanceLib.calculate_rating_value). */
export function ratingValue(r: Rating): number {
  return Math.max(r.mu - r.sigma, 0);
}

/** BalanceLib.calculate_leaderboard_rating. */
export function leaderboardRating(r: Rating): number {
  return Math.max(r.mu - Z * r.sigma, 0);
}

/** openskill.ex Openskill.ordinal (mu - z*sigma, no clamp). */
export function ordinal(r: Rating): number {
  return r.mu - Z * r.sigma;
}

/** Openskill.PlackettLuce.rate — teams in rank order (index = placement). */
function plackettLuce(teams: Rating[][]): Rating[][] {
  // Util.team_rating: (sum mu, sum sigma^2, team, 1-based rank)
  const teamMu = teams.map((t) => t.reduce((a, r) => a + r.mu, 0));
  const teamSigmaSq = teams.map((t) => t.reduce((a, r) => a + r.sigma * r.sigma, 0));

  const c = Math.sqrt(teamSigmaSq.reduce((a, s) => a + s + BETASQ, 0));

  // sum_q[q] = sum over teams i with rank_i >= rank_q of exp(mu_i / c)
  const expMu = teamMu.map((mu) => Math.exp(mu / c));
  const sumQ = teams.map((_, q) => expMu.filter((_, i) => i >= q).reduce((a, e) => a + e, 0));

  return teams.map((team, i) => {
    const tmp1 = expMu[i];
    let omegaSum = 0;
    let deltaSum = 0;
    for (let q = 0; q <= i; q++) {
      const tmp = tmp1 / sumQ[q];
      omegaSum += q === i ? 1 - tmp : -tmp;
      deltaSum += tmp * (1 - tmp);
    }
    const gamma = Math.sqrt(teamSigmaSq[i]) / c;
    const omegaI = (omegaSum * teamSigmaSq[i]) / c;
    const deltaI = (gamma * deltaSum * teamSigmaSq[i]) / c / c;

    return team.map(({ mu, sigma }) => {
      const sigmaSq = sigma * sigma;
      return {
        mu: mu + (sigmaSq / teamSigmaSq[i]) * omegaI,
        sigma: sigma * Math.sqrt(Math.max(1 - (sigmaSq / teamSigmaSq[i]) * deltaI, EPSILON)),
      };
    });
  });
}

/** Standard normal CDF via the Numerical-Recipes erfc approximation
 * (|error| < 1.2e-7 — well below display precision). */
export function phiMajor(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const erfc =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  const cdf = 1 - erfc / 2;
  return x >= 0 ? cdf : 1 - cdf;
}

/**
 * Openskill.predict_win — win probability per team, in team order.
 * P = phi((mu_a - mu_b) / sqrt(n*beta^2 + sigma_a^2 + sigma_b^2)) with team
 * mu/sigma^2 summed over members and n = number of teams, exactly as the
 * Elixir lib computes it (for 2 teams the pairwise loop reduces to this).
 *
 * This is the library-exact port, kept for the test-vector pin. LOS itself
 * shows and balances with `predictWin` (lava.ts), which uses a per-player
 * beta term instead of the lib's per-team one — the lib's is overconfident
 * on 8v8 lava games (docs/los-calibration-2026-09.md).
 */
export function predictWinLib(teams: Rating[][]): number[] {
  const n = teams.length;
  const denom = (n * (n - 1)) / 2;
  const mu = teams.map((t) => t.reduce((a, r) => a + r.mu, 0));
  const sigmaSq = teams.map((t) => t.reduce((a, r) => a + r.sigma * r.sigma, 0));
  return teams.map((_, i) => {
    let sum = 0;
    for (let q = 0; q < n; q++) {
      if (q === i) continue;
      sum += phiMajor((mu[i] - mu[q]) / Math.sqrt(n * BETASQ + sigmaSq[i] + sigmaSq[q]));
    }
    return sum / denom;
  });
}

export interface RateOptions {
  tau?: number;
  preventSigmaIncrease?: boolean;
}

/**
 * Openskill.rate: inflate each sigma by tau, run the model, and (per
 * prevent_sigma_increase) never let a player's sigma exceed its pre-match
 * value. Teams are in placement order: winners first.
 */
export function rate(teams: Rating[][], options: RateOptions = {}): Rating[][] {
  const tau = options.tau ?? TAU;
  const preventSigmaIncrease = options.preventSigmaIncrease ?? PREVENT_SIGMA_INCREASE;

  const inflated = teams.map((t) =>
    t.map(({ mu, sigma }) => ({ mu, sigma: Math.sqrt(sigma * sigma + tau * tau) })),
  );
  const output = plackettLuce(inflated);

  if (tau > 0 && preventSigmaIncrease) {
    return output.map((t, i) =>
      t.map(({ mu, sigma }, j) => ({ mu, sigma: Math.min(teams[i][j].sigma, sigma) })),
    );
  }
  return output;
}
