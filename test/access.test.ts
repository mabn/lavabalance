// The Access JWT verifier (src/access.ts, ported from barreplay — jose
// underneath) against a keypair this test makes: a token it signs itself must
// verify, and every way a token can be wrong — signature, audience, issuer,
// expiry, algorithm, an unknown key — must come back null rather than throw.
// The key set is served by a stubbed globalThis.fetch. Then adminIdentity, the
// one check every admin page and route goes through.
import { expect, it } from "vitest";

import {
  AccessVerifier,
  accessCertsURL,
  accessToken,
  adminIdentity,
  botIdentity,
  scoutIdentity,
  clearedAccessCookie,
  loginNext,
  normalizeTeamDomain,
} from "../src/access";

/** node:assert's shape over vitest's expect (the tests are barreplay's). */
const assert = {
  equal: (a: unknown, b: unknown, msg?: string) => expect(a, msg).toBe(b),
  deepEqual: (a: unknown, b: unknown, msg?: string) => expect(a, msg).toEqual(b),
  ok: (v: unknown, msg?: string) => expect(v, msg).toBeTruthy(),
  rejects: (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toThrow(re),
};

/** node:test's (name, t => …) shape over vitest, with t.after cleanups. */
function test(name: string, fn: (t: { after(f: () => void): void }) => unknown) {
  it(name, async () => {
    const cleanups: (() => void)[] = [];
    try {
      await fn({ after: (f) => cleanups.push(f) });
    } finally {
      for (const f of cleanups.reverse()) f();
    }
  });
}

const TEAM = "example";
const AUD = "a".repeat(64);
const NOW = 1_800_000_000_000;

const b64url = (bytes: Uint8Array | string): string => {
  const bin = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

interface Signer {
  kid: string;
  jwk: JsonWebKey;
  sign: (header: object, claims: object) => Promise<string>;
}

async function makeSigner(kid: string): Promise<Signer> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    kid,
    jwk,
    sign: async (header, claims) => {
      const h = b64url(JSON.stringify(header));
      const p = b64url(JSON.stringify(claims));
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
      return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
    },
  };
}

/** Serve these signers' public keys as the team's cert set, counting reads. */
function stubCerts(t: { after(fn: () => void): void }, signers: () => Signer[]) {
  const orig = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url !== accessCertsURL(TEAM)) return new Response("nope", { status: 404 });
    const keys = signers().map((s) => ({ kid: s.kid, kty: "RSA", n: s.jwk.n, e: s.jwk.e, alg: "RS256" }));
    return Response.json({ keys });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = orig;
  });
  return calls;
}

const goodClaims = (over: Record<string, unknown> = {}) => ({
  aud: [AUD],
  iss: `https://${TEAM}.cloudflareaccess.com`,
  sub: "user-1",
  email: "admin@example.org",
  exp: Math.floor(NOW / 1000) + 3600,
  iat: Math.floor(NOW / 1000) - 60,
  ...over,
});

test("a token Access signed for this application verifies to its identity", async (t) => {
  const signer = await makeSigner("k1");
  const calls = stubCerts(t, () => [signer]);
  const v = new AccessVerifier();
  const token = await signer.sign({ alg: "RS256", kid: "k1", typ: "JWT" }, goodClaims());

  const id = await v.verify(token, { teamDomain: TEAM, aud: AUD, now: NOW });
  assert.deepEqual(id, { email: "admin@example.org", sub: "user-1" });
  assert.equal(calls.length, 1, "the key set was read once");

  // A second token reuses the cached keys.
  await v.verify(token, { teamDomain: TEAM, aud: AUD, now: NOW + 1000 });
  assert.equal(calls.length, 1, "cached");

  // A string aud (Access sends an array, but the claim allows both).
  const single = await signer.sign({ alg: "RS256", kid: "k1" }, goodClaims({ aud: AUD }));
  assert.ok(await v.verify(single, { teamDomain: TEAM, aud: AUD, now: NOW }));

  // No kid, but signed by the one published key: jose matches on alg when
  // that is unambiguous, and the signature is genuine.
  const noKid = await signer.sign({ alg: "RS256" }, goodClaims());
  assert.ok(await v.verify(noKid, { teamDomain: TEAM, aud: AUD, now: NOW }));

  // A service token carries no email.
  const svc = await signer.sign({ alg: "RS256", kid: "k1" }, goodClaims({ email: undefined }));
  assert.deepEqual(await v.verify(svc, { teamDomain: TEAM, aud: AUD, now: NOW }), { email: null, sub: "user-1" });
});

