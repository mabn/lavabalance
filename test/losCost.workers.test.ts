// Cost guard for the LOS reads: DO SQLite bills per ROW READ, and the counts
// table, the materialized ranks and the ranking's two indexes all exist so that
// no read pays for rows it does not serve. That property is invisible in the
// output of every other test — a page that scans the whole player table returns
// exactly the same JSON — so it is pinned here, two ways: the query plans the
// reads plan to, and the rows they actually cost, measured through the DO's own
// accounting (src/sqlStats.ts, the same numbers /sql shows).
//
// The store below is deliberately lopsided: most of its players have lapsed, so
// the ranking's rankless tail is the big half. A read whose cost tracks the
// TABLE rather than the page shows up as an outlier here.

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { fetchAs } from "./adminFetch";
import { beforeAll, describe, expect, it } from "vitest";
import { lavaReplay } from "./losFixtures";

/** Admin routes as a superadmin (./adminFetch), everything else as a visitor. */
const call = fetchAs((url, init) => SELF.fetch(url, init));

const BASE = "https://lavaos.test";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows read per public method, from the DO's own accounting. */
async function rowsRead(): Promise<Record<string, number>> {
  const stats = (await (await call(`${BASE}/api/sqlstats`)).json()) as {
    dos: { name: string; ops: { op: string; rowsRead: number }[] }[];
  };
  const los = stats.dos.find((d) => d.name === "LosDO")!;
  return Object.fromEntries(los.ops.map((o) => [o.op, o.rowsRead]));
}

/** What one request costs, as the delta across it. */
async function cost(path: string): Promise<number> {
  const before = await rowsRead();
  const res = await call(`${BASE}${path}`);
  expect(res.status).toBe(200);
  const after = await rowsRead();
  return Object.entries(after).reduce((sum, [k, v]) => sum + (v - (before[k] ?? 0)), 0);
}

let store = { players: 0, ranked: 0, unranked: 0 };

beforeAll(async () => {
  await call(`${BASE}/api/reset?confirm=true`, { method: "POST" });
  // 60 games over a year across two disjoint casts: the first 40 are old enough
  // that their players have lapsed, the last 20 are recent.
  const games = Array.from({ length: 60 }, (_, g) => {
    const daysAgo = g < 40 ? 300 - g * 6 : 30 - (g - 40);
    const pool = g < 40 ? 100 : 900;
    return lavaReplay({
      id: `g${g}`,
      startTime: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
      teams: [
        Array.from({ length: 8 }, (_, i) => pool + ((g * 16 + i) % 400)),
        Array.from({ length: 8 }, (_, i) => pool + ((g * 16 + 8 + i) % 400)),
      ] as [number[], number[]],
    });
  });
  const res = await call(`${BASE}/api/games`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(games),
  });
  expect(res.status).toBe(200);
  for (const id of [101, 905]) {
    await call(`${BASE}/api/players/${id}/private`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ private: true }),
    });
  }
  const stub = env.LOS.get(env.LOS.idFromName("singleton"));
  await runInDurableObject(stub, async (instance) => {
    const priv = instance as unknown as { sql: SqlStorage };
    const n = (sql: string) => Number([...priv.sql.exec(sql)][0].n);
    store = {
      players: n(`SELECT COUNT(*) AS n FROM players`),
      ranked: n(`SELECT COUNT(*) AS n FROM players WHERE ranked = 1`),
      unranked: n(`SELECT COUNT(*) AS n FROM players WHERE ranked = 0`),
    };
  });
  // Most of the store must be in the tail, or this file proves nothing.
  expect(store.players).toBeGreaterThan(500);
  expect(store.unranked).toBeGreaterThan(store.ranked);
  // Warm the per-instance private-id set, so its one-off load (see below) does
  // not land on whichever read happens to be measured first.
  await call(`${BASE}/api/games?limit=1`);
});

