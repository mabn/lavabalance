// `.bot` — the bot's self-introduction, assembled fresh on every ask.
//
// Extracted from bot.ts for the usual reason (bot.ts opens a socket at import,
// so nothing can import it) and for one of its own: this is the only thing the
// bot says that is WRITING rather than data, and the thing worth testing about
// writing is that every combination it can produce still reads as a sentence.
//
// The line is built from three lists of ten — who I am, what I do, where your
// number is — plus the ranking link, one pick from each. 1000 combinations, so a
// lobby that asks twice gets two different answers, which is the whole point: a
// bot repeating one canned string is furniture, and nobody reads furniture the
// second time. The parts are independent by design — every prefix must work in
// front of every middle — which is what keeps the lists cheap to extend: adding
// one line to any of them adds a hundred answers, with nothing to re-check
// beyond that line's own grammar.
//
// The grammar contract, and all there is to obey when adding one:
//   • a PREFIX is a whole sentence ending in its own punctuation, and says the
//     speaker is a bot (some of them grandly — that is the joke);
//   • a MIDDLE is a whole sentence ending in its own punctuation, and says the
//     bot balances the games;
//   • a SUFFIX ends by pointing AT the link — a colon, or a preposition — since
//     RANKING_URL is appended after a single space.
// Joined by spaces they are ONE line, because this is said out loud in a shared
// battle chat (`.help`, the dozen-line command list, stays a whisper).

/** The leaderboard — what somebody asking "what is this bot" wants next. */
export const RANKING_URL = "https://lavabalance.fogofwar.dev/ranking";

/** Who is speaking. A whole sentence; must read in front of every middle. */
export const BLURB_PREFIXES = [
  "beep boop — I am a robot.",
  "Affirmative: bot.",
  "I am the almighty balance robot.",
  "Yes, I am a bot — the all-knowing kind.",
  "*whirring noises* — bot here.",
  "Your friendly neighbourhood balance robot, reporting in.",
  "I am a humble bot with a very large spreadsheet.",
  "01100010 01101111 01110100 — that spells bot.",
  "I am not a person, I am a rating-powered appliance.",
  "Bot. Definitely a bot. Not a person hiding in a lobby.",
];

/** What it does to your lobby. A whole sentence; must follow every prefix. */
export const BLURB_MIDDLES = [
  "I weigh everyone's rating and split the teams down the middle.",
  "I do the maths so nobody has to argue about the teams.",
  "I sort you into two piles of roughly equal danger.",
  "I shuffle players until both sides look equally doomed.",
  "I balance this lobby, one number at a time.",
  "My entire personality is making the two teams fair.",
  "I read the ratings and draw the fairest line I can find.",
  "I turn sixteen egos into two even teams.",
  "I balance the games here; you may blame me afterwards.",
  "I exist to make both sides as boringly equal as possible.",
];

/** Points at the link. Ends in a colon or a preposition — the URL follows it. */
export const BLURB_SUFFIXES = [
  "Your rank:",
  "See where you stand:",
  "Check your own number at",
  "The ladder lives at",
  "Leaderboard:",
  "Find yourself here:",
  "Your rating is public, sorry:",
  "Standings:",
  "Curious how you rate? Look here:",
  "Rankings, freshly computed:",
];

/** One uniformly-picked element. `rand` returns [0,1), like Math.random. */
const pick = <T>(list: readonly T[], rand: () => number): T =>
  list[Math.min(list.length - 1, Math.floor(rand() * list.length))]!;

/**
 * One `.bot` answer: a prefix, a middle, a suffix and the link, space-joined.
 * `rand` is injectable so a test can pin a combination — nothing else passes it.
 */
export function botBlurb(rand: () => number = Math.random): string {
  return [
    pick(BLURB_PREFIXES, rand),
    pick(BLURB_MIDDLES, rand),
    pick(BLURB_SUFFIXES, rand),
    RANKING_URL,
  ].join(" ");
}
