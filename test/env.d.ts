// Ambient types for the worker-pool tests.

// Pull in the base `cloudflare:test` module types (SELF, env, runInDurableObject, …)
// shipped by the pool, then augment its `ProvidedEnv` with our generated `Env`
// (.cloudflare/types, from cloudflare.config.ts) so `env.DISPATCHER` and the bindings are typed.
/// <reference types="@cloudflare/vitest-plugin/types" />
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Vite's `?raw` import suffix returns a file's contents as a string at build time —
// used to load the example command-log fixture into the test without node:fs.
declare module "*?raw" {
  const content: string;
  export default content;
}
