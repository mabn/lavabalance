// The SQL cost accounting (src/sqlStats.ts) on the two SQLite-backed DOs, inside
// workerd: every statement is billed to the public method that ran it (outermost
// wins — a helper bills its caller), the exec shim keeps the cursor iterable, and
// GET /api/sqlstats serves one report per DO.

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { fetchAs } from "./adminFetch";
import { describe, expect, it } from "vitest";
import type { RatingsDO } from "../src/rating/ratingsDO";
import type { SqlStatsReport } from "../src/sqlStats";

/** Admin routes as a superadmin (./adminFetch), everything else as a visitor. */
const call = fetchAs((url, init) => SELF.fetch(url, init));

const BASE = "https://lavabalance.test";

function opsOf(report: SqlStatsReport): Map<string, { calls: number; rowsRead: number; rowsWritten: number }> {
  return new Map(report.ops.map((o) => [o.op, o]));
}

describe("RatingsDO SQL accounting", () => {
  it("bills each statement to the public method, helpers to their caller", async () => {
    const stub = env.RATINGS.get(env.RATINGS.idFromName("sqlstats-attribution"));
    await runInDurableObject(stub, async (instance: RatingsDO) => {
      // No network: the background scrape `get` schedules resolves everyone as unknown.
      (instance as unknown as { fetchRating: () => Promise<null> }).fetchRating = async () => null;

      const before = instance.sqlStatsReport();
      // The constructor's schema DDL is in the tally too.
      expect(opsOf(before).has("ensureSchema")).toBe(true);
      expect(opsOf(before).has("putScores")).toBe(false);

      await instance.putScores({ alpha: 1500, beta: 1600 });
      const stored = await instance.get(["alpha", "beta", "nobody"]);
      // The rows came back through the exec shim's iterable cursor.
      expect(Object.keys(stored).sort()).toEqual(["alpha", "beta"]);

      const ops = opsOf(instance.sqlStatsReport());
      expect(ops.get("putScores")?.calls).toBe(1);
      expect(ops.get("putScores")?.rowsWritten).toBeGreaterThanOrEqual(2);
      expect(ops.get("get")?.calls).toBe(1);
      expect(ops.get("get")?.rowsRead).toBeGreaterThanOrEqual(2);
      // selectMany ran under both — it is a helper, so it never gets its own line.
      expect(ops.has("selectMany")).toBe(false);
      expect(ops.has("(outside any method)")).toBe(false);
    });
  });

  it("reports totals, the window, and sorts the most expensive method first", async () => {
    const stub = env.RATINGS.get(env.RATINGS.idFromName("sqlstats-report"));
    await runInDurableObject(stub, async (instance: RatingsDO) => {
      const t0 = Date.now();
      await instance.putScores({ gamma: 1000 });
      const report = instance.sqlStatsReport();
      expect(report.since).toBeLessThanOrEqual(t0);
      expect(report.elapsedSec).toBeGreaterThanOrEqual(0);
      const sumRead = report.ops.reduce((n, o) => n + o.rowsRead, 0);
      const sumWritten = report.ops.reduce((n, o) => n + o.rowsWritten, 0);
      expect(report.totals).toEqual({ rowsRead: sumRead, rowsWritten: sumWritten });
      const cost = report.ops.map((o) => o.rowsRead + o.rowsWritten);
      expect(cost).toEqual([...cost].sort((a, b) => b - a));
    });
  });
});

describe("GET /api/sqlstats", () => {
  it("serves one report per SQLite-backed DO, with the LOS reads attributed", async () => {
    // Touch the LOS store through a public route first so its tally has that method.
    expect((await call(`${BASE}/api/ranking`)).status).toBe(200);

    const res = await call(`${BASE}/api/sqlstats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dos: ({ name: string } & SqlStatsReport)[] };
    expect(body.dos.map((d) => d.name)).toEqual(["RatingsDO", "LosDO"]);
    for (const d of body.dos) {
      expect(typeof d.since).toBe("number");
      expect(typeof d.elapsedSec).toBe("number");
      expect(Array.isArray(d.ops)).toBe(true);
      expect(d.totals).toEqual({ rowsRead: expect.any(Number), rowsWritten: expect.any(Number) });
    }
    const los = opsOf(body.dos[1]!);
    expect(los.has("ensureSchema")).toBe(true);
    expect(los.get("ranking")?.calls).toBeGreaterThanOrEqual(1);
    // Serving the report itself costs nothing: the tally is in memory.
    expect(los.has("sqlStatsReport")).toBe(false);
  });

  it("serves the admin-only SQL page", async () => {
    const res = await call(`${BASE}/sql`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>lavabalance · SQL</title>");
  });
});
