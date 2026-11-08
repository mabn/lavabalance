import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";

import * as entrypoint from "./src/index" with { type: "cf-worker" };

// This file is loaded by Node (the cf CLI) but typechecked with the Worker's
// tsconfig, which deliberately has no @types/node.
declare const process: { env: Record<string, string | undefined> };

// The project's Cloudflare configuration, read by the `cf` CLI (`cf dev`,
// `cf deploy`, `cf workers types`) and by the Vitest plugin's workers project.
// Build-only settings (static assets directory, dev host) live next to it in
// wrangler.config.ts, because cf still bundles this Worker with Wrangler.

// The bot itself: src/bot/bot.ts running in a Cloudflare Container (./Dockerfile),
// supervised by the BotContainer Durable Object (src/botContainer.ts). One
// instance: one bot account = one lobby session. `lite` (1/16 vCPU, 256 MiB) is
// plenty for an idle-most-of-the-time chat bot. Requires the Workers Paid plan
// and a running Docker daemon at `cf deploy` time (it builds + pushes).
const bot = defineContainer({
  // The application name the deployed container has always had
  // (`<worker>-<class, lowercased>` under wrangler.jsonc), so `cf deploy`
  // updates the existing application instead of creating a second one.
  name: "lavabalance-botcontainer",
  // Built from ./Dockerfile on every `cf build` / `cf deploy`, which therefore
  // needs Docker even with `--containers-rollout none`. Where there is no Docker
  // (a cloud sandbox), set BOT_IMAGE to the image already deployed (the
  // container application's current image, `pnpm exec cf containers
  // applications list`) to skip the build; with `--containers-rollout none`
  // the running application is left untouched either way.
  image: process.env.BOT_IMAGE
    ? { reference: process.env.BOT_IMAGE }
    : { dockerfile: "./Dockerfile" },
  maxInstances: 1,
  instanceType: "lite",
  // `pnpm exec cf containers ssh <instance id>` opens a shell in the VM around
  // the running instance — Cloudflare runs the SSH server, the image needs no
  // sshd. Access is authenticated ONLY against the keys listed here (ssh-ed25519
  // is the one supported type); with no matching key the tunnel is refused.
  // Keys reach an instance at start, so after adding one: deploy, then restart
  // the bot (POST /bot/stop + /bot/start).
  // See https://developers.cloudflare.com/containers/guides/ssh/
  ssh: { enabled: true },
  authorizedKeys: [
    {
      name: "admin",
      publicKey:
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAN+Qg7rSqTdnXFRNEOnSK3VnGtbgFSnsEgWcQ+PBy8P admin",
    },
  ],
});

// The Worker's identity: its name, code and the Durable Object classes it
// exports. Kept apart from the rest of the Worker so the DO bindings below can
// reference it (`bindings.durableObject({ worker: lavabalance, … })`), which is
// what types each `env.<DO>` with its class; a bare worker name would type them
// all as an untyped DurableObjectNamespace.
const lavabalance = {
  name: "lavabalance",
  entrypoint,
  compatibilityDate: "2026-06-27",
  // The Durable Object classes this Worker exports. This declaration REPLACES
  // the ordered `migrations` list wrangler.jsonc carried (v1..v8): Cloudflare
  // reconciles it against the namespaces already provisioned, so it lists
  // exactly the five classes that are live today, all created through
  // `new_sqlite_classes`. The applied deletions (LavabalanceBot in v3, LavaBot
  // in v8) are deliberately NOT repeated as tombstones. A class lifecycle
  // change must ship with `cf deploy` (not a version upload) and cannot be
  // rolled back to a version from before it.
  exports: {
    // The bot supervisor; the container above is attached to it.
    BotContainer: exports.durableObject({ storage: "sqlite", container: bot }),
    Dispatcher: exports.durableObject({ storage: "sqlite" }),
    TeiserverDO: exports.durableObject({ storage: "sqlite" }),
    RatingsDO: exports.durableObject({ storage: "sqlite" }),
    LosDO: exports.durableObject({ storage: "sqlite" }),
  },
};

