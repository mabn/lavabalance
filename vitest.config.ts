import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig, defineProject } from "vitest/config";

// Two projects in one run:
//   • "unit"    — the pure parser/state tests, in the default Node pool (fast, no runtime).
//   • "workers" — tests that exercise the Durable Objects themselves (Dispatcher,
//                 RatingsDO, TeiserverDO, LosDO — one Worker since the lavaos merge),
//                 inside the real workerd runtime via @cloudflare/vitest-plugin
//                 (its `cloudflareTest` vite plugin loads cloudflare.config.ts so
//                 the bindings, vars and Durable Object exports match production). These are named
//                 `*.workers.test.ts`; everything else runs as a plain Node unit test.
export default defineConfig({
  test: {
    projects: [
      defineProject({
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.workers.test.ts"],
        },
      }),
      defineProject({
        plugins: [
          cloudflareTest({
            config: "./cloudflare.config.ts",
            // The tests pin their OWN vars rather than inheriting production's:
            // the fixtures/scenarios are captured as account huk123 (the bot
            // account in production is a config choice that must not break
            // them), and the src-mode tests exercise every source, including
            // the proxy (Dispatcher) view that production may disable.
            miniflare: {
              bindings: {
                BOT_USERNAME: "huk123",
                SRC_MODES: "teiserver,proxy,rtsapi",
              },
            },
          }),
        ],
        test: {
          name: "workers",
          include: ["test/**/*.workers.test.ts"],
        },
      }),
    ],
  },
});