describe("read cost", () => {
  it("plans every read to an index, and walks the table only where it means to", async () => {
    const stub = env.LOS.get(env.LOS.idFromName("singleton"));
    await runInDurableObject(stub, async (instance) => {
      const priv = instance as unknown as { sql: SqlStorage };
      const plan = (sql: string, ...b: unknown[]) =>
        [...priv.sql.exec(`EXPLAIN QUERY PLAN ${sql}`, ...(b as never[]))]
          .map((r) => String(r.detail))
          .join(" | ");

      // The ranking's two halves: each keys on `ranked` and takes its order
      // from the index, so neither sorts nor touches the other half's rows.
      const head = plan(
        `SELECT user_id FROM players WHERE ranked = 1 ORDER BY los DESC, user_id LIMIT 50 OFFSET 0`,
      );
      expect(head).toContain("idx_players_ranked");
      expect(head).not.toContain("TEMP B-TREE");
      const tail = plan(
        `SELECT user_id FROM players WHERE ranked = 0 ORDER BY last_played DESC, user_id LIMIT 50 OFFSET 100`,
      );
      expect(tail).toContain("idx_players_unranked");
      expect(tail).not.toContain("TEMP B-TREE");

      // The search reads its matches through the NAME index. It carries no
      // ORDER BY on purpose: adding one lets the planner prefer a ranking index
      // and walk every ranked player instead of the few the prefix matches.
      const search = plan(`SELECT user_id FROM players WHERE name LIKE ?1 ESCAPE '\\'`, "player1%");
      expect(search).toContain("idx_players_name");

      // The reads that address a player, a game or a roster directly.
      for (const sql of [
        `SELECT rank FROM players WHERE user_id = 101`,
        `SELECT user_id FROM players WHERE name COLLATE NOCASE IN ('player101')`,
        `SELECT game_id FROM game_players WHERE game_id IN ('g1','g2')`,
        `SELECT id FROM games ORDER BY start_time DESC, id DESC LIMIT 25`,
        `SELECT gp.game_id FROM game_players gp JOIN games g ON g.id = gp.game_id
          WHERE gp.user_id = 101 ORDER BY gp.start_time DESC, gp.game_id DESC LIMIT 10`,
      ]) {
        expect(plan(sql)).not.toContain("SCAN players");
      }

      // Every SORT the PUBLIC ranking offers, both directions, taking its order
      // from an index rather than a temp b-tree. The change indexes lead with
      // `ranked` because that is the list every visitor loads — the public
      // head — and their clauses must repeat the `<col> IS NULL` key TEXTUALLY
      // as the index declares it, that key being what keeps "no baseline" at
      // the bottom whichever way the column is read, and the first thing a
      // rewrite drops.
      //
      // The ADMIN view (?includePrivate=true) is the documented exception: it
      // is one flat list over everyone, so a sort by a change column has no
      // leading `ranked` to seek on and SQLite sorts the table. That is a
      // couple of thousand rows on a maintainer's click, not a scan on anything
      // polled — the same trade every human-initiated read here is allowed. It
      // is asserted below so the exception stays deliberate.
      for (const [where, order, index] of [
        ["", "ORDER BY los DESC, user_id", "idx_players_ranking"],
        ["", "ORDER BY los ASC, user_id DESC", "idx_players_ranking"],
        ["WHERE ranked = 1", "ORDER BY los DESC, user_id", "idx_players_ranked"],
        ["WHERE ranked = 1", "ORDER BY los ASC, user_id DESC", "idx_players_ranked"],
        ["WHERE ranked = 1", "ORDER BY los_change_7d IS NULL, los_change_7d DESC, user_id",
          "idx_players_los_change_desc"],
        ["WHERE ranked = 1", "ORDER BY los_change_7d IS NULL, los_change_7d ASC, user_id",
          "idx_players_los_change_asc"],
        ["WHERE ranked = 1", "ORDER BY rank_change_7d IS NULL, rank_change_7d DESC, user_id",
          "idx_players_rank_change_desc"],
        ["WHERE ranked = 1", "ORDER BY rank_change_7d IS NULL, rank_change_7d ASC, user_id",
          "idx_players_rank_change_asc"],
        // The tier board: the visitors' ONLY list, and an admin's sort.
        ["WHERE ranked = 1", "ORDER BY tier DESC, games DESC, user_id", "idx_players_tier_ranked"],
        ["WHERE ranked = 1", "ORDER BY tier ASC, games ASC, user_id DESC", "idx_players_tier_ranked"],
        ["", "ORDER BY tier DESC, games DESC, user_id", "idx_players_tier"],
      ] as const) {
        const sorted = plan(`SELECT user_id FROM players ${where} ${order} LIMIT 50 OFFSET 0`);
        expect(sorted, order).toContain(index);
        expect(sorted, order).not.toContain("TEMP B-TREE");
      }
      // The exception, stated rather than left to be discovered.
      expect(
        plan(`SELECT user_id FROM players ORDER BY los_change_7d IS NULL, los_change_7d DESC, user_id LIMIT 50`),
      ).toContain("TEMP B-TREE");

      // The only two full walks, both deliberate and neither on a page's path:
      // refreshRanks (once per upload / per activity sweep) and the one-off load
      // of the private-id set (once per DO instance, then cached in memory).
      expect(plan(`SELECT user_id, rank FROM players ORDER BY los DESC, user_id`))
        .toContain("idx_players_ranking");
      expect(plan(`SELECT user_id FROM players WHERE private_profile = 1`)).toContain("players");
    });
  });

  it("costs each read its own page, not the table behind it", async () => {
    // Bounds are generous — this guards ORDERS of magnitude, not exact counts,
    // and the numbers in the comments are what it measured when written.
    expect(await cost("/api/ranking?perPage=50")).toBeLessThan(150); // 54
    expect(await cost("/api/ranking?perPage=50&page=8")).toBeLessThan(200); // 85, deep in the tail
    expect(await cost("/api/ranking?perPage=50&includePrivate=true")).toBeLessThan(150); // 54
    expect(await cost("/api/players/905")).toBeLessThan(30); // 3
    expect(await cost("/api/players/905/history")).toBeLessThan(60); // 12
    expect(await cost("/api/players/905/games?limit=10")).toBeLessThan(300); // 44
    expect(await cost("/api/games?limit=25")).toBeLessThan(700); // 477 — 25 games + 400 roster rows
    expect(await cost("/api/games/g1")).toBeLessThan(60); // 18
    expect(await cost("/api/players/lookup?names=player101,player102")).toBeLessThan(30); // 6

    // Blanking a private player's rating must stay free: it is a set lookup on
    // the cached id set, not a question put to SQLite once per roster row.
    const pub = await cost("/api/games?limit=25");
    const admin = await cost("/api/games?limit=25&includePrivate=true");
    expect(pub).toBe(admin);

    // A search costs its MATCHES, once — not the ranked half of the table per
    // query, which is what an `AND ranked = ?` alongside the LIKE used to buy.
    const matches = (await (await call(`${BASE}/api/ranking?q=player1&perPage=50`)).json()) as {
      total: number;
    };
    expect(matches.total).toBeGreaterThan(200); // the prefix really is broad here
    expect(await cost("/api/ranking?q=player1&perPage=50")).toBeLessThan(matches.total + 60);
    // A narrow prefix costs almost nothing, however big the store is.
    expect(await cost("/api/ranking?q=player1001&perPage=50")).toBeLessThan(40);
  });
});
