// Workers-pool test for the TeiserverDO Durable Object: the session cookie is persisted in
// DO storage and reused (no re-login) after the in-memory state is gone, and DEBUG logs
// redact the password and truncate/escape bodies.
//
// The Teiserver web fetch is stubbed via the private `webFetch` seam (overridden on the live
// instance through runInDurableObject) so the test is deterministic and never hits the
// network. `env` is also patched onto the instance to supply the login credentials the test
// env doesn't carry as secrets.

import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { TeiserverDO } from "../src/teiserverDO";

const LOGIN_FORM = `<form><input name="_csrf_token" value="csrf-123"></form>`;
const LOBBY_INDEX = `<table class="table table-sm table-hover"><tbody id="lobbies"></tbody></table>`;

/**
 * Private members we reach into for stubbing / state-reset (TS-private, not
 * runtime-private). The session core lives on the DO's inner TeiserverWeb (`web`),
 * so the fetch seam and the cookie jar are stubbed there.
 */
type WebPriv = {
  cookies: Map<string, string>;
  webFetch: (path: string, init?: RequestInit) => Promise<Response>;
  redactPassword: (s: string) => string;
  formatBodyForLog: (b: string) => string;
};
type Priv = {
  env: Env;
  web: WebPriv;
  hydrateInflight?: Promise<void>;
  listCache?: unknown;
};

function instanceFor(name: string) {
  return env.TEISERVER.get(env.TEISERVER.idFromName(name));
}

function withCreds(p: Priv): void {
  p.env = { ...p.env, TEISERVER_EMAIL: "bot@example.test", TEISERVER_PASSWORD: "s3cr3t pw" } as Env;
}

/** A canned Teiserver web server recording every request: login flow + an empty lobby index. */
function fakeWeb(calls: string[]) {
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (path === "/login" && method === "GET") {
      const headers = new Headers();
      headers.append("set-cookie", "_session=sess-1; Path=/; HttpOnly");
      return new Response(LOGIN_FORM, { status: 200, headers });
    }
    if (path === "/login") {
      const headers = new Headers();
      headers.append("set-cookie", "guardian_default_token=tok-1; Path=/; HttpOnly");
      return new Response(null, { status: 302, headers });
    }
    return new Response(LOBBY_INDEX, { status: 200 });
  };
}

describe("TeiserverDO session persistence", () => {
  it("logs in once, persists the cookie, and reuses it after eviction", async () => {
    const stub = instanceFor("persist");

    const calls: string[] = [];
    await runInDurableObject(stub, async (i: TeiserverDO) => {
      const p = i as unknown as Priv;
      withCreds(p);
      p.web.webFetch = fakeWeb(calls);
      await i.listLobbies();
    });
    // First call: full login (GET form + POST creds), then the index fetch.
    expect(calls).toEqual(["GET /login", "POST /login", "GET /battle/lobbies"]);

    // Simulate a DO eviction: drop the in-memory jar + caches but keep DO storage, then
    // verify the next call reads the persisted cookie and skips the login entirely.
    const calls2: string[] = [];
    await runInDurableObject(stub, async (i: TeiserverDO) => {
      const p = i as unknown as Priv;
      withCreds(p);
      p.web.cookies = new Map();
      p.hydrateInflight = undefined;
      p.listCache = undefined;
      p.web.webFetch = fakeWeb(calls2);
      await i.listLobbies();
    });
    expect(calls2).toEqual(["GET /battle/lobbies"]);
  });
});

describe("TeiserverDO debug log hygiene", () => {
  it("redacts the password (raw + form-encoded) and truncates/escapes bodies", async () => {
    const stub = instanceFor("redact");
    await runInDurableObject(stub, async (i: TeiserverDO) => {
      const p = i as unknown as Priv;
      withCreds(p); // password = "s3cr3t pw"

      // Raw occurrence and the application/x-www-form-urlencoded form ("+" for space).
      expect(p.web.redactPassword("user[password]=s3cr3t+pw&_csrf=z")).toBe(
        "user[password]=REDACTED_TEISERVER_PASSWORD&_csrf=z",
      );
      const raw = p.web.redactPassword("pass=s3cr3t pw end");
      expect(raw).toContain("REDACTED_TEISERVER_PASSWORD");
      expect(raw).not.toContain("s3cr3t pw");

      // Body formatting: newlines escaped to a single line, capped at the first 200 chars.
      const body = "a\nb\r\n" + "x".repeat(500);
      const out = p.web.formatBodyForLog(body);
      expect(out).not.toMatch(/[\r\n]/); // single line
      expect(out.startsWith("a\\nb\\r\\n")).toBe(true);
      expect((out.match(/x/g) ?? []).length).toBe(195); // 5 leading chars + 195 = 200 source chars
    });
  });
});
