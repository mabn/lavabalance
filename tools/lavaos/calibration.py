#!/usr/bin/env python3
"""Is LOS tuned? Calibration checks over the public LOS games API.

Bot-balanced games are ~50/50 by construction, so a single outcome says nothing
about its prediction. This script runs the checks that still work (see
docs/los-calibration-2026-09.md for the reasoning and the first results):

  1. reliability table + calibration slope over ALL rated games (the lopsided
     games carry the signal; slope 1 = tuned, <1 = overconfident)
  2. tests inside the near-50/50 games: leave-one-out hindsight ratings,
     rating momentum, rookie-count, side bias
  3. per-player residuals (wins minus summed predicted win chance), whose
     z-scores should look like N(0,1)
  4. the same residual by player experience band (tunes the rookie handicap)

Offline analysis only; nothing in the Worker imports this. Needs only the
Python standard library.

  python3 tools/lavaos/calibration.py --from 2026-09-04
  python3 tools/lavaos/calibration.py --from 2026-09-04 --baseline-from 2026-08-15
  python3 tools/lavaos/calibration.py --url http://localhost:8787 --from 2026-09-04

Pages are cached under --cache (default /tmp/los-calibration); delete it to
refetch. The public API redacts private profiles' μ/σ; the API's own
`predictedWin` is still computed from the true values and is used for every
pre-game prediction, while tests that need per-player μ/σ skip such games.

The script's own predictor defaults to LOS's per-player β term (the server's
since 2026-09-15); `--beta lib` is the openskill library's per-team term. The
port check at the top says which one the API you are talking to runs.
"""
import argparse, json, math, os, sys, urllib.request
from collections import defaultdict

BETA = 25 / 6
# Rookie handicap curves (src/lavaos/lava.ts rookieHandicap): v3 (2026-09-27) and v2
# (2026-09-16) are START·e^(−prior/DECAY) for the first GAMES games; v1 was 3.9/3.4/2.4
# for games 1–3.
HANDICAP_VERSION = "v3"  # set from --handicap in main()
HANDICAP_V1 = [3.9, 3.4, 2.4]
HANDICAP_V2 = (8.5, 15, 20)
HANDICAP_V3 = (13, 25, 35)


def phi(x):
    return 0.5 * math.erfc(-x / math.sqrt(2))


def logit(p):
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))


def handicap(game_number):
    prior = game_number - 1
    if HANDICAP_VERSION == "v1":
        return HANDICAP_V1[prior] if prior < len(HANDICAP_V1) else 0
    start, decay, games = HANDICAP_V3 if HANDICAP_VERSION == "v3" else HANDICAP_V2
    return start * math.exp(-prior / decay) if prior < games else 0


BETA_TERM = "per-player"  # set from --beta in main()


def beta_term(na, nb):
    """The β variance term of the predictor: LOS's per-player (|a|+|b|)·β² (predictWin in
    lava.ts, the server's predictedWin since 2026-09-15) or the openskill library's per-team 2β²."""
    return (na + nb) * BETA * BETA if BETA_TERM == "per-player" else 2 * BETA * BETA


def predict_win(a, b):
    """P(team a wins); a/b = lists of (mu, sigma, gameNumber), rookie handicap of lava.ts applied."""
    ma = sum(m - handicap(g) for m, s, g in a)
    mb = sum(m - handicap(g) for m, s, g in b)
    va = sum(s * s for m, s, g in a)
    vb = sum(s * s for m, s, g in b)
    return phi((ma - mb) / math.sqrt(beta_term(len(a), len(b)) + va + vb))


def fetch_games(url, since, cache, page_size):
    os.makedirs(cache, exist_ok=True)
    games, page = [], 1
    while True:
        path = os.path.join(cache, f"page{page}.json")
        if os.path.exists(path):
            data = json.load(open(path))
        else:
            with urllib.request.urlopen(f"{url}/api/games?page={page}&limit={page_size}", timeout=60) as r:
                data = json.load(r)
            json.dump(data, open(path, "w"))
        gs = data["games"]
        if not gs:
            break
        games += gs
        if gs[-1]["startTime"] < since:
            break
        page += 1
    games = [g for g in games if g["startTime"] >= since and not g["ignored"] and g["winnerTeam"] in (0, 1)]
    games.sort(key=lambda g: g["startTime"])
    return games


def fit_slope(rows):
    """Logistic fit y ~ a + b*logit(p) by Newton's method. b is the calibration slope."""
    a, b = 0.0, 1.0
    for _ in range(50):
        g0 = g1 = h00 = h01 = h11 = 0.0
        for p, y in rows:
            x = logit(p)
            q = 1 / (1 + math.exp(-(a + b * x)))
            w = q * (1 - q)
            g0 += y - q
            g1 += (y - q) * x
            h00 += w
            h01 += w * x
            h11 += w * x * x
        det = h00 * h11 - h01 * h01
        if det < 1e-12:
            break
        da = (h11 * g0 - h01 * g1) / det
        db = (-h01 * g0 + h00 * g1) / det
        a += da
        b += db
        if abs(da) + abs(db) < 1e-9:
            break
    return a, b