export default defineConfig({
  accountId: "9a1829e6502587e153ffa45b76de7ed3",
  containers: [bot],
  worker: {
    ...lavabalance,
    // nodejs_compat is not required: the Worker uses only web APIs (and the bot
    // process lives in the container, not in the Worker).

    // The LOS public API (formerly the separate "lavaos" Worker) is served by
    // THIS Worker since the merge; the lavabalance.fogofwar.dev custom domain
    // routes here. A custom domain makes the deploy create the DNS record +
    // certificate on the zone.
    domains: ["lavabalance.fogofwar.dev"],
    // Keep the workers.dev URL: the bot UI / control plane has always been
    // served there.
    workersDev: true,

    // Every few minutes the Worker's `scheduled` handler asks the BotContainer
    // to `ensureRunning()`: Cloudflare does not guarantee a container instance
    // keeps running (host restarts, image rollouts), so this restarts the bot
    // after such an event — but only while the persisted intent says it should
    // be running.
    triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],


    // Non-secret config and the Durable Object bindings. The lobby server is
    // hard-coded in src/config.ts (server4.beyondallreason.info:8200,
    // plaintext). Secrets are NOT committed; set them with
    // `pnpm exec wrangler secret put <NAME> --name lavabalance` (cf cannot set
    // a single secret yet):
    //   BOT_PASSWORD        the bot account's PLAINTEXT password — the
    //                       container's bot hashes it itself (md5→base64) for
    //                       the lobby LOGIN and uses it as-is for the Teiserver
    //                       web login
    //   BOT_PASSWORD_HASH   base64(md5(password)) — kept for tools/connect-test
    //   CONTROL_TOKEN       optional bearer token for /battles/*, /admin/*, /bot/*
    //   ACCESS_BOT_CLIENT_ID / ACCESS_BOT_CLIENT_SECRET
    //                       the Access service token the bot sends on /api/bot/*
    //   TEISERVER_EMAIL     the Teiserver web-login account's email, used by the
    //                       Worker's scraper and handed to the bot container
    //   TEISERVER_PASSWORD  plaintext password for the Worker's own
    //                       src=teiserver web login (TeiserverDO)
    env: {
      // SUPERADMIN LOGIN (Cloudflare Access, src/access.ts): admin mode and the
      // admin routes verify the CF_Authorization JWT against these two. Neither
      // is secret: the Zero Trust team domain, and the Audience (AUD) tag of the
      // Access application protecting lavabalance.fogofwar.dev/admin/login.
      // Either empty = nobody is an admin through Access (fail-closed).
      // ADMIN_OPEN=true (every request an admin) belongs in .dev.vars ONLY.
      ACCESS_TEAM_DOMAIN: bindings.text<string>("bartools.cloudflareaccess.com"),
      ACCESS_AUD: bindings.text<string>("f3481bed8be26cc109332a6b65f295a6cd64e8119e9364fc424c901ebc9ef28d"),
      // The AUD of the SECOND Access application, fronting /api/bot/* (the
      // bot's .login/.logout calls, src/access.ts botIdentity). Empty = .login
      // is off. Its service token is the ACCESS_BOT_CLIENT_ID /
      // ACCESS_BOT_CLIENT_SECRET secrets, handed to the container.
      ACCESS_BOT_AUD: bindings.text<string>("cd6bf83925162b0f20a5b70fb80fe0ab62c8a0bff580e94d7b20435b31857935"),
      // The AUD of the THIRD Access application, fronting onetricklava's
      // scouting push (POST /api/scout/profiles). Empty = admin-only pushes.
      ACCESS_SCOUT_AUD: bindings.text<string>("9bd2367f79befff39c5117cc5ace805f206c83ca81563ab13ef4b04ba9c19d47"),
      // The bot account (lobby LOGIN name). Also the container's BOT_LOGIN.
      BOT_USERNAME: bindings.text<string>("lavabalance"),
      // This becomes the user's `lobby_client` name that Teiserver broadcasts
      // in ADDUSER. Keep it as a plain, identifiable client name.
      // Equivalent of "User-Agent" header.
      BOT_LOBBY_NAME: bindings.text<string>("lavabalance"),
      // Accounts allowed to whisper admin commands (.join …) to the bot,
      // comma-separated, case-insensitive. Empty = admin commands disabled.
      BOT_ADMINS: bindings.text<string>("huk123,Songi,Lucifer_,GODOFWAR09,djarshi"),
      // Battle id the bot joins after every login (optional; empty = none).
      BOT_AUTOJOIN_ROOM: bindings.text<string>(""),
      // Enabled `src` modes for GET /api/lobbies[/:id], comma-separated (see
      // src/config.ts enabledSrcModes). The FIRST entry is the default used
      // when `?src=` is omitted (currently `teiserver`); any known mode not
      // listed here is disabled and its requests get a 400. Known modes:
      // teiserver, proxy, rtsapi.
      SRC_MODES: bindings.text<string>("teiserver"),
      // Player-rating cache (the RatingsDO, src/rating/ratingsDO.ts), in
      // milliseconds. The cache is persistent (SQLite) and always served; a
      // cached entry last fetched more than this long ago is refreshed in the
      // background on the next lookup.
      RATING_CACHE_REFRESH_MS: bindings.json<number>(900000),

      // The bot supervisor (see the container above).
      BOT_CONTAINER: bindings.durableObject({ worker: lavabalance, exportName: "BotContainer" as const }),
      // Single Dispatcher instance: persisted runtime config (lava_lobbies)
      // and the src=proxy tracker view, fed only by its ingest() RPC.
      DISPATCHER: bindings.durableObject({ worker: lavabalance, exportName: "Dispatcher" as const }),
      // Single TeiserverDO instance: holds a logged-in Teiserver web session
      // and scrapes the lobby pages on demand for GET /api/lobbies?src=teiserver.
      TEISERVER: bindings.durableObject({ worker: lavabalance, exportName: "TeiserverDO" as const }),
      // Single RatingsDO instance: owns the persistent (SQLite) Lavabar rating
      // cache, so every Lavabar fetch is isolated on this DO's own subrequest
      // budget instead of the request-serving Worker's.
      RATINGS: bindings.durableObject({ worker: lavabalance, exportName: "RatingsDO" as const }),
      // Single LosDO instance: the LOS projection (SQLite) and its single
      // writer — the whole LOS store (src/los/losDO.ts).
      LOS: bindings.durableObject({ worker: lavabalance, exportName: "LosDO" as const }),
    },

    observability: {
      logs: { enabled: true, invocationLogs: true },
      // Workers tracing: end-to-end spans for each invocation (fetch, DO RPC,
      // outbound fetch/socket). Must be opted into explicitly — logs alone do
      // not turn it on. headSamplingRate defaults to 1 (trace every request).
      traces: { enabled: true },
    },
  },
});
