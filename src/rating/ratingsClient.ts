// Client-side accessor for the singleton RatingsDO. Kept apart from `ratingsDO.ts` (which
// imports `cloudflare:workers` and therefore can't be loaded by the Node unit-test pool) so
// that callers tested in the unit pool — e.g. `rtsapi.ts` — can resolve the stub without
// pulling in the Durable Object class. Mirrors the teiserver.ts / teiserverDO.ts split.

/** The single RatingsDO instance name; every binding routes here. */
export const RATINGS_SINGLETON = "singleton";

/** The one RatingsDO instance; all rating lookups converge on it. */
export function ratingsStub(env: Env) {
  return env.RATINGS.get(env.RATINGS.idFromName(RATINGS_SINGLETON));
}
