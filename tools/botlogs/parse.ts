// Pure half of `pnpm run bot:logs`: turns the Cloudflare Workers Observability
// API's container events into one structured record per log line. No node:*
// imports, so the unit tests (Node pool) can import it.
//
// The bot's stdout reaches the "containers" dataset in three shapes:
//   • a JSON line from logEvent/status/logError (src/bot/bot.ts) — Cloudflare
//     parses it, so `source` holds the fields themselves ({ts, level, msg, …});
//   • a chat line from `chat()` — `<ISO> [KIND[ where]] <from> text`;
//     classified by `channel` (see ChatChannel);
//   • anything else printed plainly (roster tables, matchup lines) — `message`.

/** One event as `POST …/workers/observability/telemetry/query` returns it (the parts we read). */
export interface ObservabilityEvent {
  timestamp: number;
  source?: Record<string, unknown>;
  $metadata?: { id?: string; level?: string; message?: string; [k: string]: unknown };
  $containers?: { messageId?: string; priority?: number; container?: { id?: string }; [k: string]: unknown };
}

interface Common {
  /** When the line was written: the bot's own stamp when it has one, else Cloudflare's. */
  ts: string;
  level: string;
  /** Short container instance id: a change marks a restart. */
  container?: string;
  /** Cloudflare's event id, stable across fetches (for de-duplication). */
  id?: string;
}

/**
 * Where a chat line was said:
 *   • "game"    — in-game chat, relayed into the lobby by the host
 *                 (`SAIDBATTLE <host> <player> text`; `via` = the host);
 *   • "lobby"   — the battle lobby's own chat (SAIDBATTLE / SAIDBATTLEEX,
 *                 host announcements and the bot's own lines included);
 *   • "whisper" — a private message to or from the bot (`direction` "in" /
 *                 "out"; `to` set on outgoing ones). The host's PMs (SPADS
 *                 replies, the bot's `!fb` commands to it) are whispers too;
 *   • "channel" — a chat room (`#name` in `where`).
 */
export type ChatChannel = "game" | "lobby" | "whisper" | "channel";

export type BotLogRecord =
  | (Common & { kind: "event"; msg: string; [field: string]: unknown })
  | (Common & {
      kind: "chat";
      channel: ChatChannel;
      chat: string;
      where?: string;
      direction?: "in" | "out";
      from: string;
      to?: string;
      via?: string;
      text: string;
    })
  | (Common & { kind: "line"; text: string });

// `chat()` in bot.ts: `${stamp()} [${kind}${where ? ` ${where}` : ""}] <${from}> ${message}`
const CHAT_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) \[(\S+)(?: ([^\]]+))?\] <([^>]*)> ?([\s\S]*)$/;

/** The container's syslog priority → a level: stderr lines arrive with a higher severity than stdout's. */
function syslogLevel(priority: unknown): string | undefined {
  if (typeof priority !== "number") return undefined;
  const severity = priority % 8;
  return severity <= 3 ? "error" : severity === 4 ? "warn" : "info";
}

const RELAY_RE = /^<([^>\s]+)> ([\s\S]*)$/;

export function parseEvent(e: ObservabilityEvent): BotLogRecord {
  const src = e.source ?? {};
  const common: Common = {
    ts: new Date(e.timestamp).toISOString(),
    level: syslogLevel(e.$containers?.priority) ?? (typeof e.$metadata?.level === "string" ? e.$metadata.level : "info"),
  };
  const cid = e.$containers?.container?.id;
  if (cid) common.container = cid.slice(0, 12);
  if (e.$metadata?.id) common.id = e.$metadata.id;

  if (typeof src.msg === "string") {
    const { $cf: _cf, ts, level, msg, ...fields } = src;
    return {
      ...common,
      ...(typeof ts === "string" ? { ts } : {}),
      ...(typeof level === "string" ? { level } : {}),
      kind: "event",
      msg,
      ...fields,
    };
  }

  const text =
    typeof src.message === "string"
      ? src.message
      : typeof e.$metadata?.message === "string"
        ? e.$metadata.message
        : "";
  const m = CHAT_RE.exec(text);
  if (m) {
    const [, ts, chat, where, from, body] = m;
    const base = { ...common, ts: ts!, kind: "chat" as const, chat: chat!, ...(where ? { where } : {}) };
    if (chat === "SAIDPRIVATE" || chat === "SAIDPRIVATEEX") {
      return { ...base, channel: "whisper", direction: "in", from: from!, text: body! };
    }
    if (chat === "SAYPRIVATE") {
      // bot.ts logs its own whispers as `[SAYPRIVATE to <name>] <bot> text`.
      const to = where?.startsWith("to ") ? where.slice(3) : undefined;
      return { ...base, channel: "whisper", direction: "out", from: from!, ...(to ? { to } : {}), text: body! };
    }
    if (chat === "SAID" || chat === "SAIDEX") return { ...base, channel: "channel", from: from!, text: body! };
    // In-game chat reaches the lobby relayed by the host: `SAIDBATTLE <host> <player> text`.
    const relayed = chat === "SAIDBATTLE" ? RELAY_RE.exec(body!) : null;
    if (relayed) return { ...base, channel: "game", from: relayed[1]!, via: from!, text: relayed[2]! };
    return { ...base, channel: "lobby", from: from!, text: body! };
  }
  return { ...common, kind: "line", text };
}

/**
 * Parse, de-duplicate (by Cloudflare's event id) and sort oldest first. Lines
 * sharing a millisecond are common (a roster table is one burst), so ties go
 * by the container's syslog sequence number (`messageId`).
 */
export function toRecords(events: ObservabilityEvent[]): BotLogRecord[] {
  const seen = new Set<string>();
  const out: { r: BotLogRecord; t: number; seq: number }[] = [];
  for (const e of events) {
    const id = e.$metadata?.id;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const seq = Number(e.$containers?.messageId);
    out.push({ r: parseEvent(e), t: e.timestamp, seq: Number.isFinite(seq) ? seq : 0 });
  }
  out.sort((a, b) => a.t - b.t || a.seq - b.seq);
  return out.map((x) => x.r);
}
