// Workers-pool test for the RatingsDO Durable Object: exercises the persistent SQLite cache
// (bulk read/write, only-write-on-change, updated_at) inside the real workerd runtime.
//
// The Lavabar network fetch is stubbed via the protected `fetchRating` seam — we override it
// on the live instance (through runInDurableObject) so the test is deterministic and never
// touches the network. We drive the cache by calling the internal `refresh` directly (and
// awaiting it) rather than relying on the background `waitUntil` the public `get` schedules.

import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { normalizeName, type PlayerRating } from "../src/rating/lavaRatings";
import type { RatingsDO } from "../src/rating/ratingsDO";

const POLONIUM: PlayerRating = {
  playerId: 5106,
  rating: 4407,
  wins: 225,
  losses: 93,
  games: 318,
  winRate: 0.708,
};
const CADE: PlayerRating = {
  playerId: 4242,
  rating: 3000,
  wins: 10,
  losses: 5,
  games: 15,
  winRate: 0.667,
};

/** A fresh, isolated DO instance per test (distinct name → distinct SQLite storage). */
function instanceFor(name: string) {
  return env.RATINGS.get(env.RATINGS.idFromName(name));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("RatingsDO cache", () => {
  it("bulk-fetches missing names once and serves them from the cache", async () => {
    const stub = instanceFor("bulk-fetch");
    const calls: string[] = [];

    await runInDurableObject(stub, async (instance: RatingsDO) => {
      // Stub the network: known players resolve, everyone else is "not found" (null).
      (instance as unknown as { fetchRating: (n: string) => Promise<PlayerRating | null> })
        .fetchRating = async (n: string) => {
        calls.push(n);
        if (n === "[cade]polonium210") return POLONIUM;
        if (n === "[cade]deadvegancat") return CADE;
        return null;
      };

      // Mixed-case input exercises name normalization.
      await (instance as unknown as { refresh: (k: string[], now: number) => Promise<void> })
        .refresh(["[cade]polonium210", "[cade]deadvegancat", "ghost"], Date.now());

      const out = await instance.get(["[CADE]Polonium210", "[CADE]DeadVeganCat", "Ghost"]);
      expect(out[normalizeName("[CADE]Polonium210")]?.rating).toBe(4407);
      expect(out[normalizeName("[CADE]DeadVeganCat")]?.playerId).toBe(4242);
      expect(out[normalizeName("Ghost")]).toBeUndefined(); // negative result omitted
    });

    expect(calls.sort()).toEqual(["[cade]deadvegancat", "[cade]polonium210", "ghost"]);
  });

  it("only writes rows whose value changed (updated_at stays put otherwise)", async () => {
    const stub = instanceFor("write-on-change");

    await runInDurableObject(stub, async (instance: RatingsDO) => {
      const inst = instance as unknown as {
        fetchRating: (n: string) => Promise<PlayerRating | null>;
        refresh: (k: string[], now: number) => Promise<void>;
        selectMany: (k: string[]) => Map<string, { rating: number | null; updatedAt: number }>;
      };
      let current: PlayerRating = POLONIUM;
      inst.fetchRating = async () => current;
      const key = normalizeName("[CADE]Polonium210");

      await inst.refresh([key], Date.now());
      const u1 = inst.selectMany([key]).get(key)!.updatedAt;
      expect(inst.selectMany([key]).get(key)!.rating).toBe(4407);

      // Re-fetch the SAME value: no row should be rewritten, so updated_at is unchanged.
      await sleep(5);
      await inst.refresh([key], Date.now());
      expect(inst.selectMany([key]).get(key)!.updatedAt).toBe(u1);

      // Now the value changes: the row is rewritten and updated_at advances.
      await sleep(5);
      current = { ...POLONIUM, rating: 4500 };
      await inst.refresh([key], Date.now());
      const row = inst.selectMany([key]).get(key)!;
      expect(row.rating).toBe(4500);
      expect(row.updatedAt).toBeGreaterThan(u1);
    });
  });

  it("get returns nothing for an empty cache (background refresh fills it later)", async () => {
    const stub = instanceFor("cold-cache");
    await runInDurableObject(stub, async (instance: RatingsDO) => {
      (instance as unknown as { fetchRating: (n: string) => Promise<PlayerRating | null> })
        .fetchRating = async () => POLONIUM;
      const out = await instance.get(["[CADE]Polonium210"]);
      expect(out).toEqual({}); // nothing cached yet on the first call
    });
  });

  it("writes and reads batches larger than SQLite's 100-param limit (chunked)", async () => {
    // Regression for "too many SQL variables": a multi-row INSERT binds 10 columns per row,
    // so >10 changed rows used to exceed the 100-param cap; a >100-key SELECT did too.
    const stub = instanceFor("large-batch");
    await runInDurableObject(stub, async (instance: RatingsDO) => {
      const inst = instance as unknown as {
        fetchRating: (n: string) => Promise<PlayerRating | null>;
        refresh: (k: string[], now: number) => Promise<void>;
        selectMany: (k: string[]) => Map<string, { rating: number | null }>;
      };
      // MAX_FETCH_PER_REFRESH caps a refresh at 64 names → 64 rows × 10 = 640 params.
      const names = Array.from({ length: 64 }, (_, i) => `player${i}`);
      inst.fetchRating = async (n: string) => ({ ...CADE, rating: Number(n.slice(6)) });

      await inst.refresh(names, Date.now());

      // INSERT chunking: every one of the 64 rows persisted.
      const written = inst.selectMany(names);
      expect(written.size).toBe(64);
      expect(written.get("player63")?.rating).toBe(63);

      // SELECT chunking: a >100-key IN(...) read (the 64 real names + 60 misses) succeeds.
      const probe = [...names, ...Array.from({ length: 60 }, (_, i) => `miss${i}`)];
      expect(probe.length).toBeGreaterThan(100);
      const out = await instance.get(probe);
      expect(Object.keys(out).length).toBe(64);
      expect(out[normalizeName("player10")]?.rating).toBe(10);
    });
  });

  it("caches negative lookups without rewriting them on repeat", async () => {
    const stub = instanceFor("negative-cache");
    await runInDurableObject(stub, async (instance: RatingsDO) => {
      const inst = instance as unknown as {
        fetchRating: (n: string) => Promise<PlayerRating | null>;
        refresh: (k: string[], now: number) => Promise<void>;
        selectMany: (k: string[]) => Map<string, { found: number; updatedAt: number }>;
      };
      inst.fetchRating = async () => null; // confirmed "no such player"
      const key = normalizeName("ghost");

      await inst.refresh([key], Date.now());
      const row = inst.selectMany([key]).get(key)!;
      expect(row.found).toBe(0);
      const u1 = row.updatedAt;

      await sleep(5);
      await inst.refresh([key], Date.now());
      expect(inst.selectMany([key]).get(key)!.updatedAt).toBe(u1); // unchanged → no rewrite
    });
  });

  it("putScores writes rating_hidden only; the scrape's columns are untouched", async () => {
    const stub = instanceFor("two-column-put");
    await runInDurableObject(stub, async (instance: RatingsDO) => {
      const inst = instance as unknown as {
        fetchRating: (n: string) => Promise<PlayerRating | null>;
        refresh: (k: string[], now: number) => Promise<void>;
      };
      // Public side first: the scrape rates polonium.
      inst.fetchRating = async () => POLONIUM;
      await inst.refresh(["[cade]polonium210"], Date.now());

      await instance.putScores({ "[cade]polonium210": 4400, godofwar09: 4022 });

      const out = await instance.get(["[CADE]Polonium210", "GODOFWAR09"]);
      // Public player: public rating intact, balance elo alongside, real player id kept.
      expect(out["[cade]polonium210"]).toMatchObject({
        rating: 4407,
        ratingHidden: 4400,
        playerId: 5106,
      });
      // Balance-only player: hidden by data — no public rating, elo present.
      expect(out["godofwar09"]).toMatchObject({ rating: null, ratingHidden: 4022, playerId: 0 });
    });
  });

  it("a scrape miss never disturbs rating_hidden (and vice versa)", async () => {
    // The columns belong to different sources with different coverage: the players worth
    // hiding are exactly the ones the search page can't rate, so the scrape's "not found"
    // must leave the balance elo alone — and recording a fresh elo must not touch the
    // scrape's negative either.
    const stub = instanceFor("two-column-isolation");
    await runInDurableObject(stub, async (instance: RatingsDO) => {
      const inst = instance as unknown as {
        fetchRating: (n: string) => Promise<PlayerRating | null>;
        refresh: (k: string[], now: number) => Promise<void>;
      };
      await instance.putScores({ godofwar09: 4022 });

      inst.fetchRating = async () => null; // the search page can't rate him
      await inst.refresh(["godofwar09"], Date.now());
      expect((await instance.get(["GODOFWAR09"]))["godofwar09"]).toMatchObject({
        rating: null,
        ratingHidden: 4022,
      });

      // A later balance refresh updates the elo without inventing a public rating.
      await instance.putScores({ godofwar09: 4029 });
      expect((await instance.get(["GODOFWAR09"]))["godofwar09"]).toMatchObject({
        rating: null,
        ratingHidden: 4029,
      });
    });
  });

  it("a balance-created row reads as maximally stale, so the scrape fills the public side", async () => {
    const stub = instanceFor("balance-then-scrape");
    await runInDurableObject(stub, async (instance: RatingsDO) => {
      const inst = instance as unknown as {
        fetchRating: (n: string) => Promise<PlayerRating | null>;
        refresh: (k: string[], now: number) => Promise<void>;
        selectMany: (k: string[]) => Map<string, { updatedAt: number }>;
      };
      await instance.putScores({ "[cade]polonium210": 4400 });
      expect(inst.selectMany(["[cade]polonium210"]).get("[cade]polonium210")!.updatedAt).toBe(0);

      inst.fetchRating = async () => POLONIUM;
      await inst.refresh(["[cade]polonium210"], Date.now());
      expect((await instance.get(["[CADE]Polonium210"]))["[cade]polonium210"]).toMatchObject({
        rating: 4407, // public side filled in by the scrape…
        ratingHidden: 4400, // …with the balance elo preserved
      });
    });
  });

  it("migrates a table created before the rating_hidden column existed", async () => {
    // The migration runs in the CONSTRUCTOR, so getting it wrong fails every rating request.
    const stub = instanceFor("migration");
    await runInDurableObject(stub, async (instance: RatingsDO) => {
      const inst = instance as unknown as { sql: SqlStorage; ensureSchema: () => void };
      inst.sql.exec("ALTER TABLE ratings DROP COLUMN rating_hidden");
      inst.sql.exec(
        `INSERT INTO ratings (name, found, player_id, rating, wins, losses, games, win_rate, updated_at)
         VALUES ('legacy', 1, 7, 2000, 5, 5, 10, 0.5, 1)`,
      );

      inst.ensureSchema(); // what the constructor does on the first request after deploy
      inst.ensureSchema(); // idempotent: a second instantiation must not throw

      // The pre-existing public rating survives, and the new column works on it.
      expect((await instance.get(["legacy"]))["legacy"]).toMatchObject({
        rating: 2000,
        ratingHidden: null,
      });
      await instance.putScores({ legacy: 2100 });
      expect((await instance.get(["legacy"]))["legacy"]).toMatchObject({
        rating: 2000,
        ratingHidden: 2100,
      });
    });
  });
});
