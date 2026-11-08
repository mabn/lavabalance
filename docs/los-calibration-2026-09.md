# Is LOS tuned? Calibration of the win predictor once the bot balances lobbies

*Data: every rated lava game from 2026-08-15 to 2026-09-15 as served by the
public LOS API (`/api/games`), 621 games. The bot started balancing lobbies
around 2026-09-04, so the window splits into a baseline (Aug 15 – Sep 3, 411
games) and the bot era (Sep 4 – Sep 15, 210 games). Everything here is
reproduced by `tools/lavaos/calibration.py`; see the end for how to re-run it.*

## The question

The bot picks the split whose OpenSkill `predictWin` is closest to 50/50, using
the same predictor the LOS fold is calibrated with. Once most games start at
50/50, the outcome of any one of them says nothing about whether the prediction
was right: both results are equally consistent with a correct model and with a
badly wrong one. So how do we know the rating is still "tuned", meaning the
predicted chance really is the win chance?

The answer is that there are four checks that survive balancing, and they all
still have signal:

1. **Calibration on the lopsided games.** The bot balances only about half of
   the games (it has to be boss, its teams have to land, parties and debutants
   limit the split). The other half still carry predictions from 60% to 99%,
   and those are where calibration is measured. A reliability table and a
   calibration slope tell whether 80% means 80%.
2. **Tests inside the 50/50 games.** A prediction of 50% is falsifiable in
   aggregate, not one game at a time: if any other signal (later ratings,
   recent form, rookie count, side) predicts the winners of the balanced games
   at better than a coin flip, the model was missing that signal.
3. **Per-player residuals.** A player who is under-rated lifts every team they
   play on above its predicted chance, balanced games included. Summing
   (won − predicted) over a player's games recovers the signal that balancing
   erased from the individual games. Under a tuned model those sums are noise.
4. **Residuals by experience.** The same sum grouped by the player's game
   number instead of the player, which is what tunes the rookie handicap.

## 1. Calibration on all rated games

Reliability by predicted favourite probability (the favourite is whichever
team `predictWin` puts above 50%):

| Favourite bucket | Baseline: n / predicted / actual | Bot era: n / predicted / actual |
|---|---|---|
| 50–60 % | 41 / 55.4 % / 48.8 % | 108 / 52.0 % / 53.7 % |
| 60–70 % | 31 / 65.3 % / 74.2 % | 22 / 63.9 % / 63.6 % |
| 70–80 % | 42 / 75.0 % / 78.6 % | 14 / 75.2 % / 78.6 % |
| 80–90 % | 60 / 85.7 % / 81.7 % | 18 / 85.8 % / 72.2 % |
| 90–100 % | 237 / 97.9 % / 95.8 % | 48 / 97.3 % / 89.6 % |

Summary numbers:

| | Baseline | Bot era |
|---|---|---|
| Rated games | 411 | 210 |
| Games predicted within 45–55 % | 4 % | 46 % |
| Favourite wins | 85.6 % | 66.2 % |
| Brier score (coin flip = 0.250) | 0.103 | 0.202 |
| Calibration slope (tuned = 1) | 0.78 | 0.62 |

Two things to read from this:

- **The Brier score and favourite accuracy are not comparable across eras.**
  They got "worse" because half of the games are now genuine coin flips, which
  is the bot doing its job. The reliability table and the slope are the
  era-independent measures.
- **The one real weakness is overconfidence at the extremes.** In both eras,
  games predicted at 90 %+ win less often than predicted (95.8 % and 89.6 %
  against ~98 %), and in the bot era the 80–90 % bucket won only 72 % of 18.
  The calibration slope, from a logistic fit of outcome on logit(p), is 0.78
  before and 0.62 after: the model's logits should be shrunk by a quarter to a
  third. This is a tuning knob, not a structural failure: a larger effective β
  in `predictWin`, or an added variance term, fixes the extremes without
  changing the ordering of any split. Before refitting, split the bot-era
  lopsided games by whether the bot's teams landed (the `[payoff]` log lines
  record this): they may be a selected sample, for example lobbies where a
  forced arrangement was undone.
