// User — global, per-account state that is NOT specific to any one battle.
//
// CLIENTSTATUS (rank, in-game, away) is a server-wide broadcast about a user, and
// the per-player skill (OS) from SETSCRIPTTAGS is likewise a fact about the account,
// not the room they happen to be in. Both belong on the user, not on a battle's
// Player roster entry. The `UserRepository` is the single home for them; the control
// plane (/api/lobbies) augments each battle's roster with these details by name.
//
// Everything here is transport-agnostic and does no I/O: the Dispatcher feeds it the
// values it decodes from the proxied protocol stream.

import type { ClientStatusEvent } from "./protocol/events";

/** Global, room-independent details for one account. */
export interface User {
  /** Best-known display name (real case, as the server last sent it in CLIENTSTATUS). */
  name: string;
  /** Account rank as a 1-8 display level (CLIENTSTATUS), or null if never seen. */
  rank: number | null;
  /** Skill (OS) from SETSCRIPTTAGS game/players/<name>/skill, or null if never seen. */
  skill: number | null;
  /** True while the user is in a running game (CLIENTSTATUS bit 0). */
  inGame: boolean;
  /** True while the user is marked away (CLIENTSTATUS bit 1). */
  away: boolean;
}

function blankUser(name: string): User {
  return { name, rank: null, skill: null, inGame: false, away: false };
}

/**
 * Directory of all users seen on the server, keyed by **lowercased** name. The
 * lowercase key reconciles real-case roster/CLIENTSTATUS names with the lowercase
 * keys the server uses in SETSCRIPTTAGS, so skill and CLIENTSTATUS facts about the
 * same account land on one entry. Held by the Dispatcher; survives in memory only.
 */
export class UserRepository {
  private users = new Map<string, User>();

  /** Look up a user by name (case-insensitive); undefined if never seen. */
  get(name: string): User | undefined {
    return this.users.get(name.toLowerCase());
  }

  /** Number of distinct users seen. */
  get size(): number {
    return this.users.size;
  }

  private ensure(name: string): User {
    const key = name.toLowerCase();
    let u = this.users.get(key);
    if (!u) {
      u = blankUser(name);
      this.users.set(key, u);
    }
    return u;
  }

  /**
   * Apply a CLIENTSTATUS broadcast: rank, in-game and away are all global per-user
   * facts. The event carries the real-case name, so refresh the stored display name.
   */
  noteClientStatus(e: ClientStatusEvent): void {
    const u = this.ensure(e.userName);
    u.name = e.userName;
    u.rank = e.rank;
    u.inGame = e.inGame;
    u.away = e.away;
  }

  /**
   * Set a user's skill (OS) from SETSCRIPTTAGS. The server lowercases the tag key, so
   * `name` is already lowercase here — used for keying only, not as a display name.
   */
  noteSkill(name: string, skill: number): void {
    this.ensure(name).skill = skill;
  }
}
