import { defineWranglerConfig } from "wrangler/experimental-config";

declare const process: { env: Record<string, string | undefined> };

// Build and dev-server settings for the Wrangler bundler that `cf dev` /
// `cf build` / `cf deploy` drive. The Worker itself (bindings, Durable
// Objects, the bot container, routes, cron) is configured in
// cloudflare.config.ts.
export default defineWranglerConfig({
  // Static assets (rank icons, poll pictures). Files under ./public are served
  // at the matching path (e.g. public/ranks/1.png → /ranks/1.png) by the
  // runtime BEFORE the Worker runs; requests that don't match a file fall
  // through to the Worker.
  assetsDirectory: "./public",
  dev: {
    // The dev server would otherwise hand the Worker request URLs on the
    // custom domain's host (its "upstream" emulation), so the browser's Origin
    // (localhost) would never match and every login POST would be refused as
    // cross-site. Dev only; deploys ignore it.
    host: "localhost:8787",
    // `cf dev` builds and runs the bot container locally, which needs Docker.
    // Without Docker: `DEV_CONTAINERS=false pnpm run dev` serves the Worker
    // and its Durable Objects with no bot (the /bot/* routes then fail).
    enableContainers: process.env.DEV_CONTAINERS !== "false",
  },
});