test("every wrong token is null, never an exception", async (t) => {
  const signer = await makeSigner("k1");
  const other = await makeSigner("k1"); // same kid, different key: a forgery
  stubCerts(t, () => [signer]);
  const v = new AccessVerifier();
  const H = { alg: "RS256", kid: "k1" };
  const opts = { teamDomain: TEAM, aud: AUD, now: NOW };

  const cases: [string, Promise<string> | string][] = [
    ["forged signature", other.sign(H, goodClaims())],
    ["wrong audience", signer.sign(H, goodClaims({ aud: ["b".repeat(64)] }))],
    ["wrong issuer", signer.sign(H, goodClaims({ iss: "https://evil.cloudflareaccess.com" }))],
    ["expired", signer.sign(H, goodClaims({ exp: Math.floor(NOW / 1000) - 1 }))],
    ["not yet valid", signer.sign(H, goodClaims({ nbf: Math.floor(NOW / 1000) + 60 }))],
    ["no exp", signer.sign(H, goodClaims({ exp: undefined }))],
    ["no sub", signer.sign(H, goodClaims({ sub: undefined }))],
    ["alg none", `${b64url('{"alg":"none","kid":"k1"}')}.${b64url(JSON.stringify(goodClaims()))}.`],
    ["HS256", signer.sign({ alg: "HS256", kid: "k1" }, goodClaims())],
    ["two parts", "abc.def"],
    ["garbage", "not a token at all"],
    ["bad json", `${b64url("{nope")}.${b64url("{}")}.${b64url("x")}`],
    ["tampered payload", (async () => {
      const tok = await signer.sign(H, goodClaims());
      const [h, , s] = tok.split(".");
      return `${h}.${b64url(JSON.stringify(goodClaims({ email: "root@example.org" })))}.${s}`;
    })()],
  ];
  for (const [name, tok] of cases) {
    assert.equal(await v.verify(await tok, opts), null, name);
  }
});

test("an unknown kid re-reads the key set (rotation), but not inside the cooldown (a forgery per request)", async (t) => {
  const k1 = await makeSigner("k1");
  const k2 = await makeSigner("k2");
  let live = [k1];
  const calls = stubCerts(t, () => live);
  const opts = { teamDomain: TEAM, aud: AUD, now: NOW };

  // No cooldown: a rotated-in key is found on the re-read the unknown kid
  // provokes.
  const eager = new AccessVerifier({ cooldownMs: 0 });
  assert.ok(await eager.verify(await k1.sign({ alg: "RS256", kid: "k1" }, goodClaims()), opts));
  assert.equal(calls.length, 1);
  live = [k1, k2];
  const t2 = await k2.sign({ alg: "RS256", kid: "k2" }, goodClaims());
  assert.ok(await eager.verify(t2, opts), "the rotated-in key is found on a re-read");
  assert.equal(calls.length, 2);

  // The production cooldown: a stream of unknown kids after one read costs
  // no further fetch — each is refused off the cached set.
  const patient = new AccessVerifier();
  assert.ok(await patient.verify(t2, opts));
  assert.equal(calls.length, 3);
  for (let i = 0; i < 5; i++) {
    const forged = await k1.sign({ alg: "RS256", kid: `bogus-${i}` }, goodClaims());
    assert.equal(await patient.verify(forged, opts), null);
  }
  assert.equal(calls.length, 3, "no re-read inside the cooldown");
});

