// Calling the Worker AS A SUPERADMIN from the workers tests. The pooled env has
// no admin credential, so SELF.fetch is a visitor; this runs the same Worker
// with ADMIN_OPEN=true (src/access.ts), the dev opt-in that makes every
// request an admin. The Access JWT check itself is tested in access.test.ts.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";

export async function adminFetch(url: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, init), { ...env, ADMIN_OPEN: "true" }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** The admin-only LOS routes and reads: the row actions and ?includePrivate. */
const ADMIN_PATH = /includePrivate=true|\/rebase$|\/ignored$|\/private$|\/rank-history\/rebuild$|\/api\/sqlstats$/;

/** As an admin for an admin route (ADMIN_PATH), as a visitor for the rest. */
export function fetchAs(fetchVisitor: (url: string, init?: RequestInit) => Promise<Response>) {
  return (url: string, init?: RequestInit) =>
    ADMIN_PATH.test(new URL(url).pathname + new URL(url).search) ? adminFetch(url, init) : fetchVisitor(url, init);
}