def team_rows(games):
    return [(g["predictedWin"][0], 1 if g["winnerTeam"] == 0 else 0) for g in games]


def report_calibration(label, games):
    rows = team_rows(games)
    n = len(rows)
    brier = sum((p - y) ** 2 for p, y in rows) / n
    a, b = fit_slope(rows)
    fav_right = sum(1 for p, y in rows if (p >= 0.5) == (y == 1)) / n
    print(f"== {label}: {n} rated games")
    print(f"   Brier {brier:.3f} (coin 0.250)   favourite wins {fav_right:.1%}   calibration slope {b:.2f} (intercept {a:+.2f})")
    buckets = defaultdict(list)
    for g in games:
        p = g["predictedWin"][0]
        pf = max(p, 1 - p)
        yf = 1 if (p >= 0.5) == (g["winnerTeam"] == 0) else 0
        buckets[min(int((pf - 0.5) / 0.1), 4)].append((pf, yf, g["durationMs"] / 60000))
    print("   favourite bucket    n   predicted  actual   mean duration")
    for k in sorted(buckets):
        v = buckets[k]
        print(f"   {50 + 10 * k:>3}-{60 + 10 * k}%          {len(v):4d}   {sum(x[0] for x in v) / len(v):6.1%}   {sum(x[1] for x in v) / len(v):6.1%}   {sum(x[2] for x in v) / len(v):5.1f} min")


def complete(g):
    return all(x["muBefore"] is not None and x["muAfter"] is not None for t in g["teams"] for x in t)


def report_balanced(games, all_games, tol):
    near = [g for g in games if abs(g["predictedWin"][0] - 0.5) <= tol]
    n = len(near)
    print(f"== near-50/50 games (|p-0.5| <= {tol}): {n} of {len(games)} ({n / len(games):.0%})")
    if n == 0:
        return
    t1 = sum(1 for g in near if g["winnerTeam"] == 0)
    print(f"   team-1 wins {t1}/{n} = {t1 / n:.1%} (1 SE {math.sqrt(0.25 / n):.1%})")
    fav = sum(1 for g in near if (g["predictedWin"][0] >= 0.5) == (g["winnerTeam"] == 0))
    print(f"   nominal favourite wins {fav}/{n} = {fav / n:.1%}")

    # leave-one-out hindsight: each player's rating after their LAST game in the
    # whole window, minus this game's own update (so the game can't predict itself)
    final = {}
    for g in all_games:
        for t in g["teams"]:
            for x in t:
                if x["muAfter"] is not None:
                    final[x["userId"]] = (x["muAfter"], x["sigmaAfter"], x["gameNumber"] + 1)
    res = []
    for g in near:
        if not complete(g):
            continue
        teams = []
        for t in g["teams"]:
            teams.append([(final[x["userId"]][0] - (x["muAfter"] - x["muBefore"]), final[x["userId"]][1], final[x["userId"]][2]) for x in t])
        res.append((predict_win(teams[0], teams[1]), 1 if g["winnerTeam"] == 0 else 0))
    if res:
        ok = sum(1 for p, y in res if (p >= 0.5) == (y == 1))
        print(f"   leave-one-out hindsight ratings pick the winner {ok}/{len(res)} = {ok / len(res):.0%} (mean |p-0.5| {sum(abs(p - 0.5) for p, _ in res) / len(res):.3f})")

    hist = defaultdict(list)
    for g in all_games:
        for t in g["teams"]:
            for x in t:
                if x["losDelta"] is not None:
                    hist[x["userId"]].append((g["startTime"], x["losDelta"]))
    for k in (3, 5, 10):
        w = m = 0
        for g in near:
            mom = [sum(d for x in t for _, d in [h for h in hist[x["userId"]] if h[0] < g["startTime"]][-k:]) for t in g["teams"]]
            if mom[0] == mom[1]:
                continue
            m += 1
            if g["winnerTeam"] == (0 if mom[0] > mom[1] else 1):
                w += 1
        if m:
            print(f"   momentum (larger LOS gain over last {k:2d} games) wins {w}/{m} = {w / m:.1%}")
    for label, f in [("rookies (game 1-3)", lambda x: x["gameNumber"] <= 3), ("debutants (game 1)", lambda x: x["gameNumber"] == 1)]:
        w = m = 0
        for g in near:
            c = [sum(1 for x in t if f(x)) for t in g["teams"]]
            if c[0] == c[1]:
                continue
            m += 1
            if g["winnerTeam"] == (0 if c[0] > c[1] else 1):
                w += 1
        if m:
            print(f"   team with more {label} wins {w}/{m} = {w / m:.1%}")


def bands(gn):
    return "1" if gn == 1 else "2-3" if gn <= 3 else "4-10" if gn <= 10 else "11-50" if gn <= 50 else "51-200" if gn <= 200 else "200+"


BAND_ORDER = ["1", "2-3", "4-10", "11-50", "51-200", "200+"]


