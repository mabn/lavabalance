// The poll routes, /api/polls/* (polls are described in src/polls.ts).
// Mounted into the main Hono app by src/index.ts; the pages (/polls,
// /polls/:slug) are registered there with the other pages.
//
//   GET  /api/polls                 → {polls: [{slug, title, openedAt, closesAt, open, options, results, myVote}], user}
//   GET  /api/polls/:slug           → the poll, its results, the caller's vote
//   POST /api/polls/:slug/vote      {choice} → the same, after voting
//
// Voting needs the website login (the session cookie, src/auth.ts): 401 with
// `login: "/login"` otherwise, which is what sends the page to the login. The
// reads are public but per-user (they carry "your vote"), so never cached. An
// admin (src/access.ts) also gets the list of voters.

import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { adminRequest } from "./access";
import { sameOrigin } from "./auth";
import { currentUser } from "./authRoutes";
import { losStub } from "./los";
import { POLLS, findPoll, parseVote, pollOpen, type PollDef } from "./polls";
import type { AuthUser } from "./auth";

type C = Context<{ Bindings: Env }>;

const NO_STORE = { "Cache-Control": "no-store" };

export const pollApp = new Hono<{ Bindings: Env }>();

function fail(c: C, message: string, status: ContentfulStatusCode, extra: Record<string, unknown> = {}) {
  return c.json({ error: message, ...extra }, status, NO_STORE);
}

/** What a page needs to draw a poll: the definition, the results, who is asking. */
async function pollBody(c: C, poll: PollDef, user: AuthUser | null) {
  const admin = (await adminRequest(c.env, c.req.raw)) !== null;
  const state = await losStub(c.env).pollState(poll.slug, { userId: user?.userId ?? null, includeVoters: admin });
  return {
    poll: { ...poll, open: pollOpen(poll) },
    results: { total: state.total, counts: state.counts, byTier: state.byTier },
    myVote: state.myVote,
    user,
    ...(state.voters ? { voters: state.voters } : {}),
  };
}

// The list page's data: every poll with its overall tally and the caller's
// own pick. There are only a handful of polls and each tally is cached in the
// LosDO, so this is one cheap pollState call per poll.
pollApp.get("/api/polls", async (c) => {
  const user = await currentUser(c);
  const los = losStub(c.env);
  const polls = await Promise.all(
    POLLS.map(async (p) => {
      const s = await los.pollState(p.slug, { userId: user?.userId ?? null });
      return {
        slug: p.slug,
        title: p.title,
        openedAt: p.openedAt,
        closesAt: p.closesAt ?? null,
        open: pollOpen(p),
        options: p.options.map((o) => ({ key: o.key, label: o.label, heading: o.heading ?? null, color: o.color })),
        results: { total: s.total, counts: s.counts },
        myVote: s.myVote?.choice ?? null,
      };
    }),
  );
  return c.json({ polls, user }, 200, NO_STORE);
});

pollApp.get("/api/polls/:slug", async (c) => {
  const poll = findPoll(c.req.param("slug"));
  if (!poll) return fail(c, "no such poll", 404);
  return c.json(await pollBody(c, poll, await currentUser(c)), 200, NO_STORE);
});

pollApp.post("/api/polls/:slug/vote", async (c) => {
  if (!sameOrigin(c.req.header("origin"), c.req.url)) return fail(c, "cross-site request refused", 403);
  const poll = findPoll(c.req.param("slug"));
  if (!poll) return fail(c, "no such poll", 404);
  const user = await currentUser(c);
  if (!user) return fail(c, "log in to vote", 401, { login: "/login" });
  if (!pollOpen(poll)) return fail(c, "this poll is closed", 409);
  const choice = parseVote(poll, await c.req.json().catch(() => null));
  if (!choice) return fail(c, `choice must be one of: ${poll.options.map((o) => o.key).join(", ")}`, 400);
  const { previous } = await losStub(c.env).castVote(poll.slug, user, choice);
  return c.json({ ...(await pollBody(c, poll, user)), previous }, 200, NO_STORE);
});
