#!/usr/bin/env python3
"""Fit the rookie handicap curve with a FULL REFOLD per candidate.

Fetches every stored game from the public LOS games API, re-runs the LOS fold
(rate() with the rookie handicap, exactly as src/los/losGames.ts applyRatedGame
does) from game one for each candidate curve A·e^(−prior/T) over N games, and
scores every game's outcome under predictWin (per-player β). Refolding matters:
applying a candidate only at prediction time to ratings folded under another
curve undersizes it (docs/los-rookie-handicap-2026-09-27.md).

  python3 tools/lavaos/handicap_fit.py                 # leave-one-month-out fit
  python3 tools/lavaos/handicap_fit.py --check 13,25,35

The first line checks the refold against the server's stored μ: ~1e-13 once
the store has been rebased under SERVER's curve, large while it still holds
ratings folded under an older ALGO_VERSION. Pages are cached under --cache for
fits; --check always refetches, since it is run right after a rebase. Standard library
only; the API sits behind Cloudflare, which refuses urllib's default user agent,
hence the explicit one.
"""
import argparse, itertools, json, math, os, urllib.request
from collections import defaultdict

BETA = 25 / 6
BSQ = BETA * BETA
TAU = 1 / 3
EPS = 1e-4
SERVER = (13, 25, 35)  # src/lavaos/lava.ts ROOKIE_MU_HANDICAP_START/DECAY/GAMES


def phi(x):
    return 0.5 * math.erfc(-x / math.sqrt(2))


def handicap(prior, a, t, n):
    return a * math.exp(-prior / t) if prior < n else 0.0


def plackett_luce(teams):
    tm = [sum(m for m, _ in t) for t in teams]
    ts = [sum(s * s for _, s in t) for t in teams]
    c = math.sqrt(sum(s + BSQ for s in ts))
    e = [math.exp(m / c) for m in tm]
    sq = [sum(e[i] for i in range(len(e)) if i >= q) for q in range(len(teams))]
    out = []
    for i, t in enumerate(teams):
        om = de = 0.0
        for q in range(i + 1):
            tmp = e[i] / sq[q]
            om += (1 - tmp) if q == i else -tmp
            de += tmp * (1 - tmp)
        g = math.sqrt(ts[i]) / c
        oi, di = om * ts[i] / c, g * de * ts[i] / c / c
        out.append([(m + (s * s / ts[i]) * oi, s * math.sqrt(max(1 - (s * s / ts[i]) * di, EPS))) for m, s in t])
    return out


def rate(teams):
    """openskill rate(): σ inflated by τ, never above its pre-match value. Winners first."""
    out = plackett_luce([[(m, math.sqrt(s * s + TAU * TAU)) for m, s in t] for t in teams])
    return [[(m, min(teams[i][j][1], s)) for j, (m, s) in enumerate(t)] for i, t in enumerate(out)]


def fold(games, curve):
    """Pre-game (μ, σ, prior games) per player per game, refolded under `curve`."""
    state, out = {}, []
    for g in games:
        pre = [[state.get(x["userId"], (25.0, 25 / 3, 0)) for x in t] for t in g["teams"]]
        out.append(pre)
        order = [g["winnerTeam"], 1 - g["winnerTeam"]]
        up = rate([[(m - handicap(n, *curve), s) for m, s, n in pre[k]] for k in order])
        for oi, k in enumerate(order):
            for j, x in enumerate(g["teams"][k]):
                _, _, n = pre[k][j]
                um, us = up[oi][j]
                state[x["userId"]] = (um + handicap(n, *curve), us, n + 1)
    return out


def scores(games, curve):
    """Per-game log-loss of predictWin under `curve`."""
    res = []
    for g, pre in zip(games, fold(games, curve)):
        d = sum(m - handicap(n, *curve) for m, _, n in pre[0]) - sum(m - handicap(n, *curve) for m, _, n in pre[1])
        v = sum(s * s for t in pre for _, s, _ in t)
        p = min(max(phi(d / math.sqrt(len(pre[0] + pre[1]) * BSQ + v)), 1e-9), 1 - 1e-9)
        res.append(-math.log(p) if g["winnerTeam"] == 0 else -math.log(1 - p))
    return res


def fetch(url, cache, refresh=False):
    os.makedirs(cache, exist_ok=True)
    games, page = {}, 1
    while True:
        path = os.path.join(cache, f"page{page}.json")
        if refresh or not os.path.exists(path):
            req = urllib.request.Request(f"{url}/api/games?page={page}&limit=100", headers={"user-agent": "curl/8"})
            with urllib.request.urlopen(req, timeout=60) as r:
                open(path, "wb").write(r.read())
        gs = json.load(open(path))["games"]
        if not gs:
            break
        for g in gs:
            games[g["id"]] = g
        page += 1
    rated = [g for g in games.values() if not g["ignored"] and not g["excluded"] and not g["unrankedReason"] and g["winnerTeam"] in (0, 1)]
    return sorted(rated, key=lambda g: g["startTime"])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="https://lavabalance.fogofwar.dev")
    ap.add_argument("--cache", default="/tmp/los-handicap-fit")
    ap.add_argument("--check", help="score one curve A,T,N against the server's instead of fitting")
    args = ap.parse_args()
    games = fetch(args.url, args.cache, refresh=bool(args.check))

    worst = 0.0
    for g, pre in zip(games, fold(games, SERVER)):
        for t, pt in zip(g["teams"], pre):
            for x, (m, _, _) in zip(t, pt):
                if x["muBefore"] is not None:
                    worst = max(worst, abs(m - x["muBefore"]))
    print(f"{len(games)} rated games; refold under the server's curve {SERVER} vs stored μ: max |Δ| = {worst:.1e}")

    month = [g["startTime"][:7] for g in games]
    folds = sorted(set(month))

    def by_month(curve):
        s, c = defaultdict(float), defaultdict(int)
        for m, l in zip(month, scores(games, curve)):
            s[m] += l
            c[m] += 1
        return s, c

    if args.check:
        other = tuple(float(v) for v in args.check.split(","))
        for label, curve in (("server", SERVER), ("candidate", other)):
            s, c = by_month(curve)
            print(f"{label:9s} {curve}: " + "  ".join(f"{m} {s[m] / c[m]:.4f}" for m in folds) + f"  | all {sum(s.values()) / sum(c.values()):.4f}")
        return

    grid = list(itertools.product([8, 10, 11, 12, 13, 14, 15, 16, 18], [10, 15, 20, 25, 30, 40], [20, 25, 30, 35, 40]))
    tab = {k: by_month(k) for k in grid}
    tab[SERVER] = by_month(SERVER)
    tot = cur = fit = 0.0
    print("held-out month   games  chosen on the others     server   refit")
    for f in folds:
        best = min(grid, key=lambda k: sum(v for m, v in tab[k][0].items() if m != f) / sum(v for m, v in tab[k][1].items() if m != f))
        n = tab[best][1][f]
        a, b = tab[SERVER][0][f] / n, tab[best][0][f] / n
        tot, cur, fit = tot + n, cur + a * n, fit + b * n
        print(f"{f}          {n:5d}  {str(best):22s} {a:.4f}   {b:.4f}")
    print(f"pooled log-loss: server {cur / tot:.4f}, leave-one-month-out refit {fit / tot:.4f}")
    overall = min(grid, key=lambda k: sum(tab[k][0].values()))
    print(f"best on all months: {overall}")


if __name__ == "__main__":
    main()
