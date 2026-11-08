import { describe, expect, it } from "vitest";
import { UserRepository } from "../src/user";
import { parseClientStatus } from "../src/protocol/events";
import { parseMessage } from "../src/protocol/framing";

/** Decode a CLIENTSTATUS line into the event the repository consumes. */
function clientStatus(line: string) {
  return parseClientStatus(parseMessage(line))!;
}

describe("UserRepository", () => {
  it("records rank, in-game and away from CLIENTSTATUS", () => {
    const users = new UserRepository();
    // 17 = 0b10001 → in-game (b0) + rank bits (b2-b4 = 0b100 → level 5).
    users.noteClientStatus(clientStatus("CLIENTSTATUS Alice 17"));

    const u = users.get("Alice")!;
    expect(u.name).toBe("Alice");
    expect(u.inGame).toBe(true);
    expect(u.away).toBe(false);
    expect(u.rank).toBe(5);
    expect(u.skill).toBeNull();
  });

  it("looks up users case-insensitively", () => {
    const users = new UserRepository();
    users.noteClientStatus(clientStatus("CLIENTSTATUS Th1rD1ck 1"));
    expect(users.get("th1rd1ck")).toBe(users.get("Th1rD1ck"));
  });

  it("updates in-game across successive CLIENTSTATUS broadcasts", () => {
    const users = new UserRepository();
    users.noteClientStatus(clientStatus("CLIENTSTATUS host 1")); // in-game set
    expect(users.get("host")!.inGame).toBe(true);
    users.noteClientStatus(clientStatus("CLIENTSTATUS host 0")); // in-game clear
    expect(users.get("host")!.inGame).toBe(false);
  });

  it("merges skill (OS) onto the same user as CLIENTSTATUS, by lowercase key", () => {
    const users = new UserRepository();
    // CLIENTSTATUS carries the real case; SETSCRIPTTAGS keys are server-lowercased.
    users.noteClientStatus(clientStatus("CLIENTSTATUS KasKame 17"));
    users.noteSkill("kaskame", 12.81);

    const u = users.get("KasKame")!;
    expect(u.name).toBe("KasKame"); // display name kept from CLIENTSTATUS
    expect(u.skill).toBe(12.81);
    expect(u.rank).toBe(5);
  });

  it("creates a skill-only user when no CLIENTSTATUS has been seen", () => {
    const users = new UserRepository();
    users.noteSkill("alice", 10);

    const u = users.get("alice")!;
    expect(u.skill).toBe(10);
    expect(u.rank).toBeNull();
    expect(u.inGame).toBe(false);
    expect(u.away).toBe(false);
  });

  it("returns undefined for an unknown user", () => {
    expect(new UserRepository().get("nobody")).toBeUndefined();
  });
});
