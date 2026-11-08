// The composition watcher's state machine. Every scenario here is one the
// 2026-09-07 logs actually produced (or the fix for it): a `.status` on a stacked
// lobby silently disarming the watcher, a rebalance judged against a half-applied
// `!fb`, two conflicting forces 80 ms apart, 21 rebalances in three minutes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompositionWatcher,
  rebalanceVerdict,
  teamsLanded,
  type CompWatcherConfig,
  type CompWatcherHooks,
  type WatchedPlayer,
} from "../src/bot/compWatcher";

const CFG: CompWatcherConfig = {
  fullLobby: 16,
  degradePp: 10,
  absUnfairPp: 20,
  debounceMs: 100,
  blackoutMs: 3_000,
  retryCooldownMs: 30_000,
};

/** A 16-player roster split `left` on ally 0 and the rest on ally 1. */
function lobby(onZero: number, size = 16, allies: [number, number] = [0, 1]): WatchedPlayer[] {
  return Array.from({ length: size }, (_, i) => ({
    name: `p${i}`,
    ally: i < onZero ? allies[0] : allies[1],
  }));
}

const signatureOf = (players: WatchedPlayer[]): string =>
  players
    .map((p) => `${p.name.toLowerCase()}:${p.ally}`)
    .sort()
    .join(",");

/**
 * A watcher wired to a mutable fake lobby. `win` is what the (fake) rating model
 * says team 1's chance is; `rebalance` records the calls instead of forcing.
 */
function harness(
  opts: { win?: number; blocked?: string | null; cfg?: Partial<CompWatcherConfig> } = {},
) {
  const state = {
    players: lobby(8),
    win: opts.win ?? 50,
    inGame: false,
    blocked: opts.blocked ?? null,
    logs: [] as string[],
    errors: [] as string[],
    rebalances: [] as number[],
    /** Announce hooks: what bot.ts holds the matchup line on. */
    landed: 0,
    lost: 0,
    /** What `rebalance` should do — by default nothing (as if nothing was sent). */
    onRebalance: undefined as ((w: CompositionWatcher, currentWin: number) => void) | undefined,
  };
  const hooks: CompWatcherHooks = {
    signature: () => signatureOf(state.players),
    players: () => state.players,
    winChance: async () => state.win,
    gameInProgress: () => state.inGame,
    forceBlocked: () => state.blocked,
    rebalance: async (currentWin) => {
      state.rebalances.push(currentWin);
      state.onRebalance?.(watcher, currentWin);
    },
    onTeamsLanded: () => void state.landed++,
    onForceLost: () => void state.lost++,
    status: (m) => state.logs.push(m),
    onError: (c, e) => state.errors.push(`${c}: ${String(e)}`),
  };
  const watcher = new CompositionWatcher({ ...CFG, ...opts.cfg }, hooks);
  return { state, watcher };
}

/** Let the debounce fire and every promise it started settle. */
async function settle(ms = CFG.debounceMs): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("teamsLanded", () => {
  const want = { first: ["a", "b"], second: ["c", "d"] };

  it("is false while the force is only half applied", () => {
    // What the bot measured at 19:54:07.901: SPADS moving players one line at a
    // time, so the lobby passes through 14-2, 13-3, 12-4 … before it settles.
    expect(
      teamsLanded(want, [
        { name: "a", ally: 0 },
        { name: "b", ally: 1 },
        { name: "c", ally: 1 },
        { name: "d", ally: 1 },
      ]),
    ).toBe(false);
  });

  it("is true once each group shares a side", () => {
    expect(
      teamsLanded(want, [
        { name: "a", ally: 0 },
        { name: "b", ally: 0 },
        { name: "c", ally: 1 },
        { name: "d", ally: 1 },
      ]),
    ).toBe(true);
  });

  it("ignores who joined or left while the force was landing", () => {
    // "d" left, "zz" joined — neither says anything about whether the force took.
    expect(
      teamsLanded(want, [
        { name: "a", ally: 0 },
        { name: "b", ally: 0 },
        { name: "c", ally: 1 },
        { name: "zz", ally: 0 },
      ]),
    ).toBe(true);
  });

  it("does not care which ally numbers the lobby uses", () => {
    expect(
      teamsLanded(want, [
        { name: "a", ally: 3 },
        { name: "b", ally: 3 },
        { name: "c", ally: 7 },
        { name: "d", ally: 7 },
      ]),
    ).toBe(true);
  });

  it("is false when both groups ended up on the same side", () => {
    expect(
      teamsLanded(want, [
        { name: "a", ally: 0 },
        { name: "b", ally: 0 },
        { name: "c", ally: 0 },
        { name: "d", ally: 0 },
      ]),
    ).toBe(false);
  });

  it("is false when a whole group has vanished (nothing to confirm)", () => {
    expect(
      teamsLanded(want, [
        { name: "a", ally: 0 },
        { name: "b", ally: 0 },
      ]),
    ).toBe(false);
  });

  it("matches names case-insensitively", () => {
    expect(
      teamsLanded({ first: ["lucifer_"], second: ["songi"] }, [
        { name: "Lucifer_", ally: 0 },
        { name: "Songi", ally: 1 },
      ]),
    ).toBe(true);
  });
});

