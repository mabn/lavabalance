// `.bot`'s answer is assembled from three lists, so what is worth testing is not
// one string but the whole space: every combination the bot can say out loud in a
// lobby must still read as a sentence, and must still end at the link.

import { describe, expect, it } from "vitest";
import {
  BLURB_MIDDLES,
  BLURB_PREFIXES,
  BLURB_SUFFIXES,
  botBlurb,
  RANKING_URL,
} from "../src/bot/blurb";

/** A rand() handing back the given values in order, then repeating the last. */
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
};

/** Every prefix × middle × suffix the command can produce. */
const everyBlurb = (): string[] => {
  const out: string[] = [];
  for (let p = 0; p < BLURB_PREFIXES.length; p++)
    for (let m = 0; m < BLURB_MIDDLES.length; m++)
      for (let s = 0; s < BLURB_SUFFIXES.length; s++)
        out.push(botBlurb(seq(p / BLURB_PREFIXES.length, m / BLURB_MIDDLES.length, s / BLURB_SUFFIXES.length)));
  return out;
};

describe("botBlurb", () => {
  it("joins one pick from each list with the ranking link", () => {
    expect(botBlurb(seq(0, 0, 0))).toBe(
      `${BLURB_PREFIXES[0]} ${BLURB_MIDDLES[0]} ${BLURB_SUFFIXES[0]} ${RANKING_URL}`,
    );
    expect(botBlurb(seq(0.99, 0.99, 0.99))).toBe(
      `${BLURB_PREFIXES.at(-1)} ${BLURB_MIDDLES.at(-1)} ${BLURB_SUFFIXES.at(-1)} ${RANKING_URL}`,
    );
  });

  // A rand() that returns exactly 1 is out of contract, but Math.random's range
  // is a promise about a float — an index off the end would be `undefined` in the
  // middle of a chat line, so the pick clamps instead.
  it("stays inside the lists at the very top of rand's range", () => {
    expect(botBlurb(() => 1)).toBe(
      `${BLURB_PREFIXES.at(-1)} ${BLURB_MIDDLES.at(-1)} ${BLURB_SUFFIXES.at(-1)} ${RANKING_URL}`,
    );
  });

  it("picks each part independently, so the lists multiply", () => {
    const all = everyBlurb();
    expect(all).toHaveLength(
      BLURB_PREFIXES.length * BLURB_MIDDLES.length * BLURB_SUFFIXES.length,
    );
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps every combination one chat line ending at the link", () => {
    for (const line of everyBlurb()) {
      expect(line.endsWith(` ${RANKING_URL}`)).toBe(true);
      expect(line).not.toMatch(/[\r\n\t]/);
      expect(line).not.toMatch(/ {2}/);
      // Said out loud in a shared chat: one line, not a paragraph.
      expect(line.length).toBeLessThanOrEqual(220);
    }
  });

  // The grammar contract in blurb.ts, checked on the parts rather than on the
  // 1000 sentences: a prefix and a middle each end their own sentence, and a
  // suffix hands over to the URL that follows it.
  it("holds the grammar contract on each list", () => {
    for (const list of [BLURB_PREFIXES, BLURB_MIDDLES]) {
      expect(list).toHaveLength(10);
      for (const part of list) {
        expect(part.trim()).toBe(part);
        expect(part).toMatch(/[.!?]$/);
      }
    }
    expect(BLURB_SUFFIXES).toHaveLength(10);
    for (const part of BLURB_SUFFIXES) {
      expect(part.trim()).toBe(part);
      expect(part).toMatch(/(:| at| here)$/);
    }
  });

  // Only the prefix carries a checkable claim: the command is asked because
  // somebody wants to know WHAT this thing is, so every answer has to say it is a
  // bot however grandly it puts it. The middles say the same thing in ten
  // different metaphors ("two piles of roughly equal danger"), which no keyword
  // test can judge without becoming a test of the writing's taste.
  it("says it is a bot however it opens", () => {
    for (const part of BLURB_PREFIXES) expect(part.toLowerCase()).toMatch(/bot|robot|appliance/);
  });

  it("spreads over the lists under a real random source", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) seen.add(botBlurb());
    expect(seen.size).toBeGreaterThan(200);
  });
});
