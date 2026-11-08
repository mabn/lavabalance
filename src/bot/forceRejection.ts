// Recognizing SPADS's refusals of our `!fb`.
//
// A rejected force moves NOBODY, but the bot has already whispered the command
// and announced the matchup for teams the lobby never got — so a refusal that
// goes unrecognized leaves the bot claiming an arrangement that does not exist
// (2026-09-07: after a player ran `!balance`, the host answered "Cannot force
// id/team, teams have been balanced and autoBlockBalance is enabled" twice, the
// bot announced its 50/50 line both times, and the lobby played SPADS's teams —
// "garbage balance", said the lobby, at the bot).
//
// The refusal only ever reaches us as a PRIVATE message from the host, and
// spads.pl's hForce has more than one reason for it. Both known reasons share
// the same opening, so that is what identifies a refusal; the reason names which
// setting blocked it, and — crucially — how long the block lasts.

/** The opening of every hForce refusal (spads.pl). */
const FORCE_REJECTED_PREFIX = "cannot force id/team";

export type ForceRejectionKind =
  /**
   * `autoBalance` is not "off": SPADS balances the lobby itself and refuses every
   * manual force until a boss turns it off. Indefinite — worth latching.
   */
  | "autoBalance"
  /**
   * `autoBlockBalance` with teams SPADS has already balanced (someone ran
   * `!balance`): manual forces are refused until that balance is invalidated,
   * which the next roster change does. TRANSIENT — latching on it would wedge the
   * bot for a lobby that unblocks itself seconds later.
   */
  | "balanceLock"
  /** A refusal we don't recognize. Treated as transient: never latch on a guess. */
  | "other";

export interface ForceRejection {
  kind: ForceRejectionKind;
  /** Short human reason, for the chat correction and the status log. */
  reason: string;
}

/**
 * Classify a private message from the host as a refusal of our `!fb`, or null
 * when it isn't one. Callers must still check the sender is the battle's founder.
 */
export function classifyForceRejection(text: string): ForceRejection | null {
  const t = text.toLowerCase();
  if (!t.includes(FORCE_REJECTED_PREFIX)) return null;
  // autoBlockBalance FIRST: it is the more specific setting name.
  if (t.includes("autoblockbalance")) {
    return {
      kind: "balanceLock",
      reason: "the host has autoBlockBalance on and its own !balance holds the teams",
    };
  }
  if (t.includes("autobalance")) {
    return { kind: "autoBalance", reason: "the host's autoBalance is enabled" };
  }
  return { kind: "other", reason: text.trim() };
}
