import { describe, expect, it } from "vitest";
import { parseEvent, toRecords, type ObservabilityEvent } from "../tools/botlogs/parse";

// Shapes captured from the observability API's "containers" dataset (2026-11-14).
const meta = (id: string, message?: string) => ({ id, level: "info", type: "cf-container", message });
const ctr = (messageId: string, priority = 14) => ({ messageId, priority, container: { id: "0a538be3b1d65b920976eb83" } });

describe("parseEvent", () => {
  it("lifts a parsed logEvent line's fields, keeping the bot's own stamp and level", () => {
    const e: ObservabilityEvent = {
      timestamp: 1794615229000,
      source: {
        $cf: { colo: "MRS" },
        ts: "2026-11-14T00:13:48.900Z",
        level: "error",
        msg: "LOS lookup failed",
        error: "fetch failed",
        causes: [{ name: "Error", message: "ECONNREFUSED" }],
      },
      $metadata: meta("A"),
      $containers: ctr("1"),
    };
    expect(parseEvent(e)).toEqual({
      ts: "2026-11-14T00:13:48.900Z",
      level: "error",
      container: "0a538be3b1d6",
      id: "A",
      kind: "event",
      msg: "LOS lookup failed",
      error: "fetch failed",
      causes: [{ name: "Error", message: "ECONNREFUSED" }],
    });
  });

  it("splits a chat line, unwrapping host-relayed in-game chat", () => {
    const direct = parseEvent({
      timestamp: 1,
      source: { message: "2026-11-14T00:14:00.313Z [SAIDBATTLE] <Rekky_Eccy> DAgnir you playing?" },
      $containers: ctr("2"),
    });
    expect(direct).toMatchObject({ kind: "chat", channel: "lobby", cmd: "SAIDBATTLE", from: "Rekky_Eccy", text: "DAgnir you playing?", ts: "2026-11-14T00:14:00.313Z" });
    expect(direct).not.toHaveProperty("via");

    const relayed = parseEvent({
      timestamp: 1,
      source: { message: "2026-11-13T22:14:23.234Z [SAIDBATTLE] <Host[EU2][005]> <henk1987> !vote n" },
    });
    expect(relayed).toMatchObject({ kind: "chat", channel: "game", from: "henk1987", via: "Host[EU2][005]", text: "!vote n" });

    const announce = parseEvent({
      timestamp: 1,
      source: { message: "2026-11-14T00:09:10.476Z [SAIDBATTLEEX] <Host[EU2][005]> * Awaiting following vote(s): a,b" },
    });
    expect(announce).toMatchObject({ channel: "lobby", cmd: "SAIDBATTLEEX", from: "Host[EU2][005]", text: "* Awaiting following vote(s): a,b" });

    const inbound = parseEvent({ timestamp: 1, source: { message: "2026-11-14T00:00:00.000Z [SAIDPRIVATE] <huk123> .info" } });
    expect(inbound).toMatchObject({ channel: "whisper", direction: "in", from: "huk123", text: ".info" });
    expect(inbound).not.toHaveProperty("to");

    const outbound = parseEvent({ timestamp: 1, source: { message: "2026-11-14T00:00:01.000Z [SAYPRIVATE to huk123] <lavabalance> battle 275" } });
    expect(outbound).toMatchObject({ channel: "whisper", direction: "out", from: "lavabalance", to: "huk123", text: "battle 275" });

    const room = parseEvent({ timestamp: 1, source: { message: "2026-11-14T00:00:00.000Z [SAID #main] <someone> hi" } });
    expect(room).toMatchObject({ channel: "channel", where: "#main", from: "someone", text: "hi" });
  });

  it("passes the bot's structured chat events through as chat records", () => {
    const r = parseEvent({
      timestamp: 1,
      source: {
        ts: "2026-11-14T01:00:00.000Z",
        level: "info",
        msg: "[game] <henk1987> gg",
        kind: "chat",
        channel: "game",
        cmd: "SAIDBATTLE",
        from: "henk1987",
        via: "Host[EU2][005]",
        text: "gg",
      },
      $containers: ctr("4"),
    });
    expect(r).toEqual({
      ts: "2026-11-14T01:00:00.000Z",
      level: "info",
      container: "0a538be3b1d6",
      kind: "chat",
      channel: "game",
      cmd: "SAIDBATTLE",
      from: "henk1987",
      via: "Host[EU2][005]",
      text: "gg",
    });
  });

  it("keeps anything else as a plain line, levelled by the syslog priority", () => {
    const r = parseEvent({ timestamp: Date.UTC(2026, 10, 14), source: { message: "team 1:" }, $containers: ctr("3", 11) });
    expect(r).toMatchObject({ kind: "line", text: "team 1:", level: "error", ts: "2026-11-14T00:00:00.000Z" });
  });
});

describe("toRecords", () => {
  it("de-duplicates by event id and orders oldest first, ties by sequence number", () => {
    const line = (id: string, t: number, seq: string, text: string): ObservabilityEvent => ({
      timestamp: t,
      source: { message: text },
      $metadata: meta(id),
      $containers: ctr(seq),
    });
    const out = toRecords([line("c", 20, "12", "third"), line("b", 10, "11", "second"), line("a", 10, "10", "first"), line("b", 10, "11", "second")]);
    expect(out.map((r) => (r.kind === "line" ? r.text : ""))).toEqual(["first", "second", "third"]);
  });
});
