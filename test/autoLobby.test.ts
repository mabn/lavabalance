// The "no lava lobby configured → pick one from Teiserver" logic (src/autoLobby.ts):
// the pure picker, and the orchestration around the Dispatcher's throttle.

import { describe, expect, it } from "vitest";
import {
  AUTO_PICK_INTERVAL_MS,
  adoptLavaLobby,
  ensureLavaLobbyConfigured,
  pickLavaLobby,
  resolveAutoJoinBattle,
  shouldAdopt,
} from "../src/autoLobby";
import type { IndexLobby } from "../src/teiserver";

const row = (id: number, name: string, playerCount: number): IndexLobby => ({
  id,
  name,
  map: "Supreme Isthmus",
  inProgress: false,
  locked: false,
  passworded: false,
  memberCount: playerCount,
  playerCount,
  spectatorCount: 0,
});

describe("pickLavaLobby", () => {
  it("picks the 'lava' lobby with the most players, case-insensitively", () => {
    const picked = pickLavaLobby([
      row(1, "Supreme 8v8", 16),
      row(2, "Supreme LAVA | 8v8", 9),
      row(3, "lava noobs", 12),
      row(4, "Lava small", 3),
    ]);
    expect(picked?.id).toBe(3);
  });

  it("keeps the earlier entry on a tie and ignores non-lava lobbies entirely", () => {
    expect(pickLavaLobby([row(7, "Lava A", 4), row(8, "Lava B", 4)])?.id).toBe(7);
    expect(pickLavaLobby([row(9, "Supreme 8v8", 16)])).toBeNull();
    expect(pickLavaLobby([])).toBeNull();
  });

  it("still picks an empty lava lobby (the host's idle lobby is the lava lobby)", () => {
    expect(pickLavaLobby([row(5, "LAVA", 0)])?.id).toBe(5);
  });
});

/** A fake Dispatcher/TeiserverDO pair recording what the auto-pick did. */
function fakeDeps(opts: {
  lava_lobbies: number[];
  claim: boolean;
  index: IndexLobby[] | { error: string };
}) {
  const calls = { claim: 0, index: 0, set: [] as unknown[] };
  let cfg = { lava_lobbies: opts.lava_lobbies };
  return {
    calls,
    config: () => cfg,
    deps: {
      dispatcher: {
        getConfig: async () => cfg,
        setConfig: async (input: unknown) => {
          calls.set.push(input);
          cfg = input as { lava_lobbies: number[] };
          return cfg;
        },
        claimAutoPick: async (min: number) => {
          calls.claim++;
          expect(min).toBe(AUTO_PICK_INTERVAL_MS);
          return opts.claim;
        },
      },
      teiserver: {
        lobbyIndex: async () => {
          calls.index++;
          return "error" in opts.index
            ? ({ ok: false, error: opts.index.error } as const)
            : ({ ok: true, lobbies: opts.index } as const);
        },
      },
    },
  };
}

describe("ensureLavaLobbyConfigured", () => {
  it("leaves a non-empty config alone without touching Teiserver or the throttle", async () => {
    const f = fakeDeps({ lava_lobbies: [42], claim: true, index: [row(1, "lava", 5)] });
    expect(await ensureLavaLobbyConfigured(f.deps)).toEqual({ lava_lobbies: [42] });
    expect(f.calls).toEqual({ claim: 0, index: 0, set: [] });
  });

  it("configures the best lava lobby when nothing is configured and the throttle allows", async () => {
    const f = fakeDeps({
      lava_lobbies: [],
      claim: true,
      index: [row(1, "Supreme 8v8", 16), row(2, "Lava", 6), row(3, "LAVA big", 10)],
    });
    expect(await ensureLavaLobbyConfigured(f.deps)).toEqual({ lava_lobbies: [3] });
    expect(f.calls.set).toEqual([{ lava_lobbies: [3] }]);
    expect(f.config()).toEqual({ lava_lobbies: [3] });
  });

  it("does not ask Teiserver when the throttle refuses (once per 5 minutes)", async () => {
    const f = fakeDeps({ lava_lobbies: [], claim: false, index: [row(2, "Lava", 6)] });
    expect(await ensureLavaLobbyConfigured(f.deps)).toEqual({ lava_lobbies: [] });
    expect(f.calls).toEqual({ claim: 1, index: 0, set: [] });
  });

  it("leaves the config empty when no lava lobby is open or the lookup fails", async () => {
    const none = fakeDeps({ lava_lobbies: [], claim: true, index: [row(1, "Supreme 8v8", 16)] });
    expect(await ensureLavaLobbyConfigured(none.deps)).toEqual({ lava_lobbies: [] });
    expect(none.calls.set).toEqual([]);

    const failed = fakeDeps({ lava_lobbies: [], claim: true, index: { error: "login failed" } });
    expect(await ensureLavaLobbyConfigured(failed.deps)).toEqual({ lava_lobbies: [] });
    expect(failed.calls.set).toEqual([]);
  });
});