describe("rebalanceVerdict", () => {
  it("does nothing on an even lobby", () => {
    expect(rebalanceVerdict(50, 52, CFG).act).toBe(false);
  });

  it("does nothing without a baseline while the lobby is fair", () => {
    expect(rebalanceVerdict(null, 58, CFG).act).toBe(false);
  });

  it("acts when the lobby degraded past the threshold", () => {
    const v = rebalanceVerdict(50, 65, CFG);
    expect(v.act).toBe(true);
    expect(v.act && v.reason).toBe("degraded");
  });

  it("ignores a change that moves the lobby TOWARD even", () => {
    expect(rebalanceVerdict(70, 58, CFG).act).toBe(false);
  });

  it("acts on an absolutely unfair lobby even with no baseline at all", () => {
    const v = rebalanceVerdict(null, 95, CFG);
    expect(v.act).toBe(true);
    expect(v.act && v.reason).toBe("unfair");
  });

  it("acts on an unfair lobby the baseline has accepted", () => {
    // The 2026-09-07 hole: `.status` set the baseline to the lobby as it stood
    // (18 of 28 runs further than 10pp from even, 13 further than 25pp), so the
    // degrade rule could never fire again. `!start` auto-triggers `.status`, so
    // calling a vote on a stacked lobby disarmed the watcher.
    expect(rebalanceVerdict(95, 95, { degradePp: 10, absUnfairPp: 20 }).act).toBe(true);
    expect(rebalanceVerdict(2.7, 2.7, { degradePp: 10, absUnfairPp: 20 }).act).toBe(true);
  });

  it("treats the absolute threshold as exclusive, and symmetric about even", () => {
    // Baseline == win, so only the UNFAIR rule can fire here.
    expect(rebalanceVerdict(70, 70, CFG).act).toBe(false); // exactly 20pp off
    expect(rebalanceVerdict(70.1, 70.1, CFG).act).toBe(true);
    expect(rebalanceVerdict(29.9, 29.9, CFG).act).toBe(true);
  });

  it("reports DEGRADED for a lobby that is still absolutely fair", () => {
    // 20pp off is within the absolute threshold, so a 20pp slide from even is
    // caught by the degrade rule rather than the unfair one.
    const v = rebalanceVerdict(50, 70, CFG);
    expect(v.act && v.reason).toBe("degraded");
  });
});