def report_players(games, min_games, tol):
    P = defaultdict(lambda: dict(n=0, exp=0.0, won=0, var=0.0, name="", los0=None, los1=None, g0=None))
    band = defaultdict(lambda: [0, 0.0, 0])
    band_near = defaultdict(lambda: [0, 0.0, 0])
    for g in games:
        for ti, t in enumerate(g["teams"]):
            p = g["predictedWin"][ti]
            won = 1 if g["winnerTeam"] == ti else 0
            for x in t:
                r = P[x["userId"]]
                r["name"] = x["name"]
                r["n"] += 1
                r["exp"] += p
                r["won"] += won
                r["var"] += p * (1 - p)
                if r["los0"] is None and x["losBefore"] is not None:
                    r["los0"], r["g0"] = x["losBefore"], x["gameNumber"]
                if x["losAfter"] is not None:
                    r["los1"] = x["losAfter"]
                b = bands(x["gameNumber"])
                for d in ([band, band_near] if abs(p - 0.5) <= tol else [band]):
                    d[b][0] += 1
                    d[b][1] += p
                    d[b][2] += won
    rows = sorted(((r["won"] - r["exp"]) / math.sqrt(r["var"]), r) for r in P.values() if r["n"] >= min_games)
    zs = [z for z, _ in rows]
    mean = sum(zs) / len(zs)
    sd = math.sqrt(sum((z - mean) ** 2 for z in zs) / (len(zs) - 1))
    print(f"== per-player residuals, {len(rows)} players with >= {min_games} games")
    print(f"   z mean {mean:+.2f}, sd {sd:.2f} (tuned: ~0 / ~1)")
    for thr in (1.96, 2.58):
        k = sum(1 for z in zs if abs(z) > thr)
        print(f"   |z| > {thr}: {k} players (chance: {len(zs) * 2 * (1 - phi(thr)):.1f})")

    def show(items):
        print("   player                  games   exp  won      z   LOS first -> last (game# at start)")
        for z, r in items:
            los = f"{r['los0']:5.1f} -> {r['los1']:5.1f}  (#{r['g0']})" if r["los0"] is not None and r["los1"] is not None else "(private)"
            print(f"   {r['name'][:22]:22s}  {r['n']:5d} {r['exp']:5.1f} {r['won']:4d} {z:+6.2f}   {los}")

    print("   most under-rated (won more than predicted):")
    show(rows[::-1][:10])
    print("   most over-rated (won less than predicted):")
    show(rows[:10])
    for label, d, v in [("all games", band, 0.24), (f"near-50/50 games only", band_near, 0.25)]:
        print(f"== player-games by experience band, {label}: n, predicted, actual, z")
        for b in BAND_ORDER:
            n, e, w = d[b]
            if n:
                print(f"   game #{b:7s} {n:5d}  {e / n:6.1%}  {w / n:6.1%}  z={(w - e) / math.sqrt(n * v):+.2f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="https://lavabalance.fogofwar.dev")
    ap.add_argument("--from", dest="since", required=True, help="first UTC day of the evaluated window (YYYY-MM-DD)")
    ap.add_argument("--baseline-from", help="also report calibration for [baseline-from, from) for comparison")
    ap.add_argument("--cache", default="/tmp/los-calibration")
    ap.add_argument("--tol", type=float, default=0.05, help="|p-0.5| that counts as a balanced game")
    ap.add_argument("--min-games", type=int, default=5)
    ap.add_argument("--beta", choices=["per-player", "lib"], default="per-player",
                    help="β term of the script's own predictor: LOS's per-player (default, matches the server) or the openskill library's per-team")
    ap.add_argument("--handicap", choices=["v3", "v2", "v1"], default="v3",
                    help="rookie handicap curve of the script's own predictor: v3 (2026-09-27, the server's), v2 (2026-09-16) or the original v1 (3.9/3.4/2.4)")
    ap.add_argument("--page-size", type=int, default=100, help="API page size (the cache is keyed by page number, so keep it fixed per cache dir)")
    args = ap.parse_args()
    global BETA_TERM, HANDICAP_VERSION
    BETA_TERM = args.beta
    HANDICAP_VERSION = args.handicap

    start = args.baseline_from or args.since
    all_games = fetch_games(args.url, start, args.cache, args.page_size)
    window = [g for g in all_games if g["startTime"] >= args.since]
    if not window:
        sys.exit("no rated games in the window")

    mine = [(g["predictedWin"][0], predict_win(*[[(x["muBefore"], x["sigmaBefore"], x["gameNumber"]) for x in t] for t in g["teams"]])) for g in all_games if complete(g)]
    if mine:
        print(f"predictor port check (--beta {args.beta} --handicap {args.handicap} vs the API's predictedWin): max |api - script| = {max(abs(a - b) for a, b in mine):.1e} over {len(mine)} games")
        print("  (a large gap means the server runs another β term or handicap; the tables below use the API's values regardless)\n")

    if args.baseline_from:
        report_calibration(f"baseline {args.baseline_from} .. {args.since}", [g for g in all_games if g["startTime"] < args.since])
        print()
    report_calibration(f"since {args.since}", window)
    print()
    report_balanced(window, all_games, args.tol)
    print()
    report_players(window, args.min_games, args.tol)


if __name__ == "__main__":
    main()
