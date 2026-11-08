// Did the balancing actually help? The bot has never recorded that, so the only
// answer available for 2026-09-07 was inferred by hand from the logs: of ten
// decided games, exactly two started on the teams the bot forced (the two in a
// lobby with autoBalance off) — the rest ran on SPADS' teams with average-LOS
// gaps of 5 to 9 points. That is the whole sample, and it took a log dig to get.
//
// So the bot now writes the record itself: at game start it captures the teams
// that actually launched, whether they are the arrangement it last forced, and
// what it predicted; at the result it emits ONE greppable `[payoff]` line. Over a
// few hundred games those lines answer two separate questions that are easy to
// confuse — how often the bot's teams are the ones that play (delivery), and how
// close the games are when they do (calibration).
//
// Pure formatting and bookkeeping only: no protocol, no lookups, so it is
// testable. bot.ts owns the triggers.

import { teamsLanded, type WantedTeams, type WatchedPlayer } from "./compWatcher";

/** What the lobby looked like the moment the game launched. */
export interface GameStart {
  battleId: number;
  /** Non-spectator players and their ally teams at launch. */
  players: WatchedPlayer[];
  /**
   * Team-1 win chance (%) the bot last announced, or null when it never got to
   * report one for this lobby (it was never a boss, never asked, ...).
   */
  predictedFirstWin: number | null;
  /**
   * True when the launched teams are the arrangement the bot last forced. False
   * when it forced something else (or the force never landed), null when it never
   * forced anything in this lobby — three different things, kept apart.
   */
  botBalanced: boolean | null;
}

/**
 * Snapshot the launch. `wanted` is the arrangement of the bot's last live force
 * (null = it never forced one here); `predictedFirstWin` the win chance it last
 * announced. Team 1 is the lowest ally number present — the same convention as
 * `matchupLine`, so the percentage and the teams line up.
 */
export function captureGameStart(
  battleId: number,
  players: WatchedPlayer[],
  wanted: WantedTeams | null,
  predictedFirstWin: number | null,
): GameStart {
  return {
    battleId,
    players: players.map((p) => ({ name: p.name, ally: p.ally })),
    predictedFirstWin,
    botBalanced: wanted === null ? null : teamsLanded(wanted, players),
  };
}

/** The host's verdict. `winnerAlly` null = the game was undecided. */
export interface GameResult {
  winnerAlly: number | null;
}

/**
 * The one-line record. Reports the probability the model gave the side that
 * actually won — the number a calibration check needs (over many games its mean
 * should track how often the favourite wins) — rather than a bare right/wrong,
 * which throws away everything a probabilistic prediction says.
 */
export function describePayoff(start: GameStart, result: GameResult): string {
  const allies = [...new Set(start.players.map((p) => p.ally))].sort((a, b) => a - b);
  const sizes = allies.map((a) => start.players.filter((p) => p.ally === a).length).join("v");
  const delivery =
    start.botBalanced === null
      ? "botTeams=never-forced"
      : `botTeams=${start.botBalanced ? "yes" : "no"}`;
  const parts = [
    `[payoff] battle ${start.battleId}: ${delivery}`,
    `players=${start.players.length} (${sizes || "-"})`,
  ];
  if (result.winnerAlly === null) {
    parts.push("result=undecided");
    if (start.predictedFirstWin !== null) {
      parts.push(`predictedTeam1=${start.predictedFirstWin.toFixed(1)}%`);
    }
    return parts.join(" ");
  }
  // Ally numbers are 0-based on the wire; the lobby UI (and every line the bot
  // says) counts teams from 1, and "team 1" is the lowest ally present.
  const winnerIndex = allies.indexOf(result.winnerAlly);
  parts.push(`winner=team ${winnerIndex + 1}`);
  if (start.predictedFirstWin === null) {
    parts.push("predicted=none");
    return parts.join(" ");
  }
  parts.push(`predictedTeam1=${start.predictedFirstWin.toFixed(1)}%`);
  if (winnerIndex < 0) {
    // The winning ally was not on the launch roster we captured — nothing to
    // score the prediction against, so say so rather than inventing a number.
    parts.push("predictionForWinner=unknown");
    return parts.join(" ");
  }
  const forWinner = winnerIndex === 0 ? start.predictedFirstWin : 100 - start.predictedFirstWin;
  parts.push(`predictionForWinner=${forWinner.toFixed(1)}%`);
  parts.push(forWinner >= 50 ? "(favourite won)" : "(underdog won)");
  return parts.join(" ");
}
