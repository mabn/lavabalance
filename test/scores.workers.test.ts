// POST /api/scores — the same-origin relay of Lavabar's bulk score endpoint (the
// "📊 Fetch scores" button). Runs in the real workerd runtime; only the request-validation
// paths are asserted here, since the success path needs the live Lavabar host.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const post = (body: string) =>
  SELF.fetch("https://lavabalance.test/api/scores", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

describe("POST /api/scores", () => {
  it("rejects a malformed JSON body with 400", async () => {
    const res = await post("not json");
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toContain("invalid JSON body");
  });

  it("rejects a body that isn't a name list with 400", async () => {
    const res = await post(JSON.stringify({ players: ["huk123"] }));
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toContain("expected {names");
  });

  it("rejects an empty name list with 400", async () => {
    const res = await post(JSON.stringify({ names: ["", "  "] }));
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toContain("no player names");
  });

  it("rejects more than 16 players with 400 (the server-side cap)", async () => {
    const names = Array.from({ length: 17 }, (_, i) => "p" + i);
    const res = await post(JSON.stringify({ names }));
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toContain("too many player names (17 > 16)");
  });
});
