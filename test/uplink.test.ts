// The bot's game-start uplink: payload/endpoint shapes, the one-retry policy,
// and the never-throws contract (a dead Worker must cost the bot nothing).

import { describe, expect, it, vi } from "vitest";
import { createUplink } from "../src/bot/uplink";
import type { GameStartSnapshot } from "../src/gameStart";

const SNAP: GameStartSnapshot = {
  battleId: 76,
  startedAt: 1_000,
  players: [],
  founder: "HOST",
  title: "Supreme LAVA",
  botBalanced: true,
  predictedFirstWin: 49.8,
};

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (Response | Error)[]): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? new Response("{}", { status: 200 });
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("createUplink", () => {
  it("POSTs the snapshot to /api/gamestart with a JSON body and no auth header", async () => {
    const { calls, fetchImpl } = fakeFetch([new Response("{}", { status: 200 })]);
    const log = vi.fn();
    await createUplink("https://lavabalance.test/", { fetchImpl, log }).gameStart(SNAP);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://lavabalance.test/api/gamestart");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual(SNAP);
    expect(new Headers(calls[0].init.headers).get("authorization")).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("sent"));
  });

  it("POSTs the game-end event to /api/gameend", async () => {
    const { calls, fetchImpl } = fakeFetch([new Response("{}", { status: 200 })]);
    await createUplink("https://lavabalance.test", { fetchImpl, log: () => {} }).gameEnd({
      battleId: 76,
      endedAt: 2_000,
      reason: "result",
    });
    expect(calls[0].url).toBe("https://lavabalance.test/api/gameend");
    expect(JSON.parse(String(calls[0].init.body)).reason).toBe("result");
  });

  it("retries once after a failure, then succeeds", async () => {
    const { calls, fetchImpl } = fakeFetch([
      new Error("connection refused"),
      new Response("{}", { status: 200 }),
    ]);
    const log = vi.fn();
    await createUplink("https://x.test", { fetchImpl, log, retryDelayMs: 1 }).gameStart(SNAP);
    expect(calls).toHaveLength(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("after retry"));
  });

  it("gives up after the second failure without throwing, naming both errors", async () => {
    const { calls, fetchImpl } = fakeFetch([
      new Response("nope", { status: 502, statusText: "Bad Gateway" }),
      new Error("still down"),
    ]);
    const log = vi.fn();
    await expect(
      createUplink("https://x.test", { fetchImpl, log, retryDelayMs: 1 }).gameStart(SNAP),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    const line = log.mock.calls.at(-1)?.[0] as string;
    expect(line).toContain("dropped after retry");
    expect(line).toContain("still down");
    expect(line).toContain("502");
  });

  it("treats a non-2xx as a failure (retries it)", async () => {
    const { calls, fetchImpl } = fakeFetch([
      new Response("bad", { status: 400 }),
      new Response("{}", { status: 200 }),
    ]);
    await createUplink("https://x.test", { fetchImpl, log: () => {}, retryDelayMs: 1 }).gameEnd({
      battleId: 76,
      endedAt: 0,
      reason: "ingame-clear",
    });
    expect(calls).toHaveLength(2);
  });
});
