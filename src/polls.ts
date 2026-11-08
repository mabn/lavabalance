// Polls: questions to the Lava community, answered on this site (GET /polls).
//
// Voting needs the website login (src/auth.ts), which is the point of running
// polls here rather than on a third-party tool: one BAR account, one vote. A
// voter may change their vote at any time; the poll keeps only the latest.
//
// The polls THEMSELVES (question, options, pictures) live in this file, as
// code: the page is hand-written per poll. The LosDO keeps what has to be
// stored — one `polls` row per poll (id + slug) and one `poll_results` row per
// voter — so the definitions here may grow without a migration.
//
// Pure TypeScript, no `cloudflare:*` / `node:*` — shared by the Worker routes
// and unit-testable in the Node pool.

/** One answer a voter can pick (single choice). */
export interface PollOption {
  /** Stored in poll_results.choice. Never rename one a poll has votes for. */
  key: string;
  /** What the voter clicks. */
  label: string;
  /** A short line under the label. */
  hint?: string;
  /** The column heading above this option's picture ("Hidden"). */
  heading?: string;
  /** A picture of what this option means (a path under public/). */
  image?: string;
  imageAlt?: string;
  /** One line under the picture. */
  caption?: string;
  /** Accent colour of this option's column, bar and badge. */
  color: string;
}

export interface PollDef {
  slug: string;
  /** The question, as a title. */
  title: string;
  /** The question's text: trusted HTML, written here by hand. */
  questionHtml: string;
  options: PollOption[];
  /** Link-preview image (Discord, etc.), 1200×630, a path under public/. */
  ogImage?: string;
  /** When the poll was opened (ISO date), shown on the page. */
  openedAt: string;
  /** Votes are refused from this moment on (ISO). Absent = open. */
  closesAt?: string;
}

/**
 * Every poll, newest first. /polls shows the first one; /polls/<slug> any of
 * them. Keep slugs stable: the stored votes are keyed on the slug's id.
 */
export const POLLS: readonly PollDef[] = [
  {
    slug: "do-you-want-los-hidden",
    title: "Do you want LOS to be hidden?",
    questionHtml:
      "<p>Should we hide LOS values and change the ranking page to stop showing player rank?</p>",
    openedAt: "2026-11-01",
    ogImage: "/polls/do-you-want-los-hidden-og.png",
    options: [
      {
        key: "hidden",
        label: "Make Lava OS a hidden MMR",
        hint: "Rank emblems only. LOS still balances the teams behind the scenes.",
        heading: "Hidden",
        image: "/polls/los-hidden.png",
        imageAlt: "A team roster showing only each player's rank emblem and games played",
        caption: "Only the rank emblem. No LOS numbers, no ranking positions.",
        color: "#a78bfa",
      },
      {
        key: "visible",
        label: "Keep Lava OS shown",
        hint: "LOS numbers, their change after every game, and ranking positions stay.",
        heading: "Visible",
        image: "/polls/los-visible.png",
        imageAlt: "A team roster showing each player's LOS before the game, the change, and the team average",
        caption: "The LOS number, how it moved after the game, and the team average.",
        color: "#f59e0b",
      },
    ],
  },
];

export function findPoll(slug: string): PollDef | null {
  return POLLS.find((p) => p.slug === slug) ?? null;
}

/** Whether a poll still takes votes at `now`. */
export function pollOpen(poll: PollDef, now = Date.now()): boolean {
  return !poll.closesAt || now < Date.parse(poll.closesAt);
}

/** The option key from a vote body `{choice}`, or null when it is not one of the poll's. */
export function parseVote(poll: PollDef, body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const choice = (body as { choice?: unknown }).choice;
  if (typeof choice !== "string") return null;
  return poll.options.some((o) => o.key === choice) ? choice : null;
}

/** The question as plain text (link previews): tags dropped, entities left as written. */
export function pollPlainText(poll: PollDef): string {
  return poll.questionHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

const escAttr = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The <head> tags link previews read (Open Graph + Twitter card, which is what
 * Discord, Slack and the rest unfurl from): "🗳️ Poll: <title>", the question,
 * the preview image and the lava accent colour. `origin` makes the URLs absolute.
 */
export function pollMetaTags(poll: PollDef, origin: string): string {
  const url = `${origin}/polls/${poll.slug}`;
  const title = `\u{1F5F3}\uFE0F Poll: ${poll.title}`;
  const desc = `${pollPlainText(poll)} Options: ${poll.options.map((o) => o.label).join(" / ")}. Vote with your BAR account.`;
  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="lavabalance" />`,
    `<meta property="og:title" content="${escAttr(title)}" />`,
    `<meta property="og:description" content="${escAttr(desc)}" />`,
    `<meta property="og:url" content="${escAttr(url)}" />`,
    `<meta name="description" content="${escAttr(desc)}" />`,
    `<meta name="theme-color" content="#ff7a2f" />`,
    `<link rel="canonical" href="${escAttr(url)}" />`,
  ];
  if (poll.ogImage) {
    const img = `${origin}${poll.ogImage}`;
    tags.push(
      `<meta property="og:image" content="${escAttr(img)}" />`,
      `<meta property="og:image:width" content="1200" />`,
      `<meta property="og:image:height" content="630" />`,
      `<meta property="og:image:alt" content="${escAttr(poll.title)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:image" content="${escAttr(img)}" />`,
    );
  }
  return tags.join("\n") + `\n<title>${escAttr(`${poll.title} · lavabalance poll`)}</title>`;
}
