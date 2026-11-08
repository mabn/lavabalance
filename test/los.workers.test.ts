// End-to-end tests for the lavaos Worker + LosDO inside workerd
// (vitest project "lavaos-workers", config wrangler.lavaos.toml). The DO's
// SQLite persists across tests in this pool, so every test starts from an
// explicit reset and uploads what it needs through the real routes.

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { fetchAs } from "./adminFetch";
import { beforeEach, describe, expect, it } from "vitest";
import { lavaReplay } from "./losFixtures";

/** Admin routes as a superadmin (./adminFetch), everything else as a visitor. */
const call = fetchAs((url, init) => SELF.fetch(url, init));

const BASE = "https://lavaos.test";

beforeEach(async () => {
  const res = await call(`${BASE}/api/reset?confirm=true`, { method: "POST" });
  expect(res.status).toBe(200);
});

async function upload(games: unknown): Promise<any> {
  const res = await call(`${BASE}/api/games`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(games),
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function getJson(path: string, expectStatus = 200): Promise<any> {
  const res = await call(`${BASE}${path}`);
  expect(res.status).toBe(expectStatus);
  return res.json();
}

async function postJson(path: string, body: unknown, expectStatus = 200): Promise<any> {
  const res = await call(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(expectStatus);
  return res.json();
}

/** Hide (or unhide) one player's profile the way the ranking page's row menu does. */
const setPrivate = (userId: number, isPrivate: boolean, status = 200) =>
  postJson(`/api/players/${userId}/private`, { private: isPrivate }, status);

// Fixture games are dated relative to TODAY rather than pinned to a month. The
// store marks a player inactive after INACTIVE_DAYS (35) without a rated game,
// so a hard-coded date would quietly lapse every fixture player once real time
// moved past it — and every ranking assertion with them. `d` is a day offset
// from a base a little over a week back, so day(1..3) are recent; a negative
// offset reaches back past the activity window on purpose.
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_BASE = new Date(Date.now() - 10 * DAY_MS);
const day = (d: number, h: number, id: string) => ({
  id,
  startTime: new Date(
    Date.UTC(DAY_BASE.getUTCFullYear(), DAY_BASE.getUTCMonth(), DAY_BASE.getUTCDate() + d, h),
  ).toISOString(),
});
/** The same, but far enough back that the players in it count as inactive. */
const staleDay = (h: number, id: string) => day(-45, h, id);

describe("upload", () => {
  it("rates new games, ignores late ones, drops skipped/rejected, dedupes retries", async () => {
    const g2a = lavaReplay({ ...day(2, 10, "g2a") });
    const g2b = lavaReplay({ ...day(2, 12, "g2b"), winner: 1 });
    const first = await upload([g2b, g2a]); // out of order within the batch: sorted internally
    expect(first.rated).toEqual(["g2a", "g2b"]);
    expect(first.lastSeq).toBe(2);
    expect(first.players).toBe(16);

    // A day-1 game arrives late → rateable but behind the fold head → ignored.
    const late = await upload([lavaReplay({ ...day(1, 20, "g1a") })]);
    expect(late.rated).toEqual([]);
    expect(late.ignored).toEqual([
      { id: "g1a", startTime: day(1, 20, "g1a").startTime, headAt: day(2, 12, "g2b").startTime },
    ]);
    expect(late.lastSeq).toBe(2);
    // A fold-behind game records its reason too.
    expect((await getJson("/api/games/g1a")).unrankedReason).toBe("uploaded too late");

    // Retry of stored games → duplicate (the ignored one is not resurrected);
    // ineligible and non-lava games are reported and never stored.
    const retry = await upload([
      g2a,
      lavaReplay({ ...day(1, 20, "g1a") }),
      lavaReplay({ ...day(2, 14, "nowin"), winner: null }),
      lavaReplay({ ...day(2, 15, "notlava"), gameSettings: {} }),
    ]);
    expect(retry.duplicate.sort()).toEqual(["g1a", "g2a"]);
    expect(retry.skipped).toEqual([{ id: "nowin", reason: "no winning team" }]);
    expect(retry.rejected).toEqual(["notlava"]);
    expect(retry.lastSeq).toBe(2);

    // Dropped games left no rows behind: the list holds only rated + ignored.
    const list = await getJson("/api/games");
    expect(list.games.map((g: any) => [g.id, g.ignored])).toEqual([
      ["g2b", false],
      ["g2a", false],
      ["g1a", true],
    ]);
  });

  it("stores an off-map lava game unranked, without touching the fold", async () => {
    // On-map game rates and sets the head.
    const first = await upload([lavaReplay({ ...day(2, 10, "iso1") })]);
    expect(first.rated).toEqual(["iso1"]);

    // A NEWER off-map lava game is kept, but as ignored — no seq, no head move.
    const off = await upload([lavaReplay({ ...day(2, 12, "hellas1"), mapName: "Hellas Basin v1.4" })]);
    expect(off.rated).toEqual([]);
    expect(off.ignored).toEqual([
      { id: "hellas1", startTime: day(2, 12, "hellas1").startTime, headAt: day(2, 10, "iso1").startTime, reason: "off-map" },
    ]);
    expect(off.lastSeq).toBe(first.lastSeq);

    // The head did not move: an on-map game from between the two still RATES
    // (had the off-map game advanced it, this would come back ignored).
    const between = await upload([lavaReplay({ ...day(2, 11, "iso2") })]);
    expect(between.rated).toEqual(["iso2"]);

    // Stored means stored: a retry is a duplicate, and the game lists as
    // ignored with its own map.
    const retry = await upload([lavaReplay({ ...day(2, 12, "hellas1"), mapName: "Hellas Basin v1.4" })]);
    expect(retry.duplicate).toEqual(["hellas1"]);
    const list = await getJson("/api/games");
    const row = list.games.find((g: any) => g.id === "hellas1");
    expect(row.ignored).toBe(true);
    expect(row.map).toBe("Hellas Basin v1.4");
    // The WHY is on the row, list and detail alike — the badge's tooltip.
    expect(row.unrankedReason).toBe("off-map");
    expect((await getJson("/api/games/hellas1")).unrankedReason).toBe("off-map");
    expect(list.games.find((g: any) => g.id === "iso1").unrankedReason).toBe(null);

    // An off-map game failing a map-independent rule is still dropped.
    const bad = await upload([lavaReplay({ ...day(2, 13, "hellas2"), mapName: "Hellas Basin v1.4", winner: null })]);
    expect(bad.skipped).toEqual([{ id: "hellas2", reason: "no winning team" }]);
  });

  it("rebase re-folds from a late game and matches a chronological upload", async () => {
    const A = () => lavaReplay({ ...day(2, 10, "gA"), winner: 0 });
    const B = () => lavaReplay({ ...day(2, 11, "gB"), winner: 1 });
    const C = () => lavaReplay({ ...day(2, 12, "gC"), winner: 0 });
    const O = () => lavaReplay({ ...day(2, 11, "gO"), winner: 0, mapName: "Hellas Basin v1.4" });
    const snapshot = async () => ({
      ranking: (await getJson("/api/ranking?perPage=200")).players.map((p: any) => [p.userId, p.los, p.games, p.wins, p.rank]),
      b: (await getJson("/api/games/gB")).teams.flat().map((p: any) => [p.userId, p.losBefore, p.losDelta]),
      c: (await getJson("/api/games/gC")).teams.flat().map((p: any) => [p.userId, p.losBefore, p.losDelta]),
    });

    // The truth: everything uploaded in chronological order.
    await upload([A(), B(), C()]);
    const want = await snapshot();

    // The accident: B arrives after C and lands ignored "uploaded too late"
    // (gO, off-map, is stored unranked either way).
    await call(`${BASE}/api/reset?confirm=true`, { method: "POST" });
    await upload([A(), O()]);
    await upload([C()]);
    const lateB = await upload([B()]);
    expect(lateB.ignored.map((g: any) => g.id)).toEqual(["gB"]);
    expect((await getJson("/api/games/gB")).unrankedReason).toBe("uploaded too late");

    // The Crescent Bay corruption: an off-map row wearing the wrong label (a
    // blanket backfill once did this). The rebase must judge by the MAP, so
    // the label gets repaired instead of believed.
    const stub = env.LOS.get(env.LOS.idFromName("singleton"));
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(`UPDATE games SET unranked_reason = 'uploaded too late' WHERE id = 'gO'`);
    });

    // The recovery: rebase from gB — it takes its chronological place, gC
    // re-rates on top, gO stays ignored for its own reason.
    const res = await call(`${BASE}/api/games/gB/rebase`, { method: "POST" });
    expect(res.status).toBe(200);
    const r = (await res.json()) as any;
    expect([r.ok, r.rated, r.ignored, r.games]).toEqual([true, 2, 1, 3]);

    const got = await snapshot();
    expect(got).toEqual(want);
    expect((await getJson("/api/games/gB")).ignored).toBe(false);
    expect((await getJson("/api/games/gB")).unrankedReason).toBe(null);
    expect((await getJson("/api/games/gO")).unrankedReason).toBe("off-map");

    // Opting in rates the off-map game too; a default re-run resets it to
    // unranked again and restores the Supreme-Isthmus-only fold exactly.
    const optIn = await call(`${BASE}/api/games/gB/rebase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeOffMap: true }),
    });
    const oi = (await optIn.json()) as any;
    expect([oi.rated, oi.ignored]).toEqual([3, 0]);
    expect((await getJson("/api/games/gO")).ignored).toBe(false);
    const undo = await call(`${BASE}/api/games/gB/rebase`, { method: "POST" });
    expect(((await undo.json()) as any).ignored).toBe(1);
    expect((await getJson("/api/games/gO")).unrankedReason).toBe("off-map");
    expect(await snapshot()).toEqual(want);

    // The head moved to gC's fold position: the next game rates normally.
    const next = await upload([lavaReplay({ ...day(2, 13, "gD"), winner: 1 })]);
    expect(next.rated).toEqual(["gD"]);

    // A rebase of a game never stored refuses rather than guessing.
    const missing = await call(`${BASE}/api/games/nope/rebase`, { method: "POST" });
    expect(missing.status).toBe(404);
  });

  it("rejects malformed bodies", async () => {
    const bad = await call(`${BASE}/api/games`, { method: "POST", body: "{" });
    expect(bad.status).toBe(400);
    const notArray = await call(`${BASE}/api/games`, {
      method: "POST",
      body: JSON.stringify({ nope: true }),
    });
    expect(notArray.status).toBe(400);
    const badElem = await call(`${BASE}/api/games`, {
      method: "POST",
      body: JSON.stringify([{ id: "x" }]),
    });
    expect(badElem.status).toBe(400);
    expect(((await badElem.json()) as any).error).toContain("games[0]");
  });
});

// From 2026-10-01 only 4000 start metal storage is rated. The upload stores a
// game with another value unranked; the rebase re-judges stored rows by the
// value kept on the games row, and refuses while a row from before that column
// existed has none (re-uploading the game is the backfill).
describe("start metal storage rule", () => {
  const OLD = "2026-09-30T20:00:00.000Z";
  const at = (h: number) => `2026-10-01T${String(h).padStart(2, "0")}:00:00.000Z`;

  it("stores a non-4000 game unranked, skips one without a value", async () => {
    const r = await upload([
      lavaReplay({ id: "old3000", startTime: OLD, startMetalStorage: "3000" }),
      lavaReplay({ id: "new4000", startTime: at(1), winner: 1 }),
      lavaReplay({ id: "new3000", startTime: at(2), startMetalStorage: "3000" }),
      lavaReplay({ id: "newNone", startTime: at(3), startMetalStorage: null }),
    ]);
    expect(r.rated).toEqual(["old3000", "new4000"]);
    expect(r.ignored).toEqual([
      { id: "new3000", startTime: at(2), headAt: at(1), reason: "start metal storage" },
    ]);
    expect(r.skipped).toEqual([{ id: "newNone", reason: "no start metal storage" }]);
    const g = await getJson("/api/games/new3000");
    expect([g.ignored, g.unrankedReason]).toEqual([true, "start metal storage"]);
  });

  it("rebase re-judges stored rows, and waits for a backfill of rows without the value", async () => {
    const games = () => [
      lavaReplay({ id: "a", startTime: OLD, startMetalStorage: "3000" }),
      lavaReplay({ id: "b", startTime: at(1), winner: 1 }),
      lavaReplay({ id: "c", startTime: at(2), startMetalStorage: "3000" }),
      lavaReplay({ id: "d", startTime: at(3) }),
    ];
    const snapshot = async () =>
      (await getJson("/api/ranking?perPage=200")).players.map((p: any) => [p.userId, p.los, p.games, p.wins]);
    await upload(games());
    const want = await snapshot();

    // A store from before the rule: c was RATED, and no row recorded its value.
    const stub = env.LOS.get(env.LOS.idFromName("singleton"));
    await call(`${BASE}/api/reset?confirm=true`, { method: "POST" });
    await upload(games().map((g) => (g.id === "c" ? { ...g, gameSettings: { ...g.gameSettings, startmetalstorage: "4000" } } : g)));
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(`UPDATE games SET start_metal_storage = NULL`);
    });
    expect((await getJson("/api/games/c")).ignored).toBe(false);

    // Refused: three games since the cutoff have no value to judge by.
    const refused = await postJson("/api/games/a/rebase", {}, 409);
    expect(refused.error).toContain("3 stored game(s)");

    // The backfill: re-uploading fills the value (a duplicate otherwise).
    const again = await upload(games());
    expect(again.duplicate).toEqual(["a", "b", "c", "d"]);
    const res = await postJson("/api/games/a/rebase", {});
    expect([res.ok, res.rated, res.ignored]).toEqual([true, 3, 1]);
    expect((await getJson("/api/games/c")).unrankedReason).toBe("start metal storage");
    expect(await snapshot()).toEqual(want);
  });
});

// The games page's row menu: an admin marks a game ignored, and the LOS re-run
// is what acts on the marking. They are separate on purpose — the toggle
// recalculates nothing — so both halves are pinned here.
describe("ignoring a game", () => {
  /** Mark a stored game ignored (or not) the way the games page's row menu does. */
  const setIgnored = (id: string, ignored: boolean, status = 200) =>
    postJson(`/api/games/${id}/ignored`, { ignored }, status);

  it("marks a game without moving a single rating, and the re-run is what drops it", async () => {
    const A = () => lavaReplay({ ...day(2, 10, "gA"), winner: 0 });
    const B = () => lavaReplay({ ...day(2, 11, "gB"), winner: 1 });
    const C = () => lavaReplay({ ...day(2, 12, "gC"), winner: 0 });
    const ranking = async () =>
      (await getJson("/api/ranking?perPage=200")).players.map((p: any) => [p.userId, p.los, p.games, p.wins]);

    await upload([A(), B(), C()]);
    const rated = await ranking();

    // Marking it: the flag moves, the fold does not. The game is still rated,
    // still carries its ratings, and every player is exactly where they were.
    const marked = await setIgnored("gB", true);
    expect([marked.excluded, marked.changed, marked.ignored, marked.needsRebase]).toEqual([true, true, false, true]);
    expect(await ranking()).toEqual(rated);
    const gB = await getJson("/api/games/gB");
    expect([gB.excluded, gB.ignored, gB.unrankedReason]).toEqual([true, false, null]);
    // The listing carries the marker too — it is what the row badges.
    const list = await getJson("/api/games");
    expect(list.games.find((g: any) => g.id === "gB").excluded).toBe(true);

    // Marking it again changes nothing and says so.
    expect((await setIgnored("gB", true)).changed).toBe(false);

    // The re-run is what acts on it: gB is left unrated for the marker's own
    // reason and gC re-rates without it, so the ratings really do move now.
    const r = await postJson("/api/games/gB/rebase", {});
    expect([r.rated, r.ignored, r.games]).toEqual([1, 1, 2]);
    const after = await getJson("/api/games/gB");
    expect([after.excluded, after.ignored, after.unrankedReason]).toEqual([true, true, "excluded"]);
    expect(await ranking()).not.toEqual(rated);

    // An opt-in to off-map games does NOT override the marker: it is a
    // deliberate exclusion, not a map verdict.
    const optIn = await postJson("/api/games/gB/rebase", { includeOffMap: true });
    expect(optIn.ignored).toBe(1);
    expect((await getJson("/api/games/gB")).ignored).toBe(true);

    // Un-marking is the same deal in reverse: the flag clears, the game stays
    // unrated until the fold puts it back — and then the store is byte-identical
    // to the one that never had the marker at all.
    const cleared = await setIgnored("gB", false);
    expect([cleared.excluded, cleared.changed, cleared.ignored, cleared.needsRebase]).toEqual([false, true, true, true]);
    expect((await getJson("/api/games/gB")).ignored).toBe(true);
    await postJson("/api/games/gB/rebase", {});
    expect((await getJson("/api/games/gB")).unrankedReason).toBe(null);
    expect(await ranking()).toEqual(rated);
  });

  it("says nothing is pending when the fold left the game out for its own reasons", async () => {
    // An off-map game is unrated whatever this marker says, so clearing a
    // marker on one is not a re-run waiting to happen and must not be reported
    // as one — the page would promise a rating the default re-run will not give.
    await upload([
      lavaReplay({ ...day(2, 10, "gA") }),
      lavaReplay({ ...day(2, 11, "gOff"), mapName: "Hellas Basin v1.4" }),
    ]);
    expect((await getJson("/api/games/gOff")).unrankedReason).toBe("off-map");
    expect((await setIgnored("gOff", true)).needsRebase).toBe(false); // already unrated
    expect((await setIgnored("gOff", false)).needsRebase).toBe(false); // still would be
  });

  it("validates the body and refuses a game it never stored", async () => {
    await upload([lavaReplay({ ...day(2, 10, "gA") })]);
    await setIgnored("nope", true, 404);
    const bad = await call(`${BASE}/api/games/gA/ignored`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ignored: "yes" }),
    });
    expect(bad.status).toBe(400);
  });
});

describe("ranking", () => {
  it("includes every rated player by default, ranked by LOS, and pages", async () => {
    await upload([lavaReplay({ ...day(2, 10, "g1") }), lavaReplay({ ...day(2, 12, "g2") })]);
    const all = await getJson("/api/ranking");
    expect(all.total).toBe(16);
    expect(all.minGames).toBeUndefined();
    expect(all.players).toHaveLength(16);
    expect(all.players[0].rank).toBe(1);
    expect(all.players[0].games).toBe(2);
    // Team 0 (winners of both games) outrank team 1.
    expect(all.players[0].userId).toBeLessThan(200);
    const los = all.players.map((p: any) => p.los);
    expect(los).toEqual([...los].sort((a: number, b: number) => b - a));

    const page2 = await getJson("/api/ranking?perPage=10&page=2");
    expect(page2.players).toHaveLength(6);
    expect(page2.players[0].rank).toBe(11);
    expect(page2.players[0].userId).toBe(all.players[10].userId);
    // minGames is gone: the parameter is ignored, every rated player is listed.
    expect((await getJson("/api/ranking?minGames=3")).total).toBe(16);
  });

  it("prefix-searches the ranking by name, keeping the global rank", async () => {
    // Team 0 = player101..108 wins both games, so they rank above team 1 (201..208).
    await upload([lavaReplay(day(2, 10, "g1")), lavaReplay(day(2, 12, "g2"))]);
    const all = await getJson("/api/ranking?perPage=100&includePrivate=true");
    const rankOf = new Map(all.players.map((p: any) => [p.userId, p.rank]));
    // A visitor's matches carry no number: the LOS position is hidden, and a
    // place on the tier board would cost a count per match.
    expect((await getJson("/api/ranking?q=player2")).players.every((p: any) => p.rank === null)).toBe(true);

    // "player2" matches the eight losers only (prefix, not contains: "layer" matches nobody).
    const losers = await getJson("/api/ranking?q=player2&includePrivate=true");
    expect(losers.total).toBe(8);
    expect(losers.q).toBe("player2");
    expect(losers.players.map((p: any) => p.userId).sort()).toEqual([201, 202, 203, 204, 205, 206, 207, 208]);
    // Ranks are the leaderboard positions, not 1..8.
    for (const p of losers.players) expect(p.rank).toBe(rankOf.get(p.userId));
    expect(Math.min(...losers.players.map((p: any) => p.rank))).toBe(9);
    // Ordered by LOS like the leaderboard.
    expect(losers.players.map((p: any) => p.rank)).toEqual([...losers.players].map((p: any) => p.rank).sort((a, b) => a - b));
    expect((await getJson("/api/ranking?q=layer")).total).toBe(0);

    // Case-insensitive; paging covers the matches.
    expect((await getJson("/api/ranking?q=PLAYER2")).total).toBe(8);
    const p2 = await getJson("/api/ranking?q=player&perPage=5&page=4&includePrivate=true");
    expect(p2.total).toBe(16);
    expect(p2.players).toHaveLength(1);
    expect(p2.players[0].rank).toBe(16);
    // LIKE wildcards in the input are literal.
    expect((await getJson("/api/ranking?q=%")).total).toBe(0);
    expect((await getJson("/api/ranking?q=player10_")).total).toBe(0);
    // Blank q = the plain leaderboard.
    expect((await getJson("/api/ranking?q=%20")).total).toBe(16);
  });
});

describe("games list & detail", () => {
  it("lists newest first with ignored flags, filters, and keyset-pages", async () => {
    await upload([
      lavaReplay({ ...day(2, 10, "g1") }),
      lavaReplay({ ...day(2, 12, "g2"), winner: 1 }),
    ]);
    // In its own LATER upload, a day-1 game is behind the fold head → ignored.
    // (In the same batch it would have sorted first and been rated.)
    await upload([lavaReplay({ ...day(1, 9, "old") })]);
    const list = await getJson("/api/games");
    expect(list.games.map((g: any) => g.id)).toEqual(["g2", "g1", "old"]);
    expect(list.games.map((g: any) => g.ignored)).toEqual([false, false, true]);
    expect(list.games[0].winnerTeam).toBe(1);
    expect(list.games[0].teams[0]).toHaveLength(8);
    expect(list.games[0].teams[1]).toHaveLength(8);
    // Rated games carry the pre-game prediction (two chances summing to 1).
    expect(list.games[0].predictedWin).toHaveLength(2);
    expect(list.games[0].predictedWin[0] + list.games[0].predictedWin[1]).toBeCloseTo(1, 9);
    // Ignored game: roster stored, ratings null, no prediction.
    const old = list.games[2];
    expect(old.teams[0][0].losAfter).toBeNull();
    expect(old.predictedWin).toBeNull();

    const ratedOnly = await getJson("/api/games?rated=true");
    expect(ratedOnly.games.map((g: any) => g.id)).toEqual(["g2", "g1"]);

    const p1 = await getJson("/api/games?limit=1");
    expect(p1.games.map((g: any) => g.id)).toEqual(["g2"]);
    const p2 = await getJson(
      `/api/games?limit=1&afterTime=${encodeURIComponent(p1.next.afterTime)}&afterId=${p1.next.afterId}`,
    );
    expect(p2.games.map((g: any) => g.id)).toEqual(["g1"]);

    const badCursor = await call(`${BASE}/api/games?afterTime=x`);
    expect(badCursor.status).toBe(400);

    // Numbered paging (the Games page): page N of the same newest-first order,
    // with the total so the client can print "page N of M".
    const n1 = await getJson("/api/games?page=1&limit=2");
    expect(n1.games.map((g: any) => g.id)).toEqual(["g2", "g1"]);
    expect([n1.page, n1.perPage, n1.total]).toEqual([1, 2, 3]);
    const n2 = await getJson("/api/games?page=2&limit=2");
    expect(n2.games.map((g: any) => g.id)).toEqual(["old"]);
    expect(n2.next).toBeNull();
    const n3 = await getJson("/api/games?page=3&limit=2");
    expect(n3.games).toEqual([]);
    expect(n3.total).toBe(3);
    // The total honours the rated filter.
    const nr = await getJson("/api/games?page=1&limit=2&rated=true");
    expect(nr.total).toBe(2);
    // A page number and a keyset cursor are two different contracts.
    const mixed = await call(`${BASE}/api/games?page=1&afterTime=x&afterId=y`);
    expect(mixed.status).toBe(400);
  });

  it("serves game detail with LOS deltas and a pre-game prediction", async () => {
    await upload([lavaReplay({ ...day(2, 10, "g1") })]);
    // LOS is admin-only; a visitor gets the same game with every LOS nulled
    // and each player's rank tier going in (all placing at game 1).
    const pub = await getJson("/api/games/g1");
    for (const p of [...pub.teams[0], ...pub.teams[1]]) {
      expect([p.losBefore, p.losAfter, p.losDelta, p.muBefore, p.sigmaAfter]).toEqual([null, null, null, null, null]);
      expect(p.tier).toBe("placing");
    }
    expect(pub.avgLosBefore).toBeNull();
    expect(pub.predictedWin).toHaveLength(2);
    const g = await getJson("/api/games/g1?includePrivate=true");
    expect(g.seq).toBe(1);
    expect(g.ignored).toBe(false);
    expect(g.teams[0]).toHaveLength(8);
    for (const p of [...g.teams[0], ...g.teams[1]]) {
      expect(p.gameNumber).toBe(1);
      // Shown LOS: a debutant's μ minus the game-0 rookie handicap, minus σ.
      expect(p.losBefore).toBeCloseTo(25 - 13 - 25 / 3, 6);
      expect(p.losAfter).not.toBeNull();
      expect(p.losDelta).toBeCloseTo(p.losAfter - p.losBefore, 12);
    }
    // Winners' LOS goes up, losers' down (debutants: sigma shrink can't mask it).
    expect(g.teams[0][0].losDelta).toBeGreaterThan(0);
    expect(g.teams[1][0].losDelta).toBeLessThan(0);
    expect(g.predictedWin[0] + g.predictedWin[1]).toBeCloseTo(1, 6);
    expect(g.predictedWin[0]).toBeCloseTo(0.5, 6); // equal debutant teams

    await getJson("/api/games/unknown", 404);
  });

  // The chevron is stored per game rather than per player precisely so it
  // stays a reading of the past: what BAR thought of that account the day it
  // played, which nothing can recover afterwards. So it has to survive the
  // whole round trip — upload, column, wire — and keep level 0 apart from the
  // silence of a replay that stated no rank at all.
  it("keeps each player's chevron on the game, 0 and unstated distinct", async () => {
    await upload([lavaReplay({ ...day(2, 10, "g1"), ranks: { 101: 5, 102: 0 } })]);

    const g = await getJson("/api/games/g1");
    const rankOf = (userId: number) =>
      [...g.teams[0], ...g.teams[1]].find((p: { userId: number }) => p.userId === userId).barRank;
    expect(rankOf(101)).toBe(5);
    expect(rankOf(102)).toBe(0);
    expect(rankOf(103)).toBeNull();

    // The same rows reached through a player's own games page.
    const games = await getJson("/api/players/101/games");
    expect(games.games[0].teams[0].find((p: { userId: number }) => p.userId === 101).barRank).toBe(5);
  });

  it("stores the upload's lobby info verbatim and serves it from the detail", async () => {
    const lobbyDetails = {
      locked: false,
      passworded: false,
      memberCount: 17,
      spectatorCount: 1,
      players: [
        { name: "player101", team: 1, party: "#62ea6b", rating: 27.25, bonus: 0, faction: "Cortex" },
        { name: "player102", team: 1, party: "#62ea6b", rating: 21.1, bonus: 0, faction: "Random" },
      ],
    };
    await upload([
      { ...lavaReplay({ ...day(2, 10, "gl1") }), lobbyName: "Supreme LAVA | 8v8", lobbyDetails },
      lavaReplay({ ...day(2, 12, "gl2") }), // no lobby keys on this one
      // Off-map games are stored too, and keep their lobby info like any row.
      { ...lavaReplay({ ...day(2, 14, "glo"), mapName: "Hellas Basin v1.4" }), lobbyName: "LAVA elsewhere" },
    ]);
    const g = await getJson("/api/games/gl1");
    expect(g.lobby).toEqual({ lobbyName: "Supreme LAVA | 8v8", lobbyDetails });
    expect((await getJson("/api/games/gl2")).lobby).toBe(null);
    expect((await getJson("/api/games/glo")).lobby).toEqual({ lobbyName: "LAVA elsewhere" });
    // The list shape is unchanged — the lobby JSON rides the detail only.
    const list = await getJson("/api/games");
    expect(Object.keys(list.games[0])).not.toContain("lobby");
  });

  it("backfills lobby info from a duplicate upload without overwriting it", async () => {
    const bare = lavaReplay({ ...day(2, 10, "gb1") });
    await upload([bare]);
    expect((await getJson("/api/games/gb1")).lobby).toBe(null);
    // The re-offer now carries the matched lobby → fills the NULL column.
    const dup = await upload([{ ...bare, lobbyName: "Supreme LAVA" }]);
    expect(dup.duplicate).toEqual(["gb1"]);
    expect((await getJson("/api/games/gb1")).lobby).toEqual({ lobbyName: "Supreme LAVA" });
    // A later duplicate with different info never overwrites what is stored.
    await upload([{ ...bare, lobbyName: "renamed" }]);
    expect((await getJson("/api/games/gb1")).lobby).toEqual({ lobbyName: "Supreme LAVA" });
  });
});

describe("players", () => {
  it("serves profile, history and search", async () => {
    await upload([
      lavaReplay({ ...day(2, 10, "g1"), skills: { 101: "[30.9]" } }),
      lavaReplay({ ...day(2, 12, "g2"), winner: 1 }),
    ]);
    const pub = await getJson("/api/players/101");
    expect([pub.los, pub.mu, pub.sigma, pub.leaderboardRating]).toEqual([null, null, null, null]);
    expect(pub.tier).toBe("placing");
    expect(pub.recentGames[0].losBefore).toBeNull();
    expect((await getJson("/api/players/101/history")).points).toEqual([]);
    const p = await getJson("/api/players/101?includePrivate=true");
    expect(p.tier).toBe("placing");
    expect(p.name).toBe("player101");
    expect(p.games).toBe(2);
    expect(p.wins).toBe(1);
    expect(p.losses).toBe(1);
    expect(p.barOs).toBe(30.9);
    expect(p.rank).toBeGreaterThanOrEqual(1);
    expect(p.rankedOf).toBe(16);
    expect(p.recentGames).toHaveLength(2);
    expect(p.recentGames[0].gameId).toBe("g2"); // newest first
    expect(p.recentGames[0].won).toBe(false);
    // Each recent game carries the whole game (the /games shape) + this player's side.
    const rg = p.recentGames[0];
    expect(rg.id).toBe("g2");
    expect(rg.team).toBe(0);
    expect(rg.winnerTeam).toBe(1);
    expect(rg.durationMs).toBe(20 * 60_000);
    expect(rg.teams[0]).toHaveLength(8);
    expect(rg.predictedWin).toHaveLength(2);
    expect(rg.losBefore).not.toBeNull();
    expect(rg.losDelta).toBeLessThan(0);

    // The paged games table: numbered pages over the same rows, newest first.
    const pg1 = await getJson("/api/players/101/games?page=1&limit=1");
    expect(pg1.games.map((g: any) => g.id)).toEqual(["g2"]);
    expect([pg1.page, pg1.perPage, pg1.total]).toEqual([1, 1, 2]);
    expect(pg1.games[0].team).toBe(0);
    const pg2 = await getJson("/api/players/101/games?page=2&limit=1");
    expect(pg2.games.map((g: any) => g.id)).toEqual(["g1"]);
    expect((await getJson("/api/players/101/games?page=3&limit=1")).games).toEqual([]);
    expect((await getJson("/api/players/999999/games")).total).toBe(0);
    await getJson("/api/players/x/games", 400);

    const h = await getJson("/api/players/101/history?includePrivate=true");
    expect(h.points.map((x: any) => x.gameId)).toEqual(["g1", "g2"]); // oldest first
    expect(h.points[0].gameNumber).toBe(1);
    expect(h.points[1].gameNumber).toBe(2);
    expect(h.points[1].los).toBe(p.los);

    await getJson("/api/players/999999", 404);

    const found = await getJson("/api/players?q=PLAYER10");
    expect(found.players.map((x: any) => x.userId)).toContain(101);
    const none = await getJson("/api/players?q=zzz");
    expect(none.players).toEqual([]);
    await getJson("/api/players?q=", 400);
  });

  it("bulk-resolves current names case-insensitively via /api/players/lookup", async () => {
    await upload([lavaReplay(day(2, 10, "g1"))]);
    // A visitor gets the names resolved with the tier, no LOS.
    const pub = await getJson("/api/players/lookup?names=PLAYER101");
    expect(pub.players.player101).toMatchObject({ userId: 101, los: null, mu: null, tier: "placing" });
    const out = await getJson("/api/players/lookup?names=PLAYER101,player201,%20player102%20,ghost&includePrivate=true");
    // Keyed by the lowercased name; unknown names are simply absent.
    expect(Object.keys(out.players).sort()).toEqual(["player101", "player102", "player201"]);
    expect(out.players.player101.userId).toBe(101);
    expect(out.players.player101.games).toBe(1);
    // Shown LOS carries the rookie handicap for the games played (1 here).
    expect(out.players.player101.los).toBeCloseTo(
      out.players.player101.mu - 13 * Math.exp(-1 / 25) - out.players.player101.sigma,
      9,
    );
    // Winners rate above losers after the one game.
    expect(out.players.player101.los).toBeGreaterThan(out.players.player201.los);

    await getJson("/api/players/lookup", 400);
    await getJson("/api/players/lookup?names=" + Array(40).fill("x").join(","), 400);
  });
});

describe("private profiles", () => {
  // 16 players over two games; team 0 (101..108) wins both, so it ranks above
  // team 1 (201..208). player101 is the one hidden throughout.
  beforeEach(async () => {
    await upload([lavaReplay(day(2, 10, "g1")), lavaReplay(day(2, 12, "g2"))]);
  });

  it("moves a hidden player to a rankless tail and keeps the ranks above gapless", async () => {
    const before = await getJson("/api/ranking?perPage=100");
    expect(before.total).toBe(16);
    expect(before.players.every((p: any) => p.privateProfile === false)).toBe(true);
    const hiddenRank = before.players.find((p: any) => p.userId === 101).rank;
    expect(hiddenRank).toBeLessThan(16); // it really is in the middle of the list

    expect(await setPrivate(101, true)).toEqual({
      userId: 101,
      name: "player101",
      privateProfile: true,
      changed: true,
    });

    const after = await getJson("/api/ranking?perPage=100");
    // Still listed — the total is everyone — but LAST, and with no position.
    expect(after.total).toBe(16);
    expect(after.players).toHaveLength(16);
    expect(after.players.at(-1).userId).toBe(101);
    expect(after.players.at(-1).rank).toBeNull();
    expect(after.players.at(-1).privateProfile).toBe(true);
    // No rating either: the leaderboard must not print what the player page hides.
    expect(after.players.at(-1)).toMatchObject({ los: null, mu: null, sigma: null, barOs: null });
    // What the games list already tells anyone is still there.
    expect(after.players.at(-1).games).toBe(2);
    expect(after.players.at(-1).name).toBe("player101");

    // The 15 ranked rows run 1..15 — no hole where the hidden player was.
    const ranked = after.players.filter((p: any) => !p.privateProfile);
    expect(ranked.map((p: any) => p.rank)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    for (const p of ranked) {
      const was = before.players.find((q: any) => q.userId === p.userId).rank;
      expect(p.rank).toBe(was > hiddenRank ? was - 1 : was);
      expect(p.tier).not.toBeNull();
    }

    // Paging: the tail lands on the last page, after the ranked players.
    const page2 = await getJson("/api/ranking?perPage=10&page=2");
    expect(page2.total).toBe(16);
    expect(page2.players).toHaveLength(6);
    expect(page2.players[0].rank).toBe(11);
    expect(page2.players.at(-1).userId).toBe(101);
    expect(page2.players.at(-1).rank).toBeNull();
    // A page that is ALL tail works too, and one past the end is empty.
    const last = await getJson("/api/ranking?perPage=5&page=4");
    expect(last.players.map((p: any) => p.userId)).toEqual([101]);
    expect((await getJson("/api/ranking?perPage=5&page=5")).players).toEqual([]);

    // Prefix search: matching public players first with their GLOBAL rank, then
    // the matching hidden ones in the tail.
    const search = await getJson("/api/ranking?q=player1");
    expect(search.total).toBe(8);
    expect(search.players.at(-1).userId).toBe(101);
    expect(search.players.at(-1).rank).toBeNull();
    // No numbers on a visitor's matches; the ranked ones still lead.
    expect(search.rankedTotal).toBe(7);
    expect(search.players.every((p: any) => p.rank === null)).toBe(true);
    expect(search.players.slice(0, 7).every((p: any) => !p.privateProfile)).toBe(true);
    // A search that matches ONLY the hidden player still finds them.
    const only = await getJson("/api/ranking?q=player101");
    expect(only.total).toBe(1);
    expect(only.players[0]).toMatchObject({ userId: 101, rank: null, los: null });

    // Unhiding restores the list, the order and every rank.
    expect((await setPrivate(101, false)).changed).toBe(true);
    const restored = await getJson("/api/ranking?perPage=100");
    expect(restored.total).toBe(16);
    expect(restored.players.map((p: any) => [p.userId, p.rank]))
      .toEqual(before.players.map((p: any) => [p.userId, p.rank]));
  });

  it("orders the tail by recency, saying nothing about how its players rate", async () => {
    const before = await getJson("/api/ranking?perPage=100");
    const rank = new Map(before.players.map((p: any) => [p.userId, p.rank]));
    // Two hidden players whose RATINGS differ: the tail must not order by them.
    await setPrivate(108, true);
    await setPrivate(101, true);
    expect(rank.get(101)).not.toBe(rank.get(108));

    const r = await getJson("/api/ranking?perPage=100");
    const tail = r.players.slice(-2);
    expect(tail.every((p: any) => p.rank === null && p.los === null)).toBe(true);
    // Same last game, so the tie breaks on user_id — either way, nothing about
    // the ordering tracks the ratings that were just taken away.
    expect(tail.map((p: any) => p.userId)).toEqual([101, 108]);
    expect(tail.map((p: any) => p.lastPlayed)).toEqual([
      before.players.find((p: any) => p.userId === 101).lastPlayed,
      before.players.find((p: any) => p.userId === 108).lastPlayed,
    ]);
    // The 14 ranked rows are still 1..14.
    expect(r.players.filter((p: any) => !p.privateProfile).map((p: any) => p.rank))
      .toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  });

  it("shows the admin the true leaderboard, hidden players in their real places", async () => {
    const before = await getJson("/api/ranking?perPage=100");
    const trueRank = new Map(before.players.map((p: any) => [p.userId, p.rank]));
    await setPrivate(101, true);

    const admin = await getJson("/api/ranking?perPage=100&includePrivate=true");
    expect(admin.total).toBe(16);
    expect(admin.includePrivate).toBe(true);
    expect(admin.players).toHaveLength(16);
    // Nothing moved and nothing is blanked — this is the list as it really is.
    expect(admin.players.map((p: any) => [p.userId, p.rank]))
      .toEqual(before.players.map((p: any) => [p.userId, p.rank]));
    const hidden = admin.players.find((p: any) => p.userId === 101);
    expect(hidden.privateProfile).toBe(true);
    expect(hidden.rank).toBe(trueRank.get(101));
    expect(hidden.los).toBeGreaterThan(0);
    // The search path agrees, and keeps the true global rank.
    const search = await getJson("/api/ranking?q=player101&includePrivate=true");
    expect(search.total).toBe(1);
    expect(search.players[0].rank).toBe(trueRank.get(101));
    expect(search.players[0].privateProfile).toBe(true);
    // Admin reads are never cached — the admin view must not reach a visitor.
    const res = await call(`${BASE}/api/ranking?includePrivate=true`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves a hidden profile with no rating, and its games with no LOS", async () => {
    await setPrivate(101, true);

    // The profile: the name and the flag, nothing else.
    const p = await getJson("/api/players/101");
    expect(p).toEqual({ userId: 101, name: "player101", privateProfile: true });

    // The chart series is empty (it is admin-only for every profile now).
    const h = await getJson("/api/players/101/history");
    expect(h.points).toEqual([]);

    // The games ARE listed — without this player's rating, anywhere in them.
    const games = await getJson("/api/players/101/games");
    expect(games.privateProfile).toBe(true);
    expect(games.total).toBe(2);
    expect(games.games.map((g: any) => g.id)).toEqual(["g2", "g1"]);
    for (const g of games.games) {
      expect([g.losBefore, g.losAfter, g.losDelta]).toEqual([null, null, null]);
      const me = g.teams.flat().find((x: any) => x.userId === 101);
      expect([me.losBefore, me.losAfter, me.muBefore, me.sigmaBefore, me.muAfter, me.sigmaAfter, me.barSkill])
        .toEqual([null, null, null, null, null, null, null]);
      expect(me.name).toBe("player101"); // the roster still names them
      // Everyone else keeps their rank, and the game's own prediction survives.
      const other = g.teams.flat().find((x: any) => x.userId === 201);
      expect(other.tier).not.toBeNull();
      expect(g.predictedWin).toHaveLength(2);
      expect(g.predictedWin.every((v: number) => Number.isFinite(v))).toBe(true);
    }

    // Nobody else's page changed.
    const other = await getJson("/api/players/201");
    expect(other.privateProfile).toBe(false);
    expect(other.tier).not.toBeNull();
    // No leaderboard position on a visitor's profile at all.
    expect(other.rank).toBeNull();
    expect(other.rankedOf).toBeNull();
  });

  it("serves the whole hidden profile to the admin view", async () => {
    const before = await getJson("/api/players/101?includePrivate=true");
    await setPrivate(101, true);
    const p = await getJson("/api/players/101?includePrivate=true");
    expect(p.privateProfile).toBe(true);
    expect(p.los).toBe(before.los);
    expect(p.games).toBe(2);
    // The admin's "#N of M" is the true one, over everyone.
    expect(p.rank).toBe(before.rank);
    expect(p.rankedOf).toBe(16);
    expect(p.recentGames[0].losDelta).not.toBeNull();

    const h = await getJson("/api/players/101/history?includePrivate=true");
    expect(h.points).toHaveLength(2);

    const games = await getJson("/api/players/101/games?includePrivate=true");
    expect(games.privateProfile).toBe(false);
    expect(games.games[0].losBefore).not.toBeNull();
    expect(games.games[0].teams.flat().find((x: any) => x.userId === 101).muBefore).not.toBeNull();
  });

  it("leaves the rating itself alone: the fold and the name lookup", async () => {
    const lookupBefore = await getJson("/api/players/lookup?names=player101");
    await setPrivate(101, true);

    // The bot balances on this — it must keep answering with the real rating.
    const lookup = await getJson("/api/players/lookup?names=player101");
    expect(lookup.players.player101.los).toBe(lookupBefore.players.player101.los);

    // And a later game still rates them.
    const rated = await upload([lavaReplay(day(3, 10, "g3"))]);
    expect(rated.rated).toEqual(["g3"]);
    expect((await getJson("/api/players/101?includePrivate=true")).games).toBe(3);
    // Still hidden after the upload — the fold never touches the flag.
    const listed = await getJson("/api/ranking?perPage=100");
    expect(listed.players.find((x: any) => x.userId === 101))
      .toMatchObject({ rank: null, los: null, privateProfile: true });
  });

  it("blanks a hidden player's rating in a game roster but keeps their delta", async () => {
    const before = await getJson("/api/games/g2");
    const meBefore = before.teams.flat().find((x: any) => x.userId === 101);
    const meAdminBefore = (await getJson("/api/games/g2?includePrivate=true")).teams
      .flat()
      .find((x: any) => x.userId === 101);
    await setPrivate(101, true);

    const game = await getJson("/api/games/g2");
    const me = game.teams.flat().find((x: any) => x.userId === 101);
    // Gone: every absolute figure, BAR's own skill number included.
    expect(me).toMatchObject({
      losBefore: null,
      losAfter: null,
      muBefore: null,
      sigmaBefore: null,
      muAfter: null,
      sigmaAfter: null,
      barSkill: null,
      privateProfile: true,
    });
    // Kept: who they are, which side, and how much they moved.
    expect(me.name).toBe("player101");
    expect(me.team).toBe(meBefore.team);
    expect(me.won).toBe(meBefore.won);
    expect(me.gameNumber).toBe(meBefore.gameNumber);
    expect(me.losDelta).toBe(meBefore.losDelta);

    // Nobody else is touched, and the game's own numbers do not move: they are
    // taken from the full roster BEFORE the blanking, so a visitor and an admin
    // read the same prediction and the same team averages.
    const other = game.teams.flat().find((x: any) => x.userId === 201);
    expect(other).toEqual(before.teams.flat().find((x: any) => x.userId === 201));
    expect(other.privateProfile).toBeUndefined();
    expect(game.predictedWin).toEqual(before.predictedWin);
    // A visitor sees no LOS at all now, so the averages are withheld too; the
    // rank tier goes with the rest of a private player's rating.
    expect(game.avgLosBefore).toBeNull();
    expect(me.tier).toBeNull();
    expect(other.tier).not.toBeNull();

    // The admin view keeps the whole roster.
    const admin = await getJson("/api/games/g2?includePrivate=true");
    expect(admin.teams.flat().find((x: any) => x.userId === 101)).toEqual(meAdminBefore);

    // The same blanking in every other roster the API serves.
    const list = await getJson("/api/games");
    for (const g of list.games) {
      const row = g.teams.flat().find((x: any) => x.userId === 101);
      if (row) expect(row).toMatchObject({ losBefore: null, privateProfile: true });
    }
    const theirGames = await getJson("/api/players/201/games");
    const inOpponentTable = theirGames.games[0].teams.flat().find((x: any) => x.userId === 101);
    expect(inOpponentTable).toMatchObject({ losBefore: null, privateProfile: true });
    // …and that page's own subject keeps their rank.
    expect(theirGames.games[0].tier).not.toBeNull();
  });

  it("validates the toggle and reports no-ops", async () => {
    expect((await setPrivate(101, true)).changed).toBe(true);
    expect(await setPrivate(101, true)).toEqual({
      userId: 101,
      name: "player101",
      privateProfile: true,
      changed: false,
    });
    await setPrivate(999999, true, 404);
    await postJson("/api/players/101/private", {}, 400);
    await postJson("/api/players/101/private", { private: "yes" }, 400);
    await postJson("/api/players/abc/private", { private: true }, 400);
  });

  it("reads both halves of the ranking page through an index, never a scan", async () => {
    // The whole point of the counts + materialized ranks is that no read scans
    // `players`. The tail must not undo that — and it holds every LAPSED player,
    // which in a mature store is most of them, so it needs its own index and its
    // own SQL paging just as much as the head does.
    await setPrivate(101, true);
    const stub = env.LOS.get(env.LOS.idFromName("singleton"));
    await runInDurableObject(stub, async (instance) => {
      const priv = instance as unknown as { sql: SqlStorage };
      const plan = (sql: string) =>
        [...priv.sql.exec(`EXPLAIN QUERY PLAN ${sql}`)].map((r) => String(r.detail)).join(" | ");

      const head = plan(
        `SELECT user_id FROM players WHERE ranked = 1 ORDER BY los DESC, user_id LIMIT 50 OFFSET 0`,
      );
      expect(head).toContain("idx_players_ranked");
      expect(head).not.toContain("SCAN players");
      expect(head).not.toContain("TEMP B-TREE"); // the index supplies the order

      const tail = plan(
        `SELECT user_id FROM players WHERE ranked = 0 ORDER BY last_played DESC, user_id LIMIT 50 OFFSET 0`,
      );
      expect(tail).toContain("idx_players_unranked");
      expect(tail).not.toContain("SCAN players");
      expect(tail).not.toContain("TEMP B-TREE");

      // The admin's list and the refreshRanks walk keep the original index.
      const all = plan(`SELECT user_id FROM players ORDER BY los DESC, user_id LIMIT 50 OFFSET 0`);
      expect(all).toContain("idx_players_ranking");
      expect(all).not.toContain("TEMP B-TREE");
    });
  });

  it("survives a rebase and a store written before the column existed", async () => {
    await setPrivate(101, true);
    // A rebase recounts from scratch; the flag and the private count must hold.
    const rebase = await postJson("/api/games/g1/rebase", {});
    expect(rebase.ok).toBe(true);
    const after = await getJson("/api/ranking?perPage=100");
    expect(after.players.at(-1)).toMatchObject({ userId: 101, rank: null, los: null });
    expect((await getJson("/api/players/101")).privateProfile).toBe(true);

    const stub = env.LOS.get(env.LOS.idFromName("singleton"));
    await runInDurableObject(stub, async (instance) => {
      const priv = instance as unknown as {
        sql: SqlStorage;
        ensureDerived(): void;
        count(key: string): number;
      };
      // The pre-migration store: no counts rows, no ranks (the column itself
      // cannot be dropped here, so the rebuild is what is under test).
      priv.sql.exec(`DELETE FROM counts`);
      priv.sql.exec(`UPDATE players SET rank = NULL`);
      priv.ensureDerived();
      expect(priv.count("players")).toBe(16);
      expect(priv.count("players_ranked")).toBe(15);
      const rows = [
        ...priv.sql.exec(`SELECT rank, public_rank FROM players ORDER BY los DESC, user_id`),
      ];
      // `rank` is the TRUE position, over everyone; `public_rank` skips the
      // hidden player, so it runs 1..15 with a NULL where they sit.
      expect(rows.map((r) => r.rank)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
      const publicRanks = rows.map((r) => r.public_rank);
      expect(publicRanks.filter((r) => r == null)).toHaveLength(1);
      expect(publicRanks.filter((r) => r != null)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    });
  });
});

describe("inactive players", () => {
  // Two games a month and a half back, so everyone in them has lapsed, and two
  // recent ones with a different cast who have not.
  const OLD = [101, 102, 103, 104, 105, 106, 107, 108];
  const OLD_B = [201, 202, 203, 204, 205, 206, 207, 208];
  const NEW = [301, 302, 303, 304, 305, 306, 307, 308];
  const NEW_B = [401, 402, 403, 404, 405, 406, 407, 408];

  beforeEach(async () => {
    await upload([
      lavaReplay({ ...staleDay(10, "old1"), teams: [OLD, OLD_B] }),
      lavaReplay({ ...day(2, 10, "new1"), teams: [NEW, NEW_B] }),
    ]);
  });

  it("keeps a lapsed player off the leaderboard, in the tail with no rank", async () => {
    const r = await getJson("/api/ranking?perPage=100");
    expect(r.total).toBe(32); // everyone is still LISTED
    expect(r.rankedTotal).toBe(16); // only the recent cast is ranked

    const ranked = r.players.slice(0, 16);
    const tail = r.players.slice(16);
    expect(ranked.map((p: any) => p.rank)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(ranked.every((p: any) => p.userId >= 301 && p.inactive === false)).toBe(true);
    expect(tail.every((p: any) => p.userId < 300 && p.rank === null && p.inactive === true)).toBe(true);

    // NOTHING else is hidden: the rank tier, the record and the profile are
    // public (and the rating is there for an admin, as for anyone).
    const lapsed = tail[0];
    expect(lapsed.tier).not.toBeNull();
    const lapsedAdmin = (await getJson("/api/ranking?perPage=100&includePrivate=true")).players.find(
      (p: any) => p.userId === lapsed.userId,
    );
    expect(lapsedAdmin.los).toBeGreaterThan(0);
    expect(lapsedAdmin.mu).toBeGreaterThan(0);
    expect(lapsed.games).toBe(1);
    expect(lapsed.privateProfile).toBe(false);
    const profile = await getJson(`/api/players/${lapsed.userId}`);
    expect(profile.privateProfile).toBe(false);
    expect(profile.inactive).toBe(true);
    expect(profile.inactiveDays).toBe(35);
    expect(profile.tier).toBe(lapsed.tier);
    expect(profile.rank).toBeNull();
    expect(profile.recentGames).toHaveLength(1);
    // …and their history and games are served in full.
    expect((await getJson(`/api/players/${lapsed.userId}/history?includePrivate=true`)).points).toHaveLength(1);
    const games = await getJson(`/api/players/${lapsed.userId}/games`);
    expect(games.privateProfile).toBe(false);
    expect(games.games[0].tier).not.toBeNull();
  });

  it("pages the tail in SQL, so a page of lapsed players is a page", async () => {
    const page1 = await getJson("/api/ranking?perPage=10&page=1");
    expect(page1.players.map((p: any) => p.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Page 2 straddles the join: the last 6 ranked, then the first 4 lapsed.
    const page2 = await getJson("/api/ranking?perPage=10&page=2");
    expect(page2.players.slice(0, 6).map((p: any) => p.rank)).toEqual([11, 12, 13, 14, 15, 16]);
    expect(page2.players.slice(6).every((p: any) => p.rank === null && p.inactive)).toBe(true);
    // Page 3 is all tail; page 4 is past the end.
    const page3 = await getJson("/api/ranking?perPage=10&page=3");
    expect(page3.players).toHaveLength(10);
    expect(page3.players.every((p: any) => p.rank === null)).toBe(true);
    expect((await getJson("/api/ranking?perPage=10&page=4")).players).toHaveLength(2);
    expect((await getJson("/api/ranking?perPage=10&page=5")).players).toEqual([]);
    // No page repeats a player, and together they are everyone.
    const seen = [page1, page2, page3, await getJson("/api/ranking?perPage=10&page=4")]
      .flatMap((p: any) => p.players.map((x: any) => x.userId));
    expect(new Set(seen).size).toBe(32);
  });

  it("ranks a lapsed player again as soon as they play, and re-ranks the rest", async () => {
    const before = await getJson("/api/ranking?perPage=100");
    expect(before.rankedTotal).toBe(16);

    // 101 turns up in a recent game; the other seven of their cast do not.
    await upload([
      lavaReplay({ ...day(3, 10, "new2"), teams: [[101, 302, 303, 304, 305, 306, 307, 308], NEW_B] }),
    ]);

    const after = await getJson("/api/ranking?perPage=100");
    expect(after.rankedTotal).toBe(17);
    const back = after.players.find((p: any) => p.userId === 101);
    expect(back.inactive).toBe(false);
    expect(back.rank).not.toBeNull();
    // The rest of their cast is still in the tail.
    expect(after.players.filter((p: any) => p.inactive)).toHaveLength(15);
    // Ranks stay 1..17 with no hole where the returning player slotted in.
    expect(after.players.slice(0, 17).map((p: any) => p.rank))
      .toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    const adminBack = (await getJson("/api/ranking?perPage=100&includePrivate=true")).players.find(
      (p: any) => p.userId === 101,
    );
    expect((await getJson("/api/players/101?includePrivate=true")).rank).toBe(adminBack.rank);
  });

  it("shows the admin the whole leaderboard, lapsed players in their real places", async () => {
    const admin = await getJson("/api/ranking?perPage=100&includePrivate=true");
    expect(admin.total).toBe(32);
    expect(admin.rankedTotal).toBe(16);
    expect(admin.players).toHaveLength(32);
    // One list in LOS order, everyone with their true rank — nobody parked.
    expect(admin.players.map((p: any) => p.rank)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
    expect(admin.players.some((p: any) => p.inactive)).toBe(true);
    const los = admin.players.map((p: any) => p.los);
    expect(los).toEqual([...los].sort((a: number, b: number) => b - a));
  });

  it("keeps the two reasons apart: private hides, inactive only unranks", async () => {
    await setPrivate(301, true); // ranked → private
    const r = await getJson("/api/ranking?perPage=100");
    const priv = r.players.find((p: any) => p.userId === 301);
    const lapsed = r.players.find((p: any) => p.userId === 101);
    expect(priv).toMatchObject({ rank: null, los: null, tier: null, privateProfile: true, inactive: false });
    expect(lapsed.rank).toBeNull();
    expect(lapsed.tier).not.toBeNull();
    expect(lapsed.inactive).toBe(true);
    expect(r.rankedTotal).toBe(15); // the private one left the leaderboard too
    // The private one is the most recently seen, so it heads the tail.
    expect(r.players[15].userId).toBe(301);
  });

  it("re-derives activity as time passes, without an upload", async () => {
    const stub = env.LOS.get(env.LOS.idFromName("singleton"));
    // Nothing has changed in the store, but the clock has: pretend the last
    // sweep was long ago and that the recent games are now themselves old.
    await runInDurableObject(stub, async (instance) => {
      const priv = instance as unknown as {
        sql: SqlStorage;
        setMeta(k: string, v: string): void;
        count(key: string): number;
      };
      priv.setMeta("activity_swept_at", "0");
      priv.sql.exec(`UPDATE players SET last_played = ? WHERE user_id >= 300`, staleDay(9, "x").startTime);
      expect(priv.count("players_ranked")).toBe(16); // still says so
    });
    // The next read notices.
    const r = await getJson("/api/ranking?perPage=100");
    expect(r.rankedTotal).toBe(0);
    expect(r.players.every((p: any) => p.rank === null && p.inactive)).toBe(true);
    expect(r.total).toBe(32);
  });
});

describe("reset", () => {
  it("wipes everything (with confirmation) so history can be re-uploaded", async () => {
    await upload([lavaReplay({ ...day(2, 10, "g1") })]);
    const noConfirm = await call(`${BASE}/api/reset`, { method: "POST" });
    expect(noConfirm.status).toBe(400);

    const res = await call(`${BASE}/api/reset?confirm=true`, { method: "POST" });
    expect(res.status).toBe(200);
    const ranking = await getJson("/api/ranking");
    expect(ranking.total).toBe(0);
    expect(ranking.lastSeq).toBe(0);

    // The fold head is gone too: the same game rates again from scratch.
    const again = await upload([lavaReplay({ ...day(2, 10, "g1") })]);
    expect(again.rated).toEqual(["g1"]);
    expect(again.lastSeq).toBe(1);
  });
});

describe("derived data: counts and materialized ranks", () => {
  it("keeps the totals and ranks in step with uploads, including ignored games", async () => {
    await upload([lavaReplay(day(2, 10, "g1")), lavaReplay({ ...day(2, 12, "g2"), winner: 1 })]);
    // A late game is stored as ignored: counted in `games`, not in the rated total.
    await upload([lavaReplay(day(1, 20, "late"))]);
    // A game with fresh players grows the player count.
    await upload([lavaReplay({ ...day(3, 10, "g3"), teams: [[301, 302, 303, 304, 305, 306, 307, 308], [201, 202, 203, 204, 205, 206, 207, 208]] })]);

    expect((await getJson("/api/games?limit=1")).total).toBe(4);
    expect((await getJson("/api/games?limit=1&rated=true")).total).toBe(3);
    const ranking = await getJson("/api/ranking?perPage=100");
    expect(ranking.total).toBe(24);
    expect(ranking.players).toHaveLength(24);

    // The player page's rank is the materialized column; it must equal the
    // leaderboard position for everyone, and rankedOf the maintained total.
    const adminRanking = await getJson("/api/ranking?perPage=100&includePrivate=true");
    for (const p of adminRanking.players) {
      const profile = await getJson(`/api/players/${p.userId}?includePrivate=true`);
      expect(profile.rank).toBe(p.rank);
      expect(profile.rankedOf).toBe(24);
    }
    // The search's global rank comes from the same column.
    const found = await getJson("/api/ranking?q=player3&includePrivate=true");
    expect(found.total).toBe(8);
    const rankOf = new Map(adminRanking.players.map((p: any) => [p.userId, p.rank]));
    for (const p of found.players) expect(p.rank).toBe(rankOf.get(p.userId));
  });

  it("migrates a store whose players table predates every column added since", async () => {
    // The failure this pins: ensureSchema used to create the ranking indexes in
    // the same breath as the table, so on a store written by an OLDER BUILD —
    // one whose players table has none of the columns those indexes name — the
    // constructor threw "no such column: ranked" and the DO could not even
    // serve the page that would have migrated it. Every other test starts from
    // reset(), which recreates the table WITH the columns, so none of them
    // could see it. Here the old shape is rebuilt on purpose.
    await upload([lavaReplay(day(2, 10, "g1")), lavaReplay(day(2, 12, "g2"))]);
    const stub = env.LOS.get(env.LOS.idFromName("singleton"));
    await runInDurableObject(stub, async (instance) => {
      const priv = instance as unknown as {
        sql: SqlStorage;
        ensureSchema(): void;
        count(key: string): number;
      };
      // Rebuild `players` as the first release shipped it: no rank, no
      // public_rank, no private_profile, no inactive, no ranked — and drop the
      // indexes over those columns with it.
      for (const idx of ["idx_players_ranking", "idx_players_ranked", "idx_players_unranked", "idx_players_name"]) {
        priv.sql.exec(`DROP INDEX IF EXISTS ${idx}`);
      }
      priv.sql.exec(`ALTER TABLE players RENAME TO players_old`);
      priv.sql.exec(`
        CREATE TABLE players (
          user_id      INTEGER PRIMARY KEY,
          name         TEXT NOT NULL,
          mu           REAL NOT NULL,
          sigma        REAL NOT NULL,
          los          REAL NOT NULL,
          games        INTEGER NOT NULL,
          wins         INTEGER NOT NULL,
          first_played TEXT NOT NULL,
          last_played  TEXT NOT NULL,
          bar_os       REAL
        )`);
      priv.sql.exec(`
        INSERT INTO players (user_id, name, mu, sigma, los, games, wins, first_played, last_played, bar_os)
        SELECT user_id, name, mu, sigma, los, games, wins, first_played, last_played, bar_os FROM players_old`);
      priv.sql.exec(`DROP TABLE players_old`);
      priv.sql.exec(`DELETE FROM counts`);
      expect([...priv.sql.exec(`SELECT 1 FROM pragma_table_info('players') WHERE name = 'ranked'`)])
        .toHaveLength(0);

      // What the constructor runs. It must not throw, and it must leave the
      // store fully migrated rather than half-way.
      expect(() => priv.ensureSchema()).not.toThrow();

      for (const col of ["rank", "public_rank", "private_profile", "inactive", "ranked"]) {
        expect([...priv.sql.exec(`SELECT 1 FROM pragma_table_info('players') WHERE name = ?`, col)])
          .toHaveLength(1);
      }
      for (const idx of ["idx_players_ranking", "idx_players_ranked", "idx_players_unranked", "idx_players_name"]) {
        expect([...priv.sql.exec(`SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?`, idx)])
          .toHaveLength(1);
      }
      // The added columns held their DEFAULT for every existing row, so their
      // contents had to be COMPUTED — a migration that only adds the column
      // leaves nobody ranked and the leaderboard empty.
      expect(priv.count("players")).toBe(16);
      expect(priv.count("players_ranked")).toBe(16);
    });

    // And the pages work on it.
    const r = await getJson("/api/ranking?perPage=100");
    expect(r.total).toBe(16);
    expect(r.rankedTotal).toBe(16);
    expect(r.players.map((p: any) => p.rank)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    const ra = await getJson("/api/ranking?perPage=100&includePrivate=true");
    expect((await getJson("/api/players/101?includePrivate=true")).rank).toBe(
      ra.players.find((p: any) => p.userId === 101).rank,
    );
  });

  it("rebuilds counts and ranks for a store written before they existed", async () => {
    await upload([lavaReplay(day(2, 10, "g1")), lavaReplay(day(2, 12, "g2"))]);
    const stub = env.LOS.get(env.LOS.idFromName("singleton"));
    await runInDurableObject(stub, async (instance) => {
      // Reach the private pieces the migration is made of.
      const priv = instance as unknown as {
        sql: SqlStorage;
        ensureDerived(): void;
        count(key: "players" | "games" | "games_rated"): number;
      };
      // Simulate the pre-migration store: no counts rows, no ranks.
      priv.sql.exec(`DELETE FROM counts`);
      priv.sql.exec(`UPDATE players SET rank = NULL`);
      priv.ensureDerived();
      expect(priv.count("players")).toBe(16);
      expect(priv.count("games")).toBe(2);
      expect(priv.count("games_rated")).toBe(2);
      const ranks = [...priv.sql.exec(`SELECT rank FROM players ORDER BY los DESC, user_id`)].map((r) => r.rank);
      expect(ranks).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    });
  });

  // The deployed store is an existing one, so migrateColumns is the path that
  // actually runs — the fresh-schema CREATE above never executes there. A
  // store that predates the column keeps every game it already had, with a
  // null chevron on those rows (nothing here can recover what the upload did
  // not carry), and records the chevron on everything uploaded after. It is
  // also the one migrated column ensureDerived must NOT rebuild, which is why
  // migrateColumns naming it in `added` has to stay harmless.
  it("adds the chevron column to a store written before it existed", async () => {
    await upload([lavaReplay({ ...day(2, 10, "g1"), ranks: { 101: 5 } })]);
    const stub = env.LOS.get(env.LOS.idFromName("singleton"));
    await runInDurableObject(stub, async (instance) => {
      const priv = instance as unknown as {
        sql: SqlStorage;
        migrateColumns(): ReadonlySet<string>;
      };
      priv.sql.exec(`ALTER TABLE game_players DROP COLUMN bar_rank`);
      expect([...priv.migrateColumns()]).toContain("bar_rank");
      const cols = [...priv.sql.exec(`SELECT name FROM pragma_table_info('game_players')`)].map((r) => r.name);
      expect(cols).toContain("bar_rank");
      const rows = [...priv.sql.exec(`SELECT bar_rank FROM game_players WHERE game_id = 'g1'`)];
      expect(rows).toHaveLength(16);
      expect(rows.every((r) => r.bar_rank === null)).toBe(true);
      // An up-to-date store migrates nothing, so a redeploy is a no-op.
      expect([...priv.migrateColumns()]).toEqual([]);
    });

    await upload([lavaReplay({ ...day(2, 12, "g2"), ranks: { 101: 5 } })]);
    const g2 = await getJson("/api/games/g2");
    expect(g2.teams[0].find((p: { userId: number }) => p.userId === 101).barRank).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// rank_history: what the board looked like on past days, and the two change
// columns measured against it (LosDO.recordDailySnapshot / rankBaseline /
// rebuildRankHistory).
// ---------------------------------------------------------------------------
describe("rank tiers", () => {
  it("keeps a player's stored tier until they fall past the demotion margin", async () => {
    await upload([lavaReplay(day(2, 10, "t1"))]);
    const stub: unknown = env.LOS.get(env.LOS.idFromName("singleton"));
    const tierOf101 = async () => (await getJson("/api/players/101")).tier;
    // An established player (no rookie handicap left) on Gold, then a rating
    // just under the Gold cutoff (LOS 15): still Gold. Under 14.5: Silver.
    const run = runInDurableObject as unknown as (s: unknown, fn: (i: any) => void) => Promise<void>;
    const write = (mu: number, sigma: number) =>
      run(stub, (i) => {
        i.upsertPlayer({
          userId: 101, name: "player101", mu, sigma, games: 200, wins: 100,
          firstPlayed: "2026-01-01T00:00:00.000Z", lastPlayed: new Date().toISOString(), barOs: null,
        });
      });
    await write(22, 5); // LOS 17 → Gold
    expect(await tierOf101()).toBe("gold");
    await write(20, 5); // LOS 15 → within the margin, stays Gold
    expect(await tierOf101()).toBe("gold");
    await write(19.4, 5); // LOS 14.4 → past it, down to Silver
    expect(await tierOf101()).toBe("silver");
    await write(21, 5); // LOS 16 → back up at the cutoff
    expect(await tierOf101()).toBe("gold");
  });
});

describe("game rosters for a visitor", () => {
  it("serves each team in LOS order, the numbers gone", async () => {
    await upload([lavaReplay(day(1, 10, "o1")), lavaReplay({ ...day(2, 10, "o2"), winner: 1 })]);
    const admin = await getJson("/api/games/o2?includePrivate=true");
    const visitor = await getJson("/api/games/o2");
    for (const [i, team] of admin.teams.entries()) {
      const los = team.map((p: any) => p.losBefore);
      expect([...los].sort((a: number, b: number) => b - a)).toEqual(los);
      expect(visitor.teams[i].map((p: any) => p.userId)).toEqual(team.map((p: any) => p.userId));
      expect(visitor.teams[i].every((p: any) => p.losBefore === null)).toBe(true);
    }
  });
});

describe("rank history", () => {
  /** The recorded days, oldest first, and how many rows each holds. */
  async function historyDays(): Promise<{ day: string; rows: number }[]> {
    const stub = env.LOS.get(env.LOS.idFromName("singleton"));
    return runInDurableObject(stub, async (instance) => {
      const priv = instance as unknown as { sql: SqlStorage };
      return [
        ...priv.sql.exec(
          `SELECT day, COUNT(*) AS rows FROM rank_history GROUP BY day ORDER BY day`,
        ),
      ].map((r) => ({ day: String(r.day), rows: Number(r.rows) }));
    });
  }

  const utcDay = (offset: number) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
  const byId = (rows: any[]) => new Map<number, any>(rows.map((p) => [p.userId, p]));

  it("records ONE snapshot per UTC day, stamped with the day that ended", async () => {
    await upload([lavaReplay(day(1, 10, "h1"))]);
    // The upload ran refreshRanks, which stamped the state it derived with
    // YESTERDAY — the day that had ended by the time it ran.
    expect(await historyDays()).toEqual([{ day: utcDay(-1), rows: 16 }]);

    // A second upload the same day adds no second snapshot: the day is already
    // recorded, and a snapshot per game would make "the state a day ended with"
    // mean nothing.
    await upload([lavaReplay(day(2, 10, "h2"))]);
    expect(await historyDays()).toEqual([{ day: utcDay(-1), rows: 16 }]);
  });

  it("reports no change while nothing is old enough to compare against", async () => {
    await upload([lavaReplay(day(1, 10, "h1"))]);
    // The only snapshot is yesterday's; the baseline wants one from a week back,
    // so every row says "nothing to compare with" rather than "no movement".
    const ranking = await getJson("/api/ranking");
    expect(ranking.changeDays).toBe(7);
    for (const p of ranking.players) {
      expect([p.rankChange7d, p.losChange7d]).toEqual([null, null]);
    }
  });

  it("rebuilds the last 8 days from the game log and derives the changes from them", async () => {
    // Two wins for team 0 up to and including the baseline day (t−7), then two
    // for team 1 after it. The baseline snapshot therefore has team 0 on top and
    // the present has team 1 climbing back — the movement the columns must show.
    await upload([
      lavaReplay(day(1, 10, "h1")), // t−9, team 0 wins
      lavaReplay(day(3, 10, "h2")), // t−7, team 0 wins — the baseline day itself
      lavaReplay({ ...day(8, 10, "h3"), winner: 1 }), // t−2
      lavaReplay({ ...day(9, 10, "h4"), winner: 1 }), // t−1
    ]);

    const rebuilt = await postJson("/api/rank-history/rebuild", {});
    expect(rebuilt.days).toEqual(Array.from({ length: 8 }, (_, i) => utcDay(-8 + i)));
    expect(rebuilt.rows).toBe(8 * 16);
    expect(rebuilt.players).toBe(16);
    // Only the games after the OLDEST rebuilt day ended are rewound; h1 (t−9)
    // is already folded into every snapshot and is never touched.
    expect(rebuilt.games).toBe(3);
    expect(await historyDays()).toEqual(
      Array.from({ length: 8 }, (_, i) => ({ day: utcDay(-8 + i), rows: 16 })),
    );

    const players = byId((await getJson("/api/ranking?perPage=100&includePrivate=true")).players);
    for (const userId of [101, 108]) {
      expect(players.get(userId).losChange7d).toBeLessThan(0);
      expect(players.get(userId).rankChange7d).toBeLessThanOrEqual(0);
    }
    for (const userId of [201, 208]) {
      expect(players.get(userId).losChange7d).toBeGreaterThan(0);
      expect(players.get(userId).rankChange7d).toBeGreaterThanOrEqual(0);
    }
    // Nobody joined or left between the two snapshots, so the positions are a
    // permutation of themselves: every place one player gained, another lost.
    const moved = [...players.values()].map((p) => p.rankChange7d);
    expect(moved.reduce((a, b) => a + b, 0)).toBe(0);
    expect(moved.some((m) => m !== 0)).toBe(true);

    // Re-running changes nothing: the rewind reads the same log to the same
    // answer, and the rows are written by (day, user_id).
    const again = await postJson("/api/rank-history/rebuild", {});
    expect([again.days, again.rows, again.games]).toEqual([rebuilt.days, rebuilt.rows, rebuilt.games]);
    const after = byId((await getJson("/api/ranking?perPage=100&includePrivate=true")).players);
    for (const [userId, p] of players) expect(after.get(userId).losChange7d).toBe(p.losChange7d);
  });

  it("leaves a player who had not played by the baseline with no change at all", async () => {
    await upload([lavaReplay(day(1, 10, "h1"))]);
    // A second cast of sixteen, debuting after the baseline day.
    await upload([
      lavaReplay({ ...day(9, 10, "h2"), teams: [[301, 302, 303, 304, 305, 306, 307, 308],
                                                 [401, 402, 403, 404, 405, 406, 407, 408]] }),
    ]);
    await postJson("/api/rank-history/rebuild", {});

    const players = byId((await getJson("/api/ranking?perPage=100&includePrivate=true")).players);
    // Undoing somebody's FIRST rated game undoes their existence, so they are on
    // no snapshot older than it and there is nothing to be a change in.
    for (const userId of [301, 401]) {
      expect([players.get(userId).rankChange7d, players.get(userId).losChange7d]).toEqual([null, null]);
    }
    // The players who WERE there keep a baseline — the newcomers pushed some of
    // them down the board, which is a real movement.
    expect(players.get(101).rankChange7d).not.toBe(null);
  });

  it("keeps the movement on a private row, which is a change and not a position", async () => {
    await upload([
      lavaReplay(day(1, 10, "h1")),
      lavaReplay({ ...day(9, 10, "h2"), winner: 1 }),
    ]);
    await postJson("/api/rank-history/rebuild", {});
    await setPrivate(201, true);

    const hidden = byId((await getJson("/api/ranking?perPage=100")).players).get(201);
    // The rating and the position go (see redactRatedPlayer). What MOVED is
    // LOS too, so a visitor no longer gets it for anyone.
    expect([hidden.rank, hidden.los, hidden.tier]).toEqual([null, null, null]);
    expect(hidden.rankChange7d).not.toBeUndefined();
    expect(hidden.losChange7d).toBeNull();
  });

  it("drops the history with a reset and prunes it with the retention", async () => {
    await upload([lavaReplay(day(1, 10, "h1"))]);
    await postJson("/api/rank-history/rebuild", {});
    expect((await historyDays()).length).toBe(8);

    const stub = env.LOS.get(env.LOS.idFromName("singleton"));
    await runInDurableObject(stub, async (instance) => {
      const priv = instance as unknown as {
        sql: SqlStorage;
        recordDailySnapshot(now: number, board: { userId: number; rank: number; los: number }[]): void;
      };
      // A day older than the 60-day retention, and the meta watermark wound back
      // so the next recording is due.
      priv.sql.exec(`INSERT INTO rank_history (day, user_id, rank, los) VALUES ('2020-01-01', 101, 1, 20)`);
      priv.sql.exec(`UPDATE meta SET value = '2020-01-02' WHERE key = 'rank_history_day'`);
      priv.recordDailySnapshot(Date.now(), [{ userId: 101, rank: 1, los: 20 }]);
    });
    // The recording is what prunes: it is the only thing that adds to the table,
    // and it runs exactly once per day — the retention's own step.
    expect((await historyDays()).some((d) => d.day === "2020-01-01")).toBe(false);

    await call(`${BASE}/api/reset?confirm=true`, { method: "POST" });
    expect(await historyDays()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ordering the ranking by any of its sortable columns, either way round
// (parseRankingSort / rankingOrderBy / rankingComparator).
// ---------------------------------------------------------------------------
describe("ranking sort", () => {
  const ids = (r: any) => r.players.map((p: any) => p.userId);
  const admin = (query: string) => getJson(`/api/ranking?perPage=100&includePrivate=true&${query}`);

  /** Two wins for team 0, then two for team 1, with a baseline in between and
   * eight debutants after it — so the board holds risers, fallers and players
   * with no change at all. */
  async function seedMovement() {
    await upload([
      lavaReplay(day(1, 10, "s1")), // t−9, team 0
      lavaReplay(day(3, 10, "s2")), // t−7, team 0 — the baseline day
      lavaReplay({ ...day(8, 10, "s3"), winner: 1 }), // t−2
      lavaReplay({ ...day(9, 10, "s4"), winner: 1 }), // t−1
    ]);
    await upload([
      lavaReplay({ ...day(9, 12, "s5"),
        teams: [[301, 302, 303, 304, 305, 306, 307, 308], [401, 402, 403, 404, 405, 406, 407, 408]] }),
    ]);
    await postJson("/api/rank-history/rebuild", {});
  }

  it("serves a visitor the tier board only: tier, then games, numbered 1..N, no rank movement", async () => {
    await seedMovement();
    // Whatever a visitor asks for, the order is the tier board's.
    for (const q of ["", "sort=los&dir=desc", "sort=rank&dir=asc", "sort=rankChange&dir=desc"]) {
      const r = await getJson(`/api/ranking?perPage=100&${q}`);
      expect(r.sort, q).toBe("tier");
    }
    const r = await getJson("/api/ranking?perPage=100");
    const order = ["placing", "bronze", "silver", "gold", "platinum", "diamond"];
    const head = r.players.slice(0, r.rankedTotal);
    for (let i = 1; i < head.length; i++) {
      const [a, b] = [head[i - 1], head[i]];
      const ta = order.indexOf(a.tier), tb = order.indexOf(b.tier);
      expect(ta >= tb).toBe(true);
      if (ta === tb) expect(a.games >= b.games).toBe(true);
    }
    expect(head.map((p: any) => p.rank)).toEqual(head.map((_: any, i: number) => i + 1));
    expect(r.players.every((p: any) => p.rankChange7d === null && p.los === null)).toBe(true);
    // Reversed, it is the same board upside down.
    const asc = await getJson("/api/ranking?perPage=100&dir=asc");
    expect(ids({ players: asc.players.slice(0, asc.rankedTotal) }))
      .toEqual([...ids({ players: head })].reverse());
    // The admin can sort by tier too, and keeps the leaderboard by default.
    const a = await admin("sort=tier&dir=desc");
    expect([a.sort, a.dir]).toEqual(["tier", "desc"]);
    expect(a.players.some((p: any) => p.rankChange7d != null)).toBe(true);
  });

  it("defaults to the leaderboard it has always served, and says so", async () => {
    await upload([lavaReplay(day(1, 10, "s1"))]);
    const def = await admin("");
    expect([def.sort, def.dir]).toEqual(["rank", "asc"]);
    // Best first, which is what every reader of this API already gets.
    const los = def.players.map((p: any) => p.los);
    expect([...los].sort((a, b) => b - a)).toEqual(los);
    // An unrecognized key or direction falls back rather than 400ing: a stale
    // or hand-written URL should still answer with a list.
    const junk = await admin("sort=nonsense&dir=sideways");
    expect([junk.sort, junk.dir]).toEqual(["rank", "asc"]);
    expect(ids(junk)).toEqual(ids(def));
  });

  it("reads # ascending and LOS descending as the same list, and reverses both", async () => {
    await upload([lavaReplay(day(1, 10, "s1"))]);
    // rank is materialized FROM los, so these are one ordering under two names.
    expect(ids(await admin("sort=rank&dir=asc"))).toEqual(ids(await admin("sort=los&dir=desc")));
    expect(ids(await admin("sort=rank&dir=desc"))).toEqual(ids(await admin("sort=los&dir=asc")));
    // And the two directions really are opposites.
    expect(ids(await admin("sort=los&dir=asc"))).toEqual([...ids(await admin("sort=los&dir=desc"))].reverse());
  });

  it("sorts by either movement, both ways, with the players who have none last", async () => {
    await seedMovement();
    for (const [key, field] of [["losChange", "losChange7d"], ["rankChange", "rankChange7d"]] as const) {
      const desc = (await admin(`sort=${key}&dir=desc`)).players;
      const asc = (await admin(`sort=${key}&dir=asc`)).players;
      const values = (rows: any[]) => rows.map((p) => p[field]).filter((v) => v != null);
      expect(values(desc)).toEqual([...values(desc)].sort((a, b) => b - a));
      expect(values(asc)).toEqual([...values(asc)].sort((a, b) => a - b));
      // "No baseline" is not a small change and not a large one — it belongs at
      // the END whichever way the column is read, which is the whole reason
      // each of these columns carries an index per direction.
      for (const rows of [desc, asc]) {
        const firstNull = rows.findIndex((p: any) => p[field] == null);
        expect(firstNull, key).toBeGreaterThan(0);
        expect(rows.slice(firstNull).every((p: any) => p[field] == null), key).toBe(true);
      }
      // The debutants are exactly those rows: they were on no snapshot old
      // enough to have moved from.
      expect(desc.filter((p: any) => p[field] == null).map((p: any) => p.userId).sort())
        .toEqual([301, 302, 303, 304, 305, 306, 307, 308, 401, 402, 403, 404, 405, 406, 407, 408]);
    }
  });

  it("keeps # the player's standing, not their place in the sorted page", async () => {
    await seedMovement();
    const byLos = await admin("sort=los&dir=desc");
    const standing = new Map(byLos.players.map((p: any) => [p.userId, p.rank]));
    const moved = await admin("sort=losChange&dir=desc");
    // Same rule the search has always followed: the row says where the player
    // stands, so a page sorted by what moved is not silently renumbered.
    for (const p of moved.players) expect(p.rank).toBe(standing.get(p.userId));
    expect(ids(moved)).not.toEqual(ids(byLos));
  });

  it("sorts the public list's head only, leaving the rankless tail alone", async () => {
    await upload([lavaReplay(day(1, 10, "s1")), lavaReplay(staleDay(10, "s2"))]);
    await setPrivate(101, true);
    const sorted = await getJson("/api/ranking?perPage=100&dir=asc");
    const ranked = sorted.players.filter((p: any) => p.rank != null);
    const tail = sorted.players.filter((p: any) => p.rank == null);
    // The head obeys the sort...
    const los = ranked.map((p: any) => p.los);
    expect([...los].sort((a, b) => a - b)).toEqual(los);
    // ...and is still the whole head, ahead of every rankless row.
    expect(sorted.players.slice(0, ranked.length)).toEqual(ranked);
    // The tail's order is not a display preference: it stays most-recently-seen
    // first, because ordering these by a rating would read as a ranking and,
    // for the private row whose rating is blanked, hand back the standing the
    // blanking removes.
    const seen = tail.map((p: any) => p.lastPlayed);
    expect([...seen].sort().reverse()).toEqual(seen);
    expect(tail.some((p: any) => p.userId === 101 && p.los === null)).toBe(true);
  });

  it("orders a search by the same rule, over the matches", async () => {
    await seedMovement();
    const asc = await admin("q=player&sort=los&dir=asc");
    const desc = await admin("q=player&sort=los&dir=desc");
    expect(asc.total).toBeGreaterThan(1);
    expect(ids(asc)).toEqual([...ids(desc)].reverse());
    const moved = await admin("q=player&sort=losChange&dir=desc");
    const vals = moved.players.map((p: any) => p.losChange7d).filter((v: any) => v != null);
    expect(vals).toEqual([...vals].sort((a: number, b: number) => b - a));
  });
});