describe("shouldAdopt (viewing a lobby adopts it as the configured lava lobby)", () => {
  const viewed = { id: 20, title: "Supreme LAVA | 8v8", playerCount: 5 };

  it("never adopts a non-lava lobby, nor one already configured", () => {
    expect(shouldAdopt([], [], { ...viewed, title: "Supreme 8v8" })).toBe(false);
    expect(shouldAdopt([20], [row(20, "LAVA", 5)], viewed)).toBe(false);
  });

  it("adopts when nothing is configured (even without an index)", () => {
    expect(shouldAdopt([], null, viewed)).toBe(true);
  });

  it("is sticky while the configured lobby is open with players", () => {
    expect(shouldAdopt([10], [row(10, "Lava old", 3), row(20, "LAVA", 5)], viewed)).toBe(false);
  });

  it("adopts once the configured lobby is empty or gone", () => {
    expect(shouldAdopt([10], [row(10, "Lava old", 0), row(20, "LAVA", 5)], viewed)).toBe(true);
    expect(shouldAdopt([10], [row(20, "LAVA", 5)], viewed)).toBe(true);
  });

  it("keeps the config when the index lookup failed and something is configured", () => {
    expect(shouldAdopt([10], null, viewed)).toBe(false);
  });
});

describe("adoptLavaLobby", () => {
  const viewed = { id: 20, title: "Supreme LAVA | 8v8", playerCount: 5 };

  it("skips the Teiserver lookup for a non-lava or already configured lobby", async () => {
    const a = fakeDeps({ lava_lobbies: [10], claim: true, index: [] });
    expect(await adoptLavaLobby(a.deps, { ...viewed, title: "Supreme 8v8" })).toBe(false);
    const b = fakeDeps({ lava_lobbies: [20], claim: true, index: [] });
    expect(await adoptLavaLobby(b.deps, viewed)).toBe(false);
    expect(a.calls.index + b.calls.index).toBe(0);
    expect(a.calls.set).toEqual([]);
    expect(b.calls.set).toEqual([]);
  });

  it("replaces an empty configured lobby with the viewed lava lobby", async () => {
    const f = fakeDeps({ lava_lobbies: [10], claim: true, index: [row(10, "Lava old", 0)] });
    expect(await adoptLavaLobby(f.deps, viewed)).toBe(true);
    expect(f.config()).toEqual({ lava_lobbies: [20] });
  });

  it("does not replace a configured lobby that still has players", async () => {
    const f = fakeDeps({ lava_lobbies: [10], claim: true, index: [row(10, "Lava old", 2)] });
    expect(await adoptLavaLobby(f.deps, viewed)).toBe(false);
    expect(f.config()).toEqual({ lava_lobbies: [10] });
  });

  it("adopts with no config at all, without asking Teiserver", async () => {
    const f = fakeDeps({ lava_lobbies: [], claim: true, index: { error: "down" } });
    expect(await adoptLavaLobby(f.deps, viewed)).toBe(true);
    expect(f.calls.index).toBe(0);
    expect(f.config()).toEqual({ lava_lobbies: [20] });
  });
});

describe("resolveAutoJoinBattle (the bot's restart rejoin target)", () => {
  it("keeps the last battle while Teiserver's index still lists it", async () => {
    const f = fakeDeps({ lava_lobbies: [42], claim: true, index: [row(7, "Lava", 5)] });
    expect(await resolveAutoJoinBattle(f.deps, 7)).toBe(7);
    // The configured main lobby was not consulted (no setConfig, no claim).
    expect(f.calls.claim).toBe(0);
  });

  it("falls back to the configured main lobby when the last battle is gone", async () => {
    const f = fakeDeps({ lava_lobbies: [42], claim: true, index: [row(9, "Lava", 5)] });
    expect(await resolveAutoJoinBattle(f.deps, 7)).toBe(42);
  });

  it("auto-picks a main lobby for the fallback when nothing is configured", async () => {
    const f = fakeDeps({ lava_lobbies: [], claim: true, index: [row(9, "Lava big", 8)] });
    expect(await resolveAutoJoinBattle(f.deps, 7)).toBe(9);
    expect(f.config()).toEqual({ lava_lobbies: [9] });
  });

  it("goes straight to the main lobby with no last battle recorded", async () => {
    const f = fakeDeps({ lava_lobbies: [42], claim: true, index: [row(9, "Lava", 5)] });
    expect(await resolveAutoJoinBattle(f.deps, null)).toBe(42);
    // No last battle → nothing to verify against the index.
    expect(f.calls.index).toBe(0);
  });

  it("keeps the last battle when the index lookup fails (most recent knowledge)", async () => {
    const f = fakeDeps({ lava_lobbies: [42], claim: true, index: { error: "login failed" } });
    expect(await resolveAutoJoinBattle(f.deps, 7)).toBe(7);
  });

  it("resolves null when neither a last battle nor a main lobby exists", async () => {
    const f = fakeDeps({ lava_lobbies: [], claim: true, index: [row(1, "Supreme 8v8", 16)] });
    expect(await resolveAutoJoinBattle(f.deps, null)).toBeNull();
  });
});