test("an unreadable key set is an error, not a silent pass or a silent refusal", async (t) => {
  const signer = await makeSigner("k1");
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = orig;
  });
  const v = new AccessVerifier();
  const tok = await signer.sign({ alg: "RS256", kid: "k1" }, goodClaims());
  await assert.rejects(v.verify(tok, { teamDomain: TEAM, aud: AUD, now: NOW }), /Expected 200 OK/);
});

test("the token is read from the Access header first, then the CF_Authorization cookie", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  assert.equal(accessToken(h({})), null);
  assert.equal(accessToken(h({ cookie: "other=1; CF_Authorization=tok.en.x; more=2" })), "tok.en.x");
  assert.equal(accessToken(h({ cookie: "CF_Authorization=" })), null, "an empty cookie is no token");
  assert.equal(accessToken(h({ cookie: "xCF_Authorization=nope" })), null, "the name must match whole");
  assert.equal(accessToken(h({ "cf-access-jwt-assertion": "hdr", cookie: "CF_Authorization=cookie" })), "hdr");
});

test("team domain spellings normalize; the login's next stays on this site", () => {
  for (const raw of ["example", "example.cloudflareaccess.com", "https://example.cloudflareaccess.com/", " Example "]) {
    assert.equal(normalizeTeamDomain(raw), "example.cloudflareaccess.com", raw);
    assert.equal(accessCertsURL(raw), "https://example.cloudflareaccess.com/cdn-cgi/access/certs");
  }
  assert.equal(loginNext("/ranking"), "/ranking");
  assert.equal(loginNext("/replays/abc?gl=0&col=lobby"), "/replays/abc?gl=0&col=lobby");
  assert.equal(loginNext(null), "/");
  assert.equal(loginNext("https://evil.example/"), "/", "an absolute URL is not a destination");
  assert.equal(loginNext("//evil.example/x"), "/", "a protocol-relative URL neither");
  assert.equal(loginNext("queue"), "/", "a relative path neither");
  assert.equal(loginNext("/\\evil.example"), "/", "nor a backslash a browser reads as //");
});

test("adminIdentity: dev opt-in, the control token, a verified Access cookie — and nothing else", async (t) => {
  const signer = await makeSigner("k1");
  stubCerts(t, () => [signer]);
  const h = (init: Record<string, string>) => new Headers(init);
  const access = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
  // Real clock here (adminIdentity has no `now`), so the token is minted for it.
  const nowS = Math.floor(Date.now() / 1000);
  const token = await signer.sign({ alg: "RS256", kid: "k1" }, goodClaims({ exp: nowS + 3600, iat: nowS - 60 }));

  assert.equal(await adminIdentity({}, h({})), null, "nobody by default");
  assert.deepEqual(await adminIdentity({ ADMIN_OPEN: "true" }, h({})), { email: null, via: "open" });
  assert.equal(await adminIdentity({ ADMIN_OPEN: "1" }, h({})), null, "only the exact opt-in");

  assert.deepEqual(
    await adminIdentity({ CONTROL_TOKEN: "sekrit" }, h({ authorization: "Bearer sekrit" })),
    { email: null, via: "token" },
  );
  assert.equal(await adminIdentity({ CONTROL_TOKEN: "sekrit" }, h({ authorization: "Bearer nope" })), null);
  assert.equal(await adminIdentity({}, h({ authorization: "Bearer " })), null, "no token configured is no way in");

  assert.deepEqual(
    await adminIdentity(access, h({ cookie: `CF_Authorization=${token}` })),
    { email: "admin@example.org", via: "access" },
  );
  assert.equal(await adminIdentity(access, h({ cookie: "CF_Authorization=forged.x.y" })), null);
  assert.equal(
    await adminIdentity({ ACCESS_TEAM_DOMAIN: TEAM }, h({ cookie: `CF_Authorization=${token}` })),
    null,
    "fail-closed without the AUD",
  );
  assert.equal(
    await adminIdentity({ ...access, ACCESS_AUD: "b".repeat(64) }, h({ cookie: `CF_Authorization=${token}` })),
    null,
    "a token for another application",
  );
});

