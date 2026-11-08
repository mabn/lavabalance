import { describe, expect, it } from "vitest";
import {
  MAX_SCORE_NAMES,
  fetchScores,
  mapBalanceScores,
  parseScoresRequest,
} from "../src/rating/lavaScores";

// A real answer from `curl -XPOST .../api/balance -d '["huk123","No_Air","nosuchguy"]'`,
// trimmed. We consume `ratings` + `unknown_players`; the suggested split is ignored.
const PAYLOAD = {
  ratings: [
    { name: "huk123", user_id: 357541, elo: 3628.3277240874504, games_played: 285, wins: 160, losses: 125 },
    { name: "No_Air", user_id: 191677, elo: 3392.4056874143184, games_played: 125, wins: 80, losses: 45 },
  ],
  unknown_players: ["nosuchguy"],
  team0: "huk123",
  team1: "No_Air|nosuchguy",
  team0_avg_rating: 3628.3,
  team1_avg_rating: 2321.2,
  deviation: 1307.1,
  team0_win_prob: 78.8,
  team1_win_prob: 21.2,
  total_players: 3,
};

describe("parseScoresRequest", () => {
  it("accepts {names: [...]} and the bare array, trimming and dropping blanks", () => {
    expect(parseScoresRequest({ names: [" huk123 ", "", "No_Air"] })).toEqual([
      "huk123",
      "No_Air",
    ]);
    expect(parseScoresRequest(["huk123"])).toEqual(["huk123"]);
  });

  it("drops case-insensitive duplicates, keeping the first spelling", () => {
    expect(parseScoresRequest({ names: ["huk123", "HUK123", " huk123 ", "No_Air"] })).toEqual([
      "huk123",
      "No_Air",
    ]);
  });

  it("rejects a non-list body, non-string entries and an empty list", () => {
    expect(() => parseScoresRequest({ players: ["a"] })).toThrow(/expected \{names/);
    expect(() => parseScoresRequest(["huk123", 7])).toThrow(/must be strings/);
    expect(() => parseScoresRequest([" ", ""])).toThrow(/no player names/);
  });

  it("caps the roster at 16 distinct players (a full 8v8 lobby)", () => {
    expect(MAX_SCORE_NAMES).toBe(16);
    const names = Array.from({ length: MAX_SCORE_NAMES }, (_, i) => "p" + i);
    expect(parseScoresRequest(names)).toHaveLength(MAX_SCORE_NAMES);
    // Padding with blanks or repeats doesn't count towards the cap...
    expect(parseScoresRequest([...names, "", "  ", "P3", "p7"])).toHaveLength(MAX_SCORE_NAMES);
    // ...but one more distinct player is over it.
    expect(() => parseScoresRequest([...names, "p16"])).toThrow(/too many player names \(17 > 16\)/);
  });
});

describe("mapBalanceScores", () => {
  it("reduces the payload to rounded elos keyed by normalized name", () => {
    const { elos, unknown } = mapBalanceScores(PAYLOAD);
    expect(elos).toEqual({ huk123: 3628, no_air: 3392 });
    expect(unknown).toEqual(["nosuchguy"]);
  });

  it("drops a name listed in unknown_players instead of recording its placeholder elo", () => {
    // Lavabar returns a rating row for names it doesn't know, with a placeholder elo (1875).
    const { elos, unknown } = mapBalanceScores({
      ratings: [
        { name: "huk123", user_id: 357541, elo: 3628.3 },
        { name: "NoSuchGuy", elo: 1875.0 },
      ],
      unknown_players: ["nosuchguy"], // matched case-insensitively
    });
    expect(elos).toEqual({ huk123: 3628 });
    expect(unknown).toEqual(["nosuchguy"]);
  });

  it("skips entries with no usable name or elo", () => {
    const { elos } = mapBalanceScores({
      ratings: [{ name: "", elo: 1000 }, { name: "noelo" }, { name: "Ok", elo: 1500.6 }],
    });
    expect(elos).toEqual({ ok: 1501 });
  });
});

describe("fetchScores", () => {
  it("POSTs the bare name array and maps the answer", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify(PAYLOAD), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { elos, unknown } = await fetchScores(["huk123", "No_Air", "nosuchguy"], { fetchFn });
    expect(elos).toEqual({ huk123: 3628, no_air: 3392 });
    expect(unknown).toEqual(["nosuchguy"]);

    const [url, init] = calls[0]!;
    expect(url).toBe("https://lavabar.skyride.org/api/balance");
    expect(init.method).toBe("POST");
    // The endpoint takes the bare array (not the {names} envelope the UI posts to us).
    expect(JSON.parse(init.body as string)).toEqual(["huk123", "No_Air", "nosuchguy"]);
  });

  it("names the failing request on a non-2xx upstream", async () => {
    const fetchFn = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchScores(["huk123"], { fetchFn })).rejects.toThrow(
      /lavabar POST https:\/\/lavabar\.skyride\.org\/api\/balance responded 503/,
    );
  });

  it("distinguishes a timeout from a network error", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new Error("The operation was aborted")),
        );
      })) as unknown as typeof fetch;
    await expect(fetchScores(["huk123"], { fetchFn: hang, timeoutMs: 10 })).rejects.toThrow(
      /timed out after 10ms/,
    );

    const dead = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    await expect(fetchScores(["huk123"], { fetchFn: dead })).rejects.toThrow(
      /failed after \d+ms: connection refused/,
    );
  });
});

