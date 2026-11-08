// The pure half of website login (src/auth.ts): tokens, their hashes, the bot's
// issue body, the session cookie both ways, and the same-origin check.

import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  hashToken,
  newToken,
  parseIssueRequest,
  sameOrigin,
  sessionCookie,
  sessionTokenFrom,
  validToken,
} from "../src/auth";

describe("tokens", () => {
  it("are 256-bit base64url strings, different every time", () => {
    const a = newToken();
    const b = newToken();
    expect(validToken(a)).toBe(true);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("reject anything else", () => {
    for (const bad of [undefined, null, 42, "", "short", "x".repeat(44), "a".repeat(42) + "=", "a".repeat(42) + "/"]) {
      expect(validToken(bad)).toBe(false);
    }
  });

  it("are stored as their SHA-256", async () => {
    expect(await hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("parseIssueRequest", () => {
  it("accepts the bot's {name, userId}, trimming the name", () => {
    expect(parseIssueRequest({ name: " huk123 ", userId: 357541 })).toEqual({ name: "huk123", userId: 357541 });
  });

  it("refuses a missing or malformed name or id", () => {
    for (const body of [
      null,
      "x",
      { userId: 1 },
      { name: "", userId: 1 },
      { name: "two words", userId: 1 },
      { name: "x".repeat(65), userId: 1 },
      { name: "a" },
      { name: "a", userId: "1" },
      { name: "a", userId: 0 },
      { name: "a", userId: 1.5 },
    ]) {
      expect(() => parseIssueRequest(body), JSON.stringify(body)).toThrow(/invalid login request/);
    }
  });
});

describe("the session cookie", () => {
  it("is __Host-, HttpOnly, Secure and SameSite=Lax", () => {
    const t = newToken();
    const c = sessionCookie(t);
    expect(c.startsWith(`${SESSION_COOKIE}=${t}; Path=/;`)).toBe(true);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).not.toContain("Domain=");
    expect(clearedSessionCookie()).toContain("Max-Age=0");
  });

  it("is read back from a Cookie header, and only when well-formed", () => {
    const t = newToken();
    expect(sessionTokenFrom(`a=1; ${SESSION_COOKIE}=${t}; b=2`)).toBe(t);
    expect(sessionTokenFrom(`${SESSION_COOKIE}=nope`)).toBeNull();
    expect(sessionTokenFrom(`lb_session=${t}`)).toBeNull();
    expect(sessionTokenFrom(null)).toBeNull();
  });
});

describe("sameOrigin", () => {
  it("lets same-origin and Origin-less requests through, refuses another site", () => {
    const url = "https://lavabalance.fogofwar.dev/api/auth/redeem";
    expect(sameOrigin("https://lavabalance.fogofwar.dev", url)).toBe(true);
    expect(sameOrigin(null, url)).toBe(true);
    expect(sameOrigin("https://evil.example", url)).toBe(false);
    expect(sameOrigin("http://lavabalance.fogofwar.dev", url)).toBe(false);
  });
});