test("adminIdentity: an unreadable key set is 'not an admin', not a crashed page", async (t) => {
  const signer = await makeSigner("k1");
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = orig;
  });
  const nowS = Math.floor(Date.now() / 1000);
  // Its own team, so no other test's cached key set can answer for it.
  const env = { ACCESS_TEAM_DOMAIN: "other-team", ACCESS_AUD: AUD };
  const iss = "https://other-team.cloudflareaccess.com";
  const token = await signer.sign({ alg: "RS256", kid: "k1" }, goodClaims({ exp: nowS + 3600, iss }));
  assert.equal(await adminIdentity(env, new Headers({ cookie: `CF_Authorization=${token}` })), null);
});

test("the sign-out cookie expires CF_Authorization on this host", () => {
  assert.equal(clearedAccessCookie(true), "CF_Authorization=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0");
  assert.equal(clearedAccessCookie(false), "CF_Authorization=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
});

test("botIdentity / scoutIdentity: only a token for THAT application, never another one or a bearer", async (t) => {
  const signer = await makeSigner("k1");
  stubCerts(t, () => [signer]);
  const BOT_AUD = "c".repeat(64);
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_BOT_AUD: BOT_AUD, CONTROL_TOKEN: "sekrit" };
  const nowS = Math.floor(Date.now() / 1000);
  const sign = (aud: string) =>
    signer.sign({ alg: "RS256", kid: "k1" }, goodClaims({ aud: [aud], email: undefined, exp: nowS + 3600, iat: nowS - 60 }));
  const assertion = (tok: string) => new Headers({ "cf-access-jwt-assertion": tok });

  assert.deepEqual(await botIdentity(env, assertion(await sign(BOT_AUD))), { email: null, sub: "user-1" });
  assert.equal(await botIdentity(env, assertion(await sign(AUD))), null, "the admin application's token");
  assert.equal(await adminIdentity(env, assertion(await sign(BOT_AUD))), null, "and the bot's is no admin");
  assert.equal(await botIdentity(env, new Headers({ authorization: "Bearer sekrit" })), null, "no bearer fallback");
  assert.equal(await botIdentity({ ACCESS_TEAM_DOMAIN: TEAM }, assertion(await sign(BOT_AUD))), null, "fail-closed");
  assert.deepEqual(await botIdentity({ ADMIN_OPEN: "true" }, new Headers()), { email: null, sub: "dev" });

  // scoutIdentity is the same check for onetricklava's push, on ITS audience: the
  // three Access applications' tokens are not interchangeable in any direction.
  const SCOUT_AUD = "d".repeat(64);
  const all = { ...env, ACCESS_SCOUT_AUD: SCOUT_AUD };
  assert.deepEqual(await scoutIdentity(all, assertion(await sign(SCOUT_AUD))), { email: null, sub: "user-1" });
  assert.equal(await scoutIdentity(all, assertion(await sign(BOT_AUD))), null, "the bot's token");
  assert.equal(await scoutIdentity(all, assertion(await sign(AUD))), null, "the admin application's token");
  assert.equal(await botIdentity(all, assertion(await sign(SCOUT_AUD))), null, "OTL's token is no bot");
  assert.equal(await adminIdentity(all, assertion(await sign(SCOUT_AUD))), null, "nor an admin");
  assert.equal(await scoutIdentity(all, new Headers({ authorization: "Bearer sekrit" })), null, "no bearer fallback");
  assert.equal(await scoutIdentity(env, assertion(await sign(SCOUT_AUD))), null, "fail-closed without the AUD");
  assert.deepEqual(await scoutIdentity({ ADMIN_OPEN: "true" }, new Headers()), { email: null, sub: "dev" });
});
