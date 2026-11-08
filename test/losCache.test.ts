// The bot's LOS cache — the age rule above all.
//
// The 2026-09-07 23:59 case: the lobby finished a game at 23:55, the LOS store
// ingested it at 23:59:07, and the `.balance` at 23:59:41 ran on ratings cached
// before the game. It announced "26.8 (50.0% win) vs 26.7 (50.0% win)" for the
// teams the website — same store, current — scored 26.3 (38.3%) vs 27.2 (61.7%),
// and the game launched that way.

import { describe, expect, it } from "vitest";
import { LosCache, losKey } from "../src/bot/losCache";

interface Rating {
  los: number;
}

const found = (m: Record<string, Rating>) => (n: string) => m[losKey(n)];

describe("LosCache", () => {
  it("refreshes an entry older than the max age, keeps a fresh one", () => {
    const c = new LosCache<Rating>(100);
    c.remember(["Wherewolf", "Songi"], found({ wherewolf: { los: 60.1 }, songi: { los: 52.0 } }), 0);

    expect(c.namesToRefresh(["Wherewolf", "Songi"], 15_000, 10_000)).toEqual([]);
    expect(c.namesToRefresh(["Wherewolf", "Songi"], 15_000, 20_000)).toEqual(["Wherewolf", "Songi"]);
  });

  it("a rating cached before a game is refreshed once the store has the game", () => {
    // The real timeline, in ms from the game's launch.
    const c = new LosCache<Rating>(100);
    const preGame = { wherewolf: { los: 60.115 } };
    const postGame = { wherewolf: { los: 59.649 } };
    c.remember(["Wherewolf"], found(preGame), 0);

    // 23:59:41 — 34s after the store ingested the game (and ~18min after launch).
    const balanceAt = 18 * 60_000;
    expect(c.namesToRefresh(["Wherewolf"], 15_000, balanceAt)).toEqual(["Wherewolf"]);
    c.remember(["Wherewolf"], found(postGame), balanceAt);
    expect(c.get("Wherewolf")?.los).toBe(59.649);
  });

  it("never resolved is always a refresh, whatever the max age", () => {
    const c = new LosCache<Rating>(100);
    expect(c.namesToRefresh(["newbie"], Number.MAX_SAFE_INTEGER, 0)).toEqual(["newbie"]);
    expect(c.has("newbie")).toBe(false);
  });

  it("caches 'not rated' as an answer, so an unrated player is not re-fetched", () => {
    const c = new LosCache<Rating>(100);
    c.remember(["debutant"], found({}), 0);
    expect(c.has("debutant")).toBe(true);
    expect(c.get("debutant")).toBeNull();
    expect(c.namesToRefresh(["debutant"], 15_000, 1_000)).toEqual([]);
  });

  it("matches names case- and whitespace-insensitively", () => {
    const c = new LosCache<Rating>(100);
    c.remember(["Wherewolf"], found({ wherewolf: { los: 60 } }), 0);
    expect(c.get("  WHEREWOLF ")?.los).toBe(60);
    expect(c.namesToRefresh(["wherewolf"], 15_000, 1_000)).toEqual([]);
  });

  it("prunes the oldest entries past the cap", () => {
    const c = new LosCache<Rating>(2);
    c.remember(["a"], found({ a: { los: 1 } }), 0);
    c.remember(["b"], found({ b: { los: 2 } }), 10);
    c.remember(["c"], found({ c: { los: 3 } }), 20);
    expect(c.size).toBe(2);
    expect(c.has("a")).toBe(false);
    expect(c.has("c")).toBe(true);
  });
});
