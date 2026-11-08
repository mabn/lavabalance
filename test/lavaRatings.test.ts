import { describe, expect, it } from "vitest";
import { fetchPlayerRating, parsePlayerSearch } from "../src/rating/lavaRatings";

// A trimmed copy of a real `/players/?q=...` results table (the surrounding page
// chrome is irrelevant to the parser).
function searchPage(rows: string): string {
  return `<!DOCTYPE html><html><body><main>
    <span class="badge bg-secondary fs-6">N results</span>
    <table class="table"><tbody class="border-top-0">
    ${rows}
    </tbody></table></main></body></html>`;
}

function row(
  name: string,
  rating: string,
  ts: string,
  w: number,
  l: number,
  g: number,
  pct: string,
  id = 5106,
): string {
  return `<tr class="search-row">
    <td class="ps-3"><a href="/players/${id}/" class="text-decoration-none fw-bold">
      ${name}
    </a></td>
    <td><span class="badge bg-primary fs-6">${rating}</span></td>
    <td class="text-muted small">${ts}</td>
    <td class="text-center text-success fw-bold">${w}</td>
    <td class="text-center text-danger fw-bold">${l}</td>
    <td class="text-center">${g}</td>
    <td class="text-end pe-3"><span class="text-success fw-bold">${pct}%</span></td>
  </tr>`;
}

const POLONIUM = row("[CADE]Polonium210", "4407", "-", 225, 93, 318, "70.8");

describe("parsePlayerSearch", () => {
  it("extracts stats for the exactly-matching row", () => {
    const r = parsePlayerSearch(searchPage(POLONIUM), "[CADE]Polonium210");
    expect(r).toEqual({
      playerId: 5106,
      rating: 4407,
      wins: 225,
      losses: 93,
      games: 318,
      winRate: 0.708,
    });
  });

  it("parses the player id from the matched row's link", () => {
    const page = searchPage(
      row("[CADE]DeadVeganCat", "3000", "-", 10, 5, 15, "66.7", 4242) + POLONIUM,
    );
    expect(parsePlayerSearch(page, "[CADE]DeadVeganCat")?.playerId).toBe(4242);
    expect(parsePlayerSearch(page, "[CADE]Polonium210")?.playerId).toBe(5106);
  });

  it("matches case-insensitively and ignores other rows", () => {
    const page = searchPage(
      row("[CADE]DeadVeganCat", "3000", "-", 10, 5, 15, "66.7") + POLONIUM,
    );
    const r = parsePlayerSearch(page, "[cade]polonium210");
    expect(r?.rating).toBe(4407);
  });

  it("returns null when no row's name matches exactly", () => {
    // A substring search can return near-matches; we only accept exact names.
    expect(parsePlayerSearch(searchPage(POLONIUM), "Polonium")).toBeNull();
  });

  it("returns null for an empty result set", () => {
    expect(parsePlayerSearch(searchPage(""), "Nobody")).toBeNull();
  });

  it("strips commas from large ratings", () => {
    const page = searchPage(row("Big", "1,234", "-", 1, 1, 2, "50.0"));
    expect(parsePlayerSearch(page, "Big")?.rating).toBe(1234);
  });
});

describe("fetchPlayerRating", () => {
  function fakeFetch(pages: Record<string, string>, calls: string[]): typeof fetch {
    return (async (url: string | URL) => {
      const u = new URL(url.toString());
      const q = u.searchParams.get("q") ?? "";
      calls.push(q);
      return new Response(pages[q] ?? searchPage(""), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
  }

  it("resolves a known player to their rating", async () => {
    const calls: string[] = [];
    const fetchFn = fakeFetch({ "[CADE]Polonium210": searchPage(POLONIUM) }, calls);
    const r = await fetchPlayerRating("[CADE]Polonium210", { fetchFn });
    expect(r?.rating).toBe(4407);
    expect(calls).toEqual(["[CADE]Polonium210"]);
  });

  it("returns null for an unknown player (empty result set)", async () => {
    const fetchFn = fakeFetch({}, []);
    expect(await fetchPlayerRating("ghost", { fetchFn })).toBeNull();
  });

  it("retries once after a failed request", async () => {
    let attempts = 0;
    const fetchFn = (async () => {
      attempts++;
      if (attempts === 1) throw new Error("network blip");
      return new Response(searchPage(POLONIUM), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await fetchPlayerRating("[CADE]Polonium210", { fetchFn });
    expect(attempts).toBe(2);
    expect(r?.rating).toBe(4407);
  });

  it("throws after the single retry also fails", async () => {
    let attempts = 0;
    const fetchFn = (async () => {
      attempts++;
      throw new Error("down");
    }) as unknown as typeof fetch;

    await expect(fetchPlayerRating("ghost", { fetchFn })).rejects.toThrow("down");
    expect(attempts).toBe(2); // initial + one retry
  });

  it("treats a non-2xx response as a failure and retries", async () => {
    let attempts = 0;
    const fetchFn = (async () => {
      attempts++;
      return new Response("nope", { status: 503, statusText: "Service Unavailable" });
    }) as unknown as typeof fetch;

    await expect(fetchPlayerRating("[CADE]Polonium210", { fetchFn })).rejects.toThrow(
      /lavabar GET .* responded 503/,
    );
    expect(attempts).toBe(2);
  });

  it("aborts a slow request via the timeout (here shortened)", async () => {
    let aborts = 0;
    const fetchFn = ((_url: string | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborts++;
          reject(new Error("aborted"));
        });
      })) as unknown as typeof fetch;

    await expect(fetchPlayerRating("slowpoke", { fetchFn, timeoutMs: 5 })).rejects.toThrow();
    expect(aborts).toBe(2); // both the initial attempt and the retry time out
  });
});
