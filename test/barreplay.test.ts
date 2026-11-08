// The barreplay status lookup behind the games list's replay links
// (src/barreplay.ts). Driven against a fake fetch — no network, no worker.

import { describe, expect, it, vi } from "vitest";
import { fetchReplayStatuses, replayCacheHeaders, replayHref, replayTiming } from "../src/barreplay";

const ID_A = "1e1c9e6a61a42e4fa4fbade353a1e92f";
const ID_B = "2f2d0a7b72b53f5b05cbef464b2fa03e";
const ID_C = "3a3e1b8c83c64a6c16dcf0575c30b14f";

/** A fetch that answers one JSON body and records what it was asked. */
function jsonFetch(body: unknown) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("fetchReplayStatuses", () => {
  it("asks for every id in ONE request and keys the answer by id", async () => {
    const { impl, calls } = jsonFetch({
      games: [
        { id: ID_A, published: true, jobState: "done" },
        { id: ID_B, published: false, jobState: "processing" },
      ],
      next: null,
    });

    const got = await fetchReplayStatuses([ID_A, ID_B, ID_C], { fetchImpl: impl });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`https://replay.fogofwar.dev/api/games?id=${ID_A},${ID_B},${ID_C}`);
    expect(got.asked).toBe(3);
    expect(got.error).toBeUndefined();
    expect(got.statuses[ID_A]).toEqual({ published: true, jobState: "done" });
    expect(got.statuses[ID_B]).toEqual({ published: false, jobState: "processing" });
    // An id barreplay does not know is simply absent — the "no replay" case.
    expect(got.statuses[ID_C]).toBeUndefined();
  });

  it("collapses duplicates and drops ids barreplay would refuse", async () => {
    // One malformed id 400s the WHOLE batch upstream, so it must never be sent.
    const { impl, calls } = jsonFetch({ games: [] });
    const got = await fetchReplayStatuses([ID_A, ID_A, "not a game id", ""], { fetchImpl: impl });
    expect(calls[0]).toBe(`https://replay.fogofwar.dev/api/games?id=${ID_A}`);
    expect(got.asked).toBe(1);
  });

  it("asks nothing when no id survives the filter", async () => {
    const { impl, calls } = jsonFetch({ games: [] });
    const got = await fetchReplayStatuses(["bad id"], { fetchImpl: impl });
    expect(calls).toHaveLength(0);
    expect(got).toEqual({ statuses: {}, asked: 0, durationMs: 0 });
  });

  it("treats a non-2xx as no statuses rather than a failure", async () => {
    const impl = (async () => new Response("nope", { status: 503, statusText: "Service Unavailable" })) as unknown as typeof fetch;
    const got = await fetchReplayStatuses([ID_A], { fetchImpl: impl });
    expect(got.statuses).toEqual({});
    expect(got.error).toContain("503");
  });

  it("survives a network failure — the games list must render without links", async () => {
    const impl = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const got = await fetchReplayStatuses([ID_A], { fetchImpl: impl });
    expect(got.statuses).toEqual({});
    expect(got.error).toContain("connection refused");
  });

  it("gives up on a slow barreplay", async () => {
    const impl = ((_url: unknown, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      })) as unknown as typeof fetch;
    const got = await fetchReplayStatuses([ID_A], { fetchImpl: impl, timeoutMs: 5 });
    expect(got.statuses).toEqual({});
    expect(got.error).toContain("timed out");
  });

  it("ignores rows that carry no id, and reads a missing jobState as none", async () => {
    const { impl } = jsonFetch({ games: [{ published: true }, { id: ID_A, published: true }] });
    const got = await fetchReplayStatuses([ID_A], { fetchImpl: impl });
    expect(got.statuses).toEqual({ [ID_A]: { published: true, jobState: null } });
  });
});

describe("replayTiming", () => {
  it("reports the upstream duration and what came back", () => {
    const metric = replayTiming({
      statuses: { [ID_A]: { published: true, jobState: null } },
      asked: 3,
      durationMs: 42,
    });
    expect(metric).toBe('barreplay;dur=42;desc="3 asked, 1 known"');
  });

  it("reports the reason instead when the lookup failed, without breaking the header", () => {
    const metric = replayTiming({
      statuses: {},
      asked: 2,
      durationMs: 3000,
      error: 'barreplay said "no"\nand stopped',
    });
    expect(metric).toBe('barreplay;dur=3000;desc="barreplay said  no  and stopped"');
  });
});

describe("replayCacheHeaders", () => {
  const cache = { "Cache-Control": "public, max-age=60" };

  it("keeps the route's cache policy when the lookup answered", () => {
    expect(replayCacheHeaders({ statuses: {}, asked: 2, durationMs: 40 }, cache)).toEqual(cache);
  });

  it("makes a linkless body from a failed lookup uncacheable, so the next load retries", () => {
    const failed = { statuses: {}, asked: 20, durationMs: 3000, error: "barreplay timed out after 3000ms" };
    expect(replayCacheHeaders(failed, cache)).toEqual({ "Cache-Control": "no-store" });
    // An admin (already no-store) view stays no-store.
    expect(replayCacheHeaders(failed, { "Cache-Control": "no-store" })).toEqual({ "Cache-Control": "no-store" });
  });
});

describe("replayHref", () => {
  it("points at the game's playback page", () => {
    expect(replayHref(ID_A)).toBe(`https://replay.fogofwar.dev/replays/${ID_A}`);
  });
});
