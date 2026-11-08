// The /api/lobbies `src` parameter: default + validation.
//
// Runs in the real workerd runtime (vitest-pool-workers loads wrangler.jsonc). We only
// assert routing/validation here — the actual data sources need a live Teiserver/bar-rts,
// so we lean on the fact that, with no TEISERVER_* secrets configured, the teiserver
// source fails fast with a 502 (which is what distinguishes the default from `proxy`).

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Dispatcher } from "../src/dispatcher";

const get = (q = "") => SELF.fetch(`https://lavabalance.test/api/lobbies${q}`);
const getOne = (id: number | string, q = "") =>
  SELF.fetch(`https://lavabalance.test/api/lobbies/${id}${q}`);

describe("/api/lobbies?src=", () => {
  it("rejects an unsupported src with 400", async () => {
    const res = await get("?src=bogus");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // The message lists the enabled modes (from the SRC_MODES var), in order.
    expect(body.error).toContain("enabled: teiserver, proxy, rtsapi");
  });

  it("serves the proxy (Dispatcher) view as a JSON array", async () => {
    const res = await get("?src=proxy");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("defaults to the teiserver source when src is omitted", async () => {
    // SRC_MODES lists `teiserver` first, so an omitted src resolves to the teiserver
    // scrape — which fails fast with a 502 here (no TEISERVER_* secrets configured),
    // unlike the proxy view's 200 array. The 502 is exactly what proves the default
    // is teiserver, not proxy.
    const res = await get();
    expect(res.status).toBe(502);
  });

  it("accepts ?all=true on the proxy view", async () => {
    const res = await get("?src=proxy&all=true");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

describe("/api/lobbies/:id (single-lobby detail)", () => {
  it("rejects an unsupported src with 400", async () => {
    const res = await getOne(123, "?src=bogus");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("enabled: teiserver, proxy, rtsapi");
  });

  it("rejects a non-numeric id with 400", async () => {
    const res = await getOne("abc", "?src=proxy");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid lobby id");
  });

  it("returns null for an unknown lobby on the proxy view", async () => {
    // No battles tracked in the test Dispatcher, so any id resolves to null (200).
    const res = await getOne(123, "?src=proxy");
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it("defaults to the teiserver source when src is omitted", async () => {
    // Default resolves to teiserver (first in SRC_MODES), which 502s here for lack
    // of TEISERVER_* secrets — unlike the proxy view's null (200) above.
    const res = await getOne(123, "?all=true");
    expect(res.status).toBe(502);
  });
});

describe("GET / (land-in-a-lobby redirect)", () => {
  it("serves the list page when the source has no open lobby", async () => {
    // The test Dispatcher tracks no battles, so there is nothing to redirect to.
    const res = await SELF.fetch("https://lavabalance.test/?src=proxy");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('<nav class="side">');
  });

  it("falls back to the list page when the default (teiserver) source fails", async () => {
    // No TEISERVER_* secrets here — the scrape fails, and / must still serve HTML
    // rather than a 502 (the page's own /api/lobbies fetch surfaces the error).
    const res = await SELF.fetch("https://lavabalance.test/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("serves the detail endpoint for ANY id — no lava filter on the proxy view", async () => {
    // Nothing is tracked, so the answer is null — but a 200, not a filtered-out 404:
    // an explicit id is an explicit ask, whatever the configured lava set says.
    const res = await SELF.fetch("https://lavabalance.test/api/lobbies/999999?src=proxy");
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });
});

describe("the lobby picker", () => {
  it("serves the /lobbies page", async () => {
    const res = await SELF.fetch("https://lavabalance.test/lobbies");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('const ALL_LOBBIES_URL = "/api/lobbies/all";');
  });

  it("routes /api/lobbies/all to the Teiserver index, not the :id handler", async () => {
    // Without TEISERVER_* secrets the index scrape fails → 502. Had "all" been taken
    // for a lobby id, the :id route would have answered 400 "invalid lobby id".
    const res = await SELF.fetch("https://lavabalance.test/api/lobbies/all");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("invalid lobby id");
  });
});

describe("Dispatcher.claimAutoPick (the 5-minute auto-pick throttle)", () => {
  it("grants the first claim, refuses within the interval, grants again after it", async () => {
    const stub = env.DISPATCHER.get(env.DISPATCHER.idFromName("singleton"));
    await runInDurableObject(stub, async (d: Dispatcher, state) => {
      await state.storage.delete("autoPickAt");
      const t0 = 1_000_000_000;
      expect(await d.claimAutoPick(300_000, t0)).toBe(true);
      expect(await d.claimAutoPick(300_000, t0 + 1)).toBe(false);
      expect(await d.claimAutoPick(300_000, t0 + 299_999)).toBe(false);
      expect(await d.claimAutoPick(300_000, t0 + 300_000)).toBe(true);
      // The successful claim moved the window forward.
      expect(await d.claimAutoPick(300_000, t0 + 300_001)).toBe(false);
      await state.storage.delete("autoPickAt");
    });
  });
});
