# LOS rookie handicap, second fit (2026-09-16, ALGO_VERSION 2)

*What changed: the μ discount applied to a player's first lava games grew from
3.9 / 3.4 / 2.4 over games 1–3 to a curve of 8.5·e^(−(g−1)/15) over games
1–20. Why, how it was verified, what it affects, and how it was rolled out.
The measurement method is the calibration report,
`los-calibration-2026-09.md`; the numbers here come from
`tools/lavaos/calibration.py` and the scratch fits described below.*

## The problem

The rookie handicap exists because players in their first lava games perform
well below the μ = 25 the model assumes for a newcomer, and nothing known
about them beforehand predicts by how much (lava skill is uncorrelated with
BAR OS, and, as checked in this pass, with BAR rank). OpenSkill is invariant
under shifting every player's μ by a constant, so a lower starting μ cannot
express the deficit; instead a player's μ is discounted, relative to the pool,
wherever team strength is computed while they are new.

The first fit, on 602 August games, gave 3.9 / 3.4 / 2.4 for games 1–3 and
nothing after. With the full history available (4,204 rated games with
complete pre-game ratings, Jan 1 – Sep 16 2026), it is clearly too small and
too short:

- Residual per player-game (actual minus predicted win rate) by lava games
  played: −1.7 pp in game 1, −1.2 in games 2–3, **−2.1 in games 4–10**, −0.7
  in 11–20, then **+2.9 in 21–50 and +2.5 in 51–200**. Newcomers lose more
  than predicted well past game 3, and the players who carry them win more.
- The direct test: in games predicted 40–60 %, a side with one more player
  in their first ten lava games won **39 %**, with two more **30 %**, with
  three more **29 %**. The rookie count was the strongest unmodelled signal
  in the data (logistic coefficient −0.27 log-odds per extra rookie, t = −12.6,
  and −0.31 on the balanced games alone).

Part of the shortfall is the per-player β predictor adopted on 2026-09-15:
its wider denominator (16β² instead of 2β²) needs a bigger μ offset to
express the same effect, so the August constants, fitted under the library
formula, were undersized the moment the predictor changed.

## The fit

Candidate: h(g) = A·e^(−(g−1)/τ) for games 1..N, 0 after, with g the game
number (so `rookieHandicap(prior)` = A·e^(−prior/τ) for prior < N). Fitted by
maximum likelihood of game outcomes under `predictWin` (per-player β), on
**June–August only** (1,542 games), applying the candidate at prediction time
to the stored pre-game ratings. Grid over A ∈ [4, 15] and τ ∈ [2, 15]:

- A = 8.5, τ = 15, N = 20. τ sat at the top of the grid, so the effect may
  persist even longer; the cutoff at 20 keeps the discount from lingering on
  regulars.

Values: 8.5 in game 1, 7.9 in game 2, 7.4 in game 3, 6.5 in game 5, 4.7 in
game 10, 3.3 in game 15, 2.4 in game 20, 0 from game 21.

A step-table fit (one free value per band) landed on 8.5 / 9.3 / 5.0 / 3.7 for
games 1 / 2–3 / 4–10 / 11–20 with the same held-out log-loss; the smooth
curve was preferred because it has two parameters and no discontinuity for a
player to notice between game 3 and game 4.

## Verification

Log-loss (lower is better; a coin flip is 0.693), scored with the per-player β
predictor. Only June–August was used to fit.

| Games | n | No discount | Current (3.9/3.4/2.4) | New curve |
|---|---|---|---|---|
| Jan–May (held out) | 2,491 | 0.548 | 0.530 | **0.509** |
| Jun–Aug (fit) | 1,542 | 0.497 | 0.484 | **0.471** |
| Sep (held out) | 171 | 0.585 | 0.574 | **0.550** |
| 5-fold CV, refit per fold | 4,204 | | 0.515 | **0.497** |

For scale, the per-player β change was worth about 0.005 on the same metric.

Residual by lava games played, current → new: game 1 −1.7 → −1.0 pp,
games 2–3 −1.2 → −0.1, games 4–10 −2.1 → +0.2, games 11–20 −0.7 → −0.4,
games 21–50 +2.9 → +0.9, games 51–200 +2.5 → +1.2, games 200+ −0.8 → −1.7.

Near-even games by rookie imbalance, team-A win rate, current → new: one extra
rookie 38.9 % → 43.3 %, two extra 29.7 % → 44.2 %. Not fully flat, but the
penalty roughly halves.

One thing moves the wrong way: the new discount pushes more games into the
90 %+ predicted bucket (rookie-heavy sides now read as clear underdogs) and
that bucket is still about four points overconfident, so the calibration slope
over all games slips from 0.85 to 0.80 even as log-loss improves everywhere.
On held-out September the slope improves, 0.88 → 0.91. After the refold it may
be worth one more notch on β.

## BAR rank was tested and rejected

Each `game_players` row now carries the player's BAR chevron (hours played)
at game time. It is not a lava-skill signal: the chevron at a player's first
lava game correlates 0.05 with the LOS they reach after 20 games (mean 16.4 for
under 15 hours, 17.2 for 1000+). It does modulate how debutants underperform
(rank 3–4 debutants lose more than rank 0–2 ones), but a rank-dependent
handicap fits better in-sample and **worse** out of sample (held-out Sep 0.559
against 0.550 for the games-only curve; 5-fold CV gains 0.001 for twelve extra
parameters, with unstable values). Rank stays out of the model.

## What the change affects

- **Every stored rating.** The handicap feeds `rate()`'s inputs, so a larger
  discount changes the update every game produces: a rookie's loss becomes
  more expected and costs less μ, and their teammates' too. The stored μ/σ,
  LOS and the ranking all change on refold. Established players move little;
  the players in their first twenty games, and whoever played alongside them,
  move most.
- **Every shown win chance**, since `predictWin` applies the same discount.
- **The balancer.** It uses the same effective ratings, so a lobby with
  rookies is split differently: a rookie now counts about 8 μ less than their
  raw rating instead of about 4, and only the raw ratings of players past
  game 20 are taken at face value.
- **A debutant's assumed LOS**, `UNRATED_LOS`, drops from 12.8 to 8.2
  (μ 25 − 8.5 − σ 8.33). The lobby page's (?) hints say so.
- **Not** the eligibility rules, τ, the β term, or the fold order.

## Rollout

The code bumps `ALGO_VERSION` to 2. Applying it to the live store is a
**rebase from the first stored game** (`POST /api/games/<first id>/rebase`, the
games table's admin ⟳ button on the oldest game), which re-runs the fold over
every stored row under the current code and stamps the new version in `meta`.
No re-upload is needed. Afterwards:

```bash
python3 tools/lavaos/calibration.py --from 2026-09-04 --baseline-from 2026-08-15
```

should report the predictor port check at ~1e-8 (the script defaults to
`--handicap v2 --beta per-player`, matching the server), and its experience-band
table should sit within a point of zero in every band. `--handicap v1` reproduces
the old predictor for comparison.

## Caveats and follow-ups

- The fit applied the candidate at prediction time to ratings the *old*
  handicap had produced. The refold changes those ratings, so the true
  post-refold numbers will differ a little; re-run the calibration script
  after the rebase and refit if the bands drift.
- The September test set is small (171 games with complete data; games with a
  private-profile player are excluded from the script's own predictor). The
  Jan–May set and the cross-validation carry the weight.
- τ hit the grid edge. If the 21–50 band stays positive after the refold, a
  longer tail (N = 30, τ = 20) is the next thing to try.
- The 90 %+ bucket's overconfidence is now the largest remaining
  miscalibration; a β refit after this settles is the natural next step.
