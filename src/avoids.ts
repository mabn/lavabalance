// Avoid lists — "don't put me on the same team as X".
//
// A player configures their own list by whispering the bot (.avoid [player] /
// .avoidremove <player>, see src/bot/bot.ts); the list is stored in the LosDO's
// `avoids` table (the SQLite DO that survives), read back by the balancer
// (src/balance/balancer.ts) and, for admins only, shown on the lobby page.
//
// An entry is DIRECTIONAL as a request ("A asked to avoid B") but SYMMETRIC as
// a constraint: the balancer only knows same-team / not-same-team, so one
// person's request keeps the pair apart whichever of them asked. It is about
// TEAMS, not about the game — nobody is kept out of a lobby.
//
// Names are matched case-insensitively (lobby names are unique up to case) and
// stored twice: a lowercased key that everything joins on, and the display
// spelling the ranking uses, which is what the bot and the page show.
//
// Pure TypeScript, no `cloudflare:*` / `node:*` — the wire shape shared by the
// Worker routes, the DO storage and the container bot, unit-testable in the
// Node pool.

/** How many people one player may have on their avoid list. */
export const MAX_AVOIDS_PER_PLAYER = 10;

/** Longest accepted lobby name — Teiserver's own account-name limit, with room. */
export const MAX_AVOID_NAME_LEN = 64;

/** One stored avoid request. */
export interface AvoidEntry {
  /** The requester, as they were spelled when the entry was made. */
  owner: string;
  /** The avoided player, spelled as the ranking spells them. */
  avoid: string;
  /** The ranking row the name resolved to (null only for a pre-validation row). */
  avoidUserId: number | null;
  /** ISO timestamp of when the entry was made. */
  createdAt: string;
}

/** A pair the balancer must keep on opposite teams; both names LOWERCASED. */
export interface AvoidPair {
  a: string;
  b: string;
}

/** Adding an entry: everything that can come back, in the shape the bot words. */
export type AddAvoidResult =
  | { ok: true; entry: AvoidEntry; count: number }
  /** The asker named themselves. */
  | { ok: false; reason: "self" }
  /** Already on the list (the stored entry comes back so the bot can say so). */
  | { ok: false; reason: "duplicate"; entry: AvoidEntry }
  /** MAX_AVOIDS_PER_PLAYER reached; nothing was stored. */
  | { ok: false; reason: "limit"; limit: number; count: number }
  /** No such player in the ranking; `suggestions` are near misses, if any. */
  | { ok: false; reason: "unknown-player"; suggestions: string[] };

export interface RemoveAvoidResult {
  ok: true;
  /** False when the name was not on the list — the caller says "not on it". */
  removed: boolean;
  /** The entry's display spelling when one was removed, else the name as asked. */
  name: string;
  count: number;
}

/** The trimmed display spelling of a name as typed. */
export function avoidName(raw: string): string {
  return raw.trim();
}

/** The key everything joins on: trimmed and lowercased. */
export function avoidKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Whether a string can be a lobby account name at all (cheap shape check). */
export function validAvoidName(raw: string): boolean {
  const name = avoidName(raw);
  return name.length > 0 && name.length <= MAX_AVOID_NAME_LEN && !/\s/.test(name);
}

function fail(what: string): never {
  throw new Error(`invalid avoid payload: ${what}`);
}

/** Parse `{player, avoid}` (the add/remove body) — throws with a usable message. */
export function parseAvoidRequest(body: unknown): { player: string; avoid: string } {
  if (typeof body !== "object" || body === null) fail("body must be an object");
  const { player, avoid } = body as { player?: unknown; avoid?: unknown };
  if (typeof player !== "string" || !validAvoidName(player)) {
    fail("player must be a lobby account name");
  }
  if (typeof avoid !== "string" || !validAvoidName(avoid)) {
    fail("avoid must be a lobby account name");
  }
  return { player: avoidName(player), avoid: avoidName(avoid) };
}

/**
 * The pairs a roster's avoid entries impose on THIS lobby: an entry only
 * constrains the split when both people are in it, so entries naming someone
 * who is not here are dropped. Symmetric, so A→B and B→A collapse into one
 * pair, keyed lowercased and ordered (a < b) so the list is deterministic.
 */
export function avoidPairsOf(entries: readonly AvoidEntry[], names: readonly string[]): AvoidPair[] {
  const present = new Set(names.map(avoidKey).filter((n) => n.length > 0));
  const seen = new Set<string>();
  const pairs: AvoidPair[] = [];
  for (const e of entries) {
    const owner = avoidKey(e.owner);
    const avoid = avoidKey(e.avoid);
    if (owner === avoid) continue;
    if (!present.has(owner) || !present.has(avoid)) continue;
    const [a, b] = owner < avoid ? [owner, avoid] : [avoid, owner];
    const key = `${a}\u0000${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ a, b });
  }
  return pairs;
}