describe("CompositionWatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("judges a burst of roster lines once, on the settled composition", async () => {
    const { state, watcher } = harness({ win: 95 });
    watcher.setBaseline(50);
    // A leaver's slot refilled arrives as several protocol lines back to back.
    for (let i = 0; i < 5; i++) {
      state.players = lobby(8 - (i % 2));
      state.players.push({ name: `x${i}`, ally: 1 });
      state.players = state.players.slice(0, 16);
      watcher.observe();
      await vi.advanceTimersByTimeAsync(10);
    }
    await settle();
    expect(state.rebalances).toEqual([95]);
  });

  it("ignores a line that leaves the composition unchanged", async () => {
    const { state, watcher } = harness({ win: 95 });
    watcher.setBaseline(50);
    watcher.observe(); // first call establishes the signature
    await settle();
    state.rebalances.length = 0;
    watcher.observe();
    await settle();
    expect(state.rebalances).toEqual([]);
  });

  it("does nothing unless the lobby is full", async () => {
    // An 8v7 is a near-certain win on team size alone, so every join and leave in
    // a filling lobby read as a catastrophic degrade — 21 rebalances in three
    // minutes on 2026-09-07.
    const { state, watcher } = harness({ win: 99 });
    watcher.setBaseline(50);
    state.players = lobby(8, 15);
    watcher.observe();
    await settle();
    expect(state.rebalances).toEqual([]);

    state.players = lobby(8, 16);
    watcher.observe();
    await settle();
    expect(state.rebalances).toEqual([99]);
  });

  it("does nothing while a game is running", async () => {
    const { state, watcher } = harness({ win: 99 });
    watcher.setBaseline(50);
    state.inGame = true;
    state.players = lobby(7);
    watcher.observe();
    await settle();
    expect(state.rebalances).toEqual([]);
  });

  it("re-baselines but does not force when forcing is blocked", async () => {
    const { state, watcher } = harness({ win: 95, blocked: 'the lobby\'s autoBalance is "advanced"' });
    watcher.setBaseline(50);
    state.players = lobby(7);
    watcher.observe();
    await settle();
    expect(state.rebalances).toEqual([]);
    expect(watcher.baseline).toBe(95);
    expect(state.logs.join("\n")).toContain("autoBalance");
  });

  it("stops re-logging a lobby that is blocked for good", async () => {
    // autoBalance left on = blocked forever, and the UNFAIR rule is absolute, so
    // re-baselining alone would not stop it announcing on every roster event.
    const { state, watcher } = harness({ win: 95, blocked: "autoBalance is enabled" });
    watcher.setBaseline(50);
    for (let i = 0; i < 5; i++) {
      state.players = lobby(7);
      state.players[15] = { name: `late${i}`, ally: 1 };
      watcher.observe();
      await settle();
    }
    expect(state.logs.filter((l) => l.includes("not rebalancing"))).toHaveLength(1);
    expect(state.rebalances).toEqual([]);
  });

  describe("blackout", () => {
    /** Wire `rebalance` to open a blackout for `want`, like a real live force. */
    function forcing(h: ReturnType<typeof harness>, want: { first: string[]; second: string[] }) {
      h.state.onRebalance = (w) => w.startBlackout(want);
    }

    const EVEN_SPLIT = {
      first: Array.from({ length: 8 }, (_, i) => `p${i}`),
      second: Array.from({ length: 8 }, (_, i) => `p${i + 8}`),
    };

    it("judges nothing while the force is landing, then lifts when it lands", async () => {
      const h = harness({ win: 95 });
      forcing(h, EVEN_SPLIT);
      h.watcher.setBaseline(50);
      h.state.players = lobby(12); // 12v4 — badly skewed
      h.watcher.observe();
      await settle();
      expect(h.state.rebalances).toEqual([95]);

      // SPADS applies the force in bursts: every intermediate state is lopsided
      // and would read as ~100% if the watcher judged it.
      for (const onZero of [14, 13, 12, 10, 9]) {
        h.state.players = lobby(onZero);
        h.watcher.observe();
        await vi.advanceTimersByTimeAsync(20);
      }
      expect(h.state.rebalances).toEqual([95]);

      h.state.players = lobby(8); // landed
      h.watcher.observe();
      await settle();
      expect(h.state.rebalances).toEqual([95]);
      expect(h.state.logs.join("\n")).toContain("reached the forced teams");
    });

    it("judges a change that arrived during the blackout, once, after it lifts", async () => {
      const h = harness({ win: 95 });
      forcing(h, EVEN_SPLIT);
      h.watcher.setBaseline(50);
      h.state.players = lobby(12);
      h.watcher.observe();
      await settle();
      h.state.rebalances.length = 0;
      h.state.onRebalance = undefined;

      // Mid-force, someone joins — a real change, but not judgeable yet.
      h.state.players = lobby(13);
      h.watcher.observe();
      await vi.advanceTimersByTimeAsync(50);
      expect(h.state.rebalances).toEqual([]);

      // The lobby lands on the forced teams; the deferred change is judged then.
      h.state.players = lobby(8);
      h.watcher.observe();
      await settle();
      // Landing means the composition IS the balanced one — nothing deferred
      // survives it, so no rebalance and no queued work.
      expect(h.state.rebalances).toEqual([]);
      expect(h.watcher.describe()).toContain("queued=no");
    });

    it("drains a deferred change when the blackout times out", async () => {
      const h = harness({ win: 95 });
      forcing(h, EVEN_SPLIT);
      h.watcher.setBaseline(50);
      h.state.players = lobby(12);
      h.watcher.observe();
      await settle();
      h.state.rebalances.length = 0;
      h.state.onRebalance = undefined;

      h.state.players = lobby(13); // a change the blackout deferred
      h.watcher.observe();
      await vi.advanceTimersByTimeAsync(CFG.blackoutMs + 50);

      // The force never landed, so the baseline is corrected to reality and no
      // second force goes out — the retry cooldown owns the next few seconds.
      expect(h.state.rebalances).toEqual([]);
      expect(h.watcher.baseline).toBe(95);
      expect(h.state.logs.join("\n")).toContain("did not take");
    });

    it("does not fire a second force before the first has landed", async () => {
      // On 2026-09-07 two conflicting !fb went out 80ms apart and moved 16
      // players twice; 20 of the 72 triggers fired within a second of the bot's
      // own previous force.
      const h = harness({ win: 99 });
      forcing(h, EVEN_SPLIT);
      h.watcher.setBaseline(50);
      h.state.players = lobby(12);
      h.watcher.observe();
      await settle();
      expect(h.state.rebalances).toHaveLength(1);

      for (let i = 0; i < 10; i++) {
        h.state.players = lobby(12 - (i % 3));
        h.watcher.observe();
        await vi.advanceTimersByTimeAsync(80);
      }
      expect(h.state.rebalances).toHaveLength(1);
    });

    it("holds off automatic forces after one failed to land", async () => {
      const h = harness({ win: 99 });
      forcing(h, EVEN_SPLIT);
      h.watcher.setBaseline(50);
      h.state.players = lobby(12);
      h.watcher.observe();
      await settle();
      h.state.onRebalance = undefined;
      expect(h.state.rebalances).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(CFG.blackoutMs + 50); // never landed

      // Still unfair, still full, still unblocked — but no retry into the wall.
      h.state.players = lobby(11);
      h.watcher.observe();
      await settle();
      expect(h.state.rebalances).toHaveLength(1);
      expect(h.watcher.describe()).toContain("retryCooldown=");

      await vi.advanceTimersByTimeAsync(CFG.retryCooldownMs);
      h.state.players = lobby(5);
      h.watcher.observe();
      await settle();
      expect(h.state.rebalances).toHaveLength(2);
    });

    it("at absUnfairPp 0 judges every change at a full lobby, even after a no-op", async () => {
      // bot.ts's setting since 2026-09-27: every composition change at a full
      // lobby is a rebalance, and a dead-band skip (rebalance sends nothing)
      // must not swallow the next change. 53.6% is the lobby it left alone.
      const h = harness({ win: 53.6, cfg: { absUnfairPp: 0 } });
      h.watcher.setBaseline(50);
      for (let i = 0; i < 4; i++) {
        h.state.players = lobby(8 + (i % 2));
        h.watcher.observe();
        await settle();
      }
      expect(h.state.rebalances).toHaveLength(4);
    });

    it("tells the caller the instant the lobby reaches the forced teams", async () => {
      // bot.ts holds the "Lava OS: …" line until this fires — the announcement
      // must describe teams the lobby HAS, not teams it was asked for.
      const h = harness({ win: 99 });
      forcing(h, EVEN_SPLIT);
      h.watcher.setBaseline(50);
      h.state.players = lobby(12);
      h.watcher.observe();
      await settle();
      expect(h.state.landed).toBe(0); // in flight: nothing may be claimed yet

      h.state.players = lobby(8); // p0-p7 on ally 0, p8-p15 on ally 1
      h.watcher.observe();
      expect(h.state.landed).toBe(1);
      expect(h.state.lost).toBe(0);
      expect(h.watcher.describe()).toContain("blackout=no");
    });

    it("reports the force LOST when the blackout expires off-target", async () => {
      const h = harness({ win: 99 });
      forcing(h, EVEN_SPLIT);
      h.watcher.setBaseline(50);
      h.state.players = lobby(12);
      h.watcher.observe();
      await settle();
      h.state.onRebalance = undefined;

      await vi.advanceTimersByTimeAsync(CFG.blackoutMs);
      expect(h.state.lost).toBe(1);
      expect(h.state.landed).toBe(0);
    });

    it("forceRejected can skip the cooldown when the caller removed the block", async () => {
      // Clearing SPADS's autoBlockBalance removes the very thing that refused the
      // force, so the retry is going to work — waiting 30s would only delay it.
      const h = harness({ win: 99 });
      forcing(h, EVEN_SPLIT);
      h.watcher.setBaseline(50);
      h.state.players = lobby(12);
      h.watcher.observe();
      await settle();
      h.state.onRebalance = undefined;

      h.watcher.forceRejected("autoBlockBalance", false);
      await settle();
      expect(h.watcher.describe()).toContain("retryCooldown=no");
      expect(h.watcher.describe()).toContain("blackout=no");
    });

    it("forceRejected drops the blackout, corrects the baseline and holds off", async () => {
      // The host's autoBlockBalance PM, ~100ms after our !fb: the teams did NOT
      // change, so the baseline must become the lobby's REAL win chance (not the
      // one we announced) and no automatic force may go out for the cooldown.
      const h = harness({ win: 99 });
      forcing(h, EVEN_SPLIT);
      h.watcher.setBaseline(50);
      h.state.players = lobby(12);
      h.watcher.observe();
      await settle();
      h.state.onRebalance = undefined;
      expect(h.state.rebalances).toHaveLength(1);

      h.watcher.forceRejected("the host has autoBlockBalance on");
      await settle();
      expect(h.watcher.describe()).toContain("blackout=no");
      expect(h.watcher.describe()).toContain("baseline=99.0%");
      expect(h.watcher.describe()).toContain("retryCooldown=30s");

      // ...and it really does not re-force inside the cooldown.
      h.state.players = lobby(4);
      h.watcher.observe();
      await settle();
      expect(h.state.rebalances).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(CFG.retryCooldownMs);
      h.state.players = lobby(5);
      h.watcher.observe();
      await settle();
      expect(h.state.rebalances).toHaveLength(2);
    });

    it("endBlackout skips the cooldown, for a rejection already diagnosed", async () => {
      // The host's "autoBalance is enabled" PM: bot.ts nulls the baseline and
      // latches the block itself, so a cooldown would only duplicate it.
      const h = harness({ win: 99 });
      forcing(h, EVEN_SPLIT);
      h.watcher.setBaseline(50);
      h.state.players = lobby(12);
      h.watcher.observe();
      await settle();
      h.state.onRebalance = undefined;

      h.watcher.endBlackout();
      expect(h.watcher.describe()).toContain("retryCooldown=no");
      expect(h.watcher.describe()).toContain("blackout=no");
    });
  });

  it("runs one check at a time even when the rating lookup is slow", async () => {
    // runBalance awaits the tracker queue and an LOS lookup; without single-flight
    // two checks overlapped and each sent its own !fb.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inFlight = 0;
    let maxInFlight = 0;
    const state = { players: lobby(12), first: true };
    const watcher = new CompositionWatcher(CFG, {
      signature: () => signatureOf(state.players),
      players: () => state.players,
      winChance: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (state.first) {
          state.first = false;
          await gate;
        }
        inFlight--;
        return 95;
      },
      gameInProgress: () => false,
      forceBlocked: () => "blocked", // no forcing: isolate the concurrency
      rebalance: async () => {},
      onTeamsLanded: () => {},
      onForceLost: () => {},
      status: () => {},
      onError: () => {},
    });
    watcher.setBaseline(50);
    watcher.observe();
    await settle();
    state.players = lobby(11);
    watcher.observe();
    await settle();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(maxInFlight).toBe(1);
  });

  it("survives a failing rating lookup and keeps working", async () => {
    let fail = true;
    const state = { players: lobby(12), rebalances: 0, errors: 0 };
    const watcher = new CompositionWatcher(CFG, {
      signature: () => signatureOf(state.players),
      players: () => state.players,
      winChance: async () => {
        if (fail) throw new Error("lookup down");
        return 95;
      },
      gameInProgress: () => false,
      forceBlocked: () => null,
      rebalance: async () => void state.rebalances++,
      onTeamsLanded: () => {},
      onForceLost: () => {},
      status: () => {},
      onError: () => void state.errors++,
    });
    watcher.setBaseline(50);
    watcher.observe();
    await settle();
    expect(state.errors).toBe(1);
    expect(state.rebalances).toBe(0);

    fail = false;
    state.players = lobby(11);
    watcher.observe();
    await settle();
    expect(state.rebalances).toBe(1);
  });

  it("reset clears the baseline, the blackout and the pending work", async () => {
    const h = harness({ win: 95 });
    h.state.onRebalance = (w) => w.startBlackout({ first: ["p0"], second: ["p15"] });
    h.watcher.setBaseline(50);
    h.state.players = lobby(12);
    h.watcher.observe();
    await settle();
    expect(h.watcher.describe()).toContain("blackout=yes");

    h.watcher.reset();
    expect(h.watcher.baseline).toBeNull();
    expect(h.watcher.describe()).toContain("blackout=no");

    // A new battle starts unbaselined, so a fair lobby wakes nothing.
    h.state.win = 55;
    h.state.players = lobby(8);
    h.watcher.observe();
    await vi.advanceTimersByTimeAsync(CFG.blackoutMs * 2);
    expect(h.state.rebalances).toHaveLength(1); // still just the first one
  });
});
