# LOS rookie handicap, third fit, and the rookie tie-break (2026-09-27, ALGO_VERSION 3)

*What changed: the μ discount on a player's first lava games grew from
8.5·e^(−prior/15) over 20 games to **13·e^(−prior/25) over 35 games**, and
the balancer gained a **rookie tie-break**. The first report was a player's
complaint that low-games players are over-rated and veterans under-rated.
Full analysis with charts: https://claude.ai/artifact/AqVEbnFhXrSBiE1LqpMhnr.
Previous fit: `los-rookie-handicap-2026-09-16.md`.*

## The problem

On the 469 rated games from Sep 4 to Sep 27, 2026, v2 still left a
measurable rookie bias. We fitted a logistic model with the game's own
prediction as an offset and the per-side difference in player counts as the
only covariate, and got this per extra player on a side (at a 50/50
prediction):

| Extra player with | Sep 4–27 (v2) | Sep 16–27 (v2, all post-deploy) |
|---|---|---|
| ≤ 5 games | −3.1 pp (t −1.8) | −4.5 pp (t −2.0) |
| ≤ 10 games | −3.2 pp (t −1.9) | −4.6 pp (t −2.1) |
| ≤ 20 games | **−4.3 pp (t −2.6)** | **−5.3 pp (t −2.5)** |
| 101+ games | +1.8 pp (t +1.1) | +2.3 pp (t +1.1) |

Veterans are not separately under-rated: the 101+ effect is small and not
significant. It is the other side of the rookie error, since predictions are
zero-sum within a game.

## Why v2 was undersized

v2 was fitted by applying each candidate curve at **prediction time** to the
stored pre-game ratings, which had been folded under a different curve. A
larger discount also makes rookie losses more expected in `rate()`, so rookies
lose less μ per loss. That feedback was missing from the fit. Doing it
properly means **refolding the whole history for every candidate**.

## The fit

`tools/lavaos/handicap_fit.py` re-implements the fold (PlackettLuce `rate()`,
τ = 1/3, prevent-σ-increase, handicap on the inputs, delta onto the real μ)
over the public games API. Under v2 it reproduces the server's stored μ to
3e-14. It uses a grid of A ∈ 8–18, T ∈ 10–40 and N ∈ 20–40 with the
per-player β predictor.

Leave-one-month-out (fit on every other month, score the held-out one):

| Held-out | Games | Chosen | v2 | Refit |
|---|---|---|---|---|
| 2026-01 | 491 | 13, 25, 35 | 0.604 | 0.601 |
| 2026-02 | 509 | 13, 25, 35 | 0.482 | 0.473 |
| 2026-03 | 622 | 14, 25, 35 | 0.493 | 0.496 |
| 2026-04 | 639 | 14, 25, 35 | 0.479 | 0.471 |
| 2026-05 | 719 | 13, 25, 35 | 0.501 | 0.489 |
| 2026-06 | 656 | 14, 25, 35 | 0.504 | 0.498 |
| 2026-07 | 690 | 13, 25, 35 | 0.457 | 0.454 |
| 2026-08 | 622 | 13, 25, 35 | 0.390 | 0.374 |
| Sep 1–3 | 52 | 13, 25, 35 | 0.245 | 0.244 |
| Sep 4–27 | 469 | 13, 25, 35 | 0.553 | 0.549 |

The pooled log-loss goes from 0.489 to 0.483, and the refit is better in 9 of
10 months. The Sep 4–27 gain alone is within noise (95% bootstrap interval
−0.007 to +0.017), so the case rests on the monthly test.

Under v3 the Sep 4–27 rookie effect shrinks to −1.5 pp per extra player with
≤20 games (t −0.9). v3 slightly over-corrects games 1–5 in Jun–Sep 3 (+2.3 pp,
t +2.1), so the rookie deficit varies between cohorts. That variation is the
reason for the tie-break below.

**β:** held-out September calibrates at slope 0.98 under v3 with the current
per-player β, so β is unchanged. Jan–Sep 3 prefers a β about 1.5× larger
(slope 0.81), but it did under v2 too (0.84). That is an existing issue and
not caused by this change; if β were widened, A would move only from 13 to
about 15.

## The rookie tie-break

`src/balance/balancer.ts`: after sizes, avoids and win chance have picked a
split, the balancer looks at every split within **ROOKIE_SPLIT_TOLERANCE =
0.02** (2 pp) of that win chance with the same sizes, no more avoid pairs
together, and still inside the avoid band when the avoids decided. Among
those it takes the one spreading the **unpartied** players with fewer than
**ROOKIE_SPLIT_GAMES = 10** rated games most evenly. `BalanceResult.rookies`
reports `{count, gap, tieBreak}`.

Replaying the balancer on the 469 September rosters (parties ignored):

- With the tie-break at 2 pp on the v3 handicap, every lobby got a rookie
  split within one player of even. The chosen teams averaged 0.03 pp from
  50/50, against 0.01 pp without the tie-break.
- On its own it does not fix the bias. Judged by v3, the v2-balanced splits
  are 5.7 pp off 50/50 on average; forcing even rookies brings that only to
  5.2 pp. The handicap fix is what removes the error.

## Rollout (after deploy)

1. `POST /api/games/<first stored game id>/rebase`: refolds the store under v3
   and stamps `algo_version = 3`.
2. `python3 tools/lavaos/handicap_fit.py --check 13,25,35`: the first line
   should read ~1e-13.
3. Re-check in a month with `tools/lavaos/calibration.py --from 2026-09-28`.
