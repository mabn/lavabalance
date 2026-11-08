// The lobby's SPADS `balanceMode`, and the one thing it changes for OUR balancer.
//
// The host broadcasts the setting unsolicited in BarManager
// `BattleStateChanged.balanceMode` (kept by `Battle.balanceModeSetting`, lowercased).
// The values a BAR lobby uses:
//
//   "clan;skill" — keep parties ("clans") together, then balance on skill
//   "clan"       — parties only
//   "skill"      — skill only; parties are NOT kept together
//   "random"     — a random split
//
// Our balancer is LOS-native and ALWAYS balances on skill (the OpenSkill
// predictWin objective — see balancer.ts); the mode cannot change that. What it
// does decide is whether PARTIES constrain the split: a mode naming "clan" keeps
// party members on the same team (what the balancer has always done), any other
// mode balances every player individually, as if there were no parties at all.
//
// "random" is deliberately handled as "skill": the bot exists to make the match
// fair, and it will not roll dice for the teams. A lobby that really wants a
// random split turns the bot's balancing off (its own autoBalance), which is
// already what arms/disarms us.
//
// An UNSEEN mode (null — the host has not broadcast yet, same freshness caveat as
// the boss list) keeps parties: that is the pre-existing behaviour, and BAR's own
// default is "clan;skill".

/** The party rule a `balanceMode` implies, and how to say it in a UI. */
export interface BalanceModeInfo {
  /** The raw setting, lowercased/trimmed; null when the host has not broadcast it. */
  mode: string | null;
  /** True when party members must land on the same team. */
  parties: boolean;
  /** Short human phrase for the party rule ("parties kept together" / "parties ignored"). */
  partyNote: string;
  /** One-line label for the bot UI, the lobby page and `.info`. */
  label: string;
}

/** Lowercase/trim a raw `balanceMode`; null (not "") when there is nothing to say. */
export function normalizeBalanceMode(raw: string | null | undefined): string | null {
  const mode = (raw ?? "").trim().toLowerCase();
  return mode.length > 0 ? mode : null;
}

/**
 * Does this mode keep parties together? True for every mode naming "clan"
 * (SPADS separates the components with ";"), and for an unseen mode.
 */
export function honoursParties(raw: string | null | undefined): boolean {
  const mode = normalizeBalanceMode(raw);
  if (mode === null) return true; // not broadcast yet — assume BAR's "clan;skill" default
  return mode.split(";").some((part) => part.trim() === "clan");
}

/** The mode's party rule plus display strings. Safe on a null/unseen mode. */
export function balanceModeInfo(raw: string | null | undefined): BalanceModeInfo {
  const mode = normalizeBalanceMode(raw);
  const parties = honoursParties(mode);
  const partyNote = parties ? "parties kept together" : "parties ignored";
  const shown =
    mode === null
      ? "unknown (assuming clan;skill)"
      : mode === "random"
        ? "random (balanced on skill)"
        : mode;
  return { mode, parties, partyNote, label: `${shown} — ${partyNote}` };
}