- Duration is a weak closeness proxy that points the right way: predicted
  50/50 games average 36.8 min, predicted 90 %+ stomps 32.7 min.

## 2. Inside the 96 balanced games

Games predicted within 45–55 % in the bot era: 96 of 210.

| Test | Result | Reading |
|---|---|---|
| Team 1 win rate | 54/96 = 56.2 % (1 SE 5.1 %) | no side bias |
| Nominal favourite (the side above 50 %) | 52/96 = 54.2 % | consistent with a coin flip |
| Leave-one-out hindsight ratings | 38/69 = 55 % | little was left on the table |
| Momentum: team with the larger LOS gain over its last 3 / 5 / 10 games | 50.0 % / 47.9 % / 51.0 % | ratings neither lag nor overshoot |
| Team with more rookies (game 1–3) | 22/55 = 40.0 % | ~1.5 SE below 50; see §4 |
| Team with more debutants (game 1) | 21/43 = 48.8 % | the game-1 handicap is right |
| BAR OS as a competing predictor (all bot-era games) | favourite right 56 % | still no signal, as found in August |

The hindsight test deserves a note. Re-predicting each balanced game from each
player's rating **at the end of the window** picks the winner 85 % of the time,
which looks like proof that the pre-game ratings were badly under-informed. It
is leakage: each game's own update moves 16 ratings toward its winner, and in
8v8 that shift alone is enough to "predict" the game. Subtracting the game's own
μ delta from every player (leave-one-out) drops it to 55 % ± 6 %. That is the
honest number, and it says later games revealed little that the pre-game
ratings did not already know. Anyone re-running this must keep the
leave-one-out correction.

(The public API redacts private profiles' μ/σ, so the hindsight test ran on the
69 balanced games with full data. The API's own `predictedWin` is computed from
the true values and is what every other test uses.)

## 3. Per-player residuals

For each player with at least 5 bot-era games: residual = wins − Σ predicted
win chance of their team, z = residual / √Σp(1−p). Under a tuned model the
z-scores are standard normal noise.

| Statistic | Observed (146 players) | Expected if tuned |
|---|---|---|
| Mean z | +0.04 | 0 |
| Spread of z | 1.07 | 1.0 |
| Players with abs z above 1.96 | 8 | 7.3 |
| Players with abs z above 2.58 | 1 | 1.4 |
| Correlation of z with starting LOS | −0.01 | 0 |

That is noise: there is no population of players the model is systematically
wrong about, and neither low- nor high-rated players are shortchanged.

The individual outliers are what a working rating system produces. The most
under-rated names are players whose LOS climbed steeply in the window:

| Player | Games | Expected wins | Wins | z | LOS first → last |
|---|---|---|---|---|---|
| Mazaalai | 19 | 7.2 | 12 | +2.64 | 16.5 → 26.1 |
| [Crd]BARtillery | 14 | 5.7 | 10 | +2.53 | 14.0 → 22.2 |
| BLANKZ | 35 | 14.7 | 20 | +2.16 | 23.5 → 31.6 |
| 3MinuteComBomb | 55 | 28.7 | 35 | +1.82 | 11.5 → 24.9 |

and the most over-rated fell the same way (BenzWillEs 23.7 → 19.5 over 17
games, jdeppjr 20.3 → 14.9 over 17). In every case the early predictions were
wrong and the rating moved to fix it. The thing to watch for is a *persistent*
outlier: a player whose z stays large after 30+ games. There are none; the two
largest z's belong to players with 19 and 14 games, and a 5-for-5 streak
(Grammoth, z +2.26) is just a streak.

Caveat: 16 players share each outcome, so the 146 z-scores are not independent
and the tails are a little wider than a textbook normal. That makes "8 versus
7.3 expected" even less alarming.

## 4. Residuals by experience: the rookie handicap

Player-games grouped by the player's rated-game number, bot era:

| Game number | Player-games | Predicted win | Actual win | z |
|---|---|---|---|---|
| 1 | 197 | 51.5 % | 51.3 % | −0.1 |
| 2–3 | 223 | 47.6 % | 43.9 % | −1.1 |
| 4–10 | 412 | 44.8 % | 40.5 % | −1.8 |
| 11–50 | 921 | 48.5 % | 50.5 % | +1.2 |
| 51–200 | 743 | 47.5 % | 50.1 % | +1.4 |
| 200+ | 864 | 56.4 % | 55.2 % | −0.7 |

