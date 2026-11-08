// The `[payoff]` record: did the bot's teams play, and how close was the game?
// The reference cases are real 2026-09-07 games (19:53 and 20:22 started on the
// bot's teams and both went to the nominal underdog; the rest ran on SPADS' teams
// with 5-9 point average-LOS gaps).

import { describe, expect, it } from "vitest";
import { captureGameStart, describePayoff, type GameStart } from "../src/bot/payoff";
import type { WatchedPlayer } from "../src/bot/compWatcher";

const roster = (onZero: number, size = 16): WatchedPlayer[] =>
  Array.from({ length: size }, (_, i) => ({ name: `p${i}`, ally: i < onZero ? 0 : 1 }));

const EVEN_SPLIT = {
  first: Array.from({ length: 8 }, (_, i) => `p${i}`),
  second: Array.from({ length: 8 }, (_, i) => `p${i + 8}`),
};

describe("captureGameStart", () => {
  it("records the launch as bot-balanced when the forced teams are the ones playing", () => {
    const start = captureGameStart(76, roster(8), EVEN_SPLIT, 49.8);
    expect(start.botBalanced).toBe(true);
    expect(start.players).toHaveLength(16);
    expect(start.predictedFirstWin).toBe(49.8);
  });

  it("records NOT bot-balanced when the lobby launched on different teams", () => {
    // A 9v7 with the strong side stacked: what actually started on 2026-09-07
    // once SPADS threw the bot's !fb away.
    expect(captureGameStart(76, roster(9), EVEN_SPLIT, 49.8).botBalanced).toBe(false);
  });

  it("keeps 'never forced' apart from 'forced something else'", () => {
    expect(captureGameStart(76, roster(8), null, null).botBalanced).toBeNull();
  });

  it("copies the roster so a later lobby change cannot rewrite the record", () => {
    const live = roster(8);
    const start = captureGameStart(76, live, null, null);
    live[0].ally = 1;
    live.pop();
    expect(start.players).toHaveLength(16);
    expect(start.players[0].ally).toBe(0);
  });
});

describe("describePayoff", () => {
  const bal = (over: Partial<GameStart> = {}): GameStart => ({
    battleId: 76,
    players: roster(8),
    predictedFirstWin: 49.8,
    botBalanced: true,
    ...over,
  });

  it("scores the prediction against the side that actually won", () => {
    const line = describePayoff(bal(), { winnerAlly: 1 });
    expect(line).toContain("botTeams=yes");
    expect(line).toContain("players=16 (8v8)");
    expect(line).toContain("winner=team 2");
    expect(line).toContain("predictedTeam1=49.8%");
    expect(line).toContain("predictionForWinner=50.2%");
    expect(line).toContain("(favourite won)");
  });

  it("names the underdog when the model had the loser ahead", () => {
    const line = describePayoff(bal({ predictedFirstWin: 88 }), { winnerAlly: 1 });
    expect(line).toContain("predictionForWinner=12.0%");
    expect(line).toContain("(underdog won)");
  });

  it("reports a game that did not run on the bot's teams", () => {
    const line = describePayoff(bal({ botBalanced: false, players: roster(9) }), {
      winnerAlly: 0,
    });
    expect(line).toContain("botTeams=no");
    expect(line).toContain("players=16 (9v7)");
  });

  it("says so when the bot never forced anything in this lobby", () => {
    expect(describePayoff(bal({ botBalanced: null }), { winnerAlly: 0 })).toContain(
      "botTeams=never-forced",
    );
  });

  it("records an undecided game without inventing a score", () => {
    const line = describePayoff(bal(), { winnerAlly: null });
    expect(line).toContain("result=undecided");
    expect(line).not.toContain("predictionForWinner");
  });

  it("records the result with no prediction to score it against", () => {
    const line = describePayoff(bal({ predictedFirstWin: null }), { winnerAlly: 1 });
    expect(line).toContain("winner=team 2");
    expect(line).toContain("predicted=none");
    expect(line).not.toContain("predictionForWinner");
  });

  it("counts teams from the lowest ally present, like every other bot line", () => {
    const odd: WatchedPlayer[] = [
      { name: "a", ally: 3 },
      { name: "b", ally: 7 },
    ];
    expect(describePayoff(bal({ players: odd }), { winnerAlly: 3 })).toContain("winner=team 1");
    expect(describePayoff(bal({ players: odd }), { winnerAlly: 7 })).toContain("winner=team 2");
  });

  it("does not score a winner that was not on the launch roster", () => {
    const line = describePayoff(bal(), { winnerAlly: 4 });
    expect(line).toContain("predictionForWinner=unknown");
    expect(line).not.toContain("favourite");
  });
});
