// Upload scraped day files to the LOS service (src/los/, the lavaos Worker).
//
//   pnpm run lavaos:upload                              # all of data/ to localhost
//   pnpm run lavaos:upload -- --url https://lavabalance.fogofwar.dev
//   pnpm run lavaos:upload -- --from 2026-08-10 --to 2026-08-20
//
// POSTs each YYYY-MM-DD.json file verbatim to <url>/api/games, in filename
// order ascending — which IS chronological order, and order across uploads is
// the one thing the service's forward-only fold cares about (a day uploaded
// after a newer one comes back "ignored"). Aborts on the first failed upload
// for the same reason: skipping a day and continuing would advance the fold
// head past it and silently ignore its games on the retry.
//
// Idempotent: re-running re-sends everything and the service answers
// "duplicate" for games it already has, so a partial run is resumed by just
// running again.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    data: { type: "string", default: "data" },
    url: { type: "string", default: "http://localhost:8787" },
    from: { type: "string" },
    to: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(
    `Usage: pnpm run lavaos:upload -- [options]

Options:
  --data DIR          directory with scraped YYYY-MM-DD.json files (default: data)
  --url URL           the LOS service (default: http://localhost:8787 — wrangler dev)
  --from YYYY-MM-DD   first day file to upload (default: earliest)
  --to YYYY-MM-DD     last day file to upload (default: latest)`,
  );
  process.exit(0);
}

const base = args.url.replace(/\/$/, "");

const files = (await readdir(args.data))
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .filter((f) => {
    const day = f.slice(0, 10);
    return (!args.from || day >= args.from) && (!args.to || day <= args.to);
  })
  .sort();

if (files.length === 0) {
  console.error(`no day files in ${args.data}/ for the requested range`);
  process.exit(1);
}

interface UploadResult {
  rated: string[];
  ignored: { id: string }[];
  skipped: { id: string; reason: string }[];
  duplicate: string[];
  rejected: string[];
  lastSeq: number;
  players: number;
}

const totals = { rated: 0, ignored: 0, skipped: 0, duplicate: 0, rejected: 0 };
let last: UploadResult | null = null;

console.log(`uploading ${files.length} day files from ${args.data}/ to ${base}`);
for (const f of files) {
  const body = await readFile(join(args.data, f));
  let res: Response;
  try {
    res = await fetch(`${base}/api/games`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch (err) {
    console.error(`${f}: POST ${base}/api/games failed: ${err}`);
    console.error(`aborting — later days must not upload before this one (re-run to resume)`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`${f}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    console.error(`aborting — later days must not upload before this one (re-run to resume)`);
    process.exit(1);
  }
  const r = (await res.json()) as UploadResult;
  last = r;
  totals.rated += r.rated.length;
  totals.ignored += r.ignored.length;
  totals.skipped += r.skipped.length;
  totals.duplicate += r.duplicate.length;
  totals.rejected += r.rejected.length;
  const note = r.ignored.length ? `  ← IGNORED ${r.ignored.map((g) => g.id).join(",")}` : "";
  console.log(
    `${f}: ${String(r.rated.length).padStart(3)} rated  ` +
      `${String(r.ignored.length).padStart(3)} ignored  ` +
      `${String(r.skipped.length).padStart(3)} skipped  ` +
      `${String(r.duplicate.length).padStart(3)} duplicate  ` +
      `${String(r.rejected.length).padStart(4)} rejected${note}`,
  );
}

console.log(
  `\ndone: ${totals.rated} rated, ${totals.ignored} ignored, ${totals.skipped} skipped, ` +
    `${totals.duplicate} duplicate, ${totals.rejected} rejected — ` +
    `service at seq ${last!.lastSeq} with ${last!.players} players`,
);
if (totals.ignored > 0) {
  console.log(
    `note: ignored games were uploaded out of order and stay unrated; to incorporate them,` +
      ` POST ${base}/api/reset?confirm=true and re-run this tool over the full range`,
  );
}