On the balanced games alone the pattern is the same: debutants are spot on
(50.0 % of 86), games 4–10 win 43.9 % of 171 against a predicted 50 %, games
11–50 win 53.2 % of 395.

Reading: the current handicap (μ discounted by 3.9 / 3.4 / 2.4 in games 1–3,
`ROOKIE_MU_HANDICAP` in `src/lavaos/lava.ts`) is right where it applies, but it
drops to zero one or two games too early. A player in games 4–10 still
underperforms their rating by a few points, and the "more rookies" side losing
60 % of the balanced games in §2 is the same effect. None of the bands is
individually significant yet. When the handicap is re-fitted on a bigger
sample, try extending it with a small tail (for example 1.5 at game 4 and 1.0
at game 5) and re-check this table; the debutant row must stay at 50 %.

## Follow-up: the per-player β term (adopted 2026-09-15)

The overconfidence has a formula-level cause. `predictWin`'s denominator is
√(n·β² + σ_A² + σ_B²) with n = 2 teams, so the β term adds ~35 while the
sixteen σ² terms add ~400: the model treats a 20-point μ gap as a near
certainty. Making β per player, (|A|+|B|)·β² = 16β² for an 8v8, adds ~278
instead. Tested on the 393 games of the window with full μ/σ data:

| predictWin variance term | Calibration slope | Log-loss | 90 %+ bucket: predicted vs actual |
|---|---|---|---|
| Library, 2·β² | 0.80 | 0.469 | 97.2 % vs 94.5 % |
| β doubled, 8·β² | 0.86 | 0.466 | 96.9 % vs 94.2 % |
| **Per player, 16·β²** | **0.93** | **0.464** | **96.7 % vs 96.1 %** |
| β tripled, 18·β² | 0.95 | 0.464 | 96.5 % vs 96.1 % |

The per-player form is now LOS's `predictWin` (moved to `src/lavaos/lava.ts`
with the other deliberate deviations); the library-exact form remains as
`predictWinLib` in `openskill.ts` only for the test-vector pin. Win chances are computed on read from the stored pre-game
ratings, so every past game re-scored at once; stored ratings did not change,
and the balancer picks the same splits (the change is monotone). The
calibration script's default `--beta per-player` matches the server;
`--beta lib` reproduces the tables above this section. Open items: refit on
the full history with a held-out month once there is more bot-era data, and
re-check the experience-band table, since the rookie handicap was fitted
against the old denominator.

## Conclusions

- **LOS is basically sound in the bot era.** Balanced games show no side bias,
  no momentum, no hidden signal in hindsight ratings, and per-player residuals
  are noise. Ratings move players who are mis-rated to where they belong.
- **Overconfidence at the extremes was the one tunable issue.** Calibration
  slope 0.62–0.78 instead of 1; 90 %+ predictions won ~90–96 %. Addressed by
  the per-player β term above (slope 0.93 on the same games).
- **The rookie handicap should taper past game 3.** Refitted on the full
  history the day after: `los-rookie-handicap-2026-09-16.md`.
- **BAR OS still carries no information about lava skill.**

## Keeping this honest

Run the checks periodically, and after any change to the rating rule:

```bash
# from the lavabalance root; standard library only
python3 tools/lavaos/calibration.py --from 2026-09-04 --baseline-from 2026-08-15
python3 tools/lavaos/calibration.py --from 2026-09-04 --url http://localhost:8787   # wrangler dev
```

It prints the port check (`predictWin` re-implemented in the script against the
API's value), the reliability tables and slopes, the balanced-game tests, the
per-player z distribution with the top outliers, and the experience bands.
Pages are cached under `/tmp/los-calibration` (`--cache`; delete to refetch).
What "drifting" looks like: slope moving away from 1, the z spread growing past
~1.2 or a player staying beyond |z| 2.5 after 30+ games, or an experience band
beyond |z| 2. If none of those move, LOS is tuned.
