// enabledSrcModes: parsing the SRC_MODES var into the enabled list + default.

import { describe, expect, it } from "vitest";
import { enabledSrcModes, KNOWN_SRC_MODES } from "../src/config";

// enabledSrcModes only reads env.SRC_MODES; a partial cast keeps the test focused.
const modesFor = (SRC_MODES?: string) =>
  enabledSrcModes({ SRC_MODES } as unknown as Env);

describe("enabledSrcModes", () => {
  it("enables exactly the listed modes, first one is the default", () => {
    const { modes, defaultMode } = modesFor("proxy,rtsapi");
    expect(modes).toEqual(["proxy", "rtsapi"]);
    expect(defaultMode).toBe("proxy");
  });

  it("trims whitespace around names", () => {
    expect(modesFor(" teiserver , proxy ").modes).toEqual([
      "teiserver",
      "proxy",
    ]);
  });

  it("drops unknown names (typos / unservable modes)", () => {
    const { modes, defaultMode } = modesFor("bogus,rtsapi");
    expect(modes).toEqual(["rtsapi"]);
    expect(defaultMode).toBe("rtsapi");
  });

  it("de-dupes while preserving order so the first stays the default", () => {
    expect(modesFor("rtsapi,proxy,rtsapi").modes).toEqual(["rtsapi", "proxy"]);
  });

  it("falls back to all known modes when unset", () => {
    const { modes, defaultMode } = modesFor(undefined);
    expect(modes).toEqual([...KNOWN_SRC_MODES]);
    expect(defaultMode).toBe(KNOWN_SRC_MODES[0]);
  });

  it("falls back to all known modes when empty or all-unknown", () => {
    expect(modesFor("").modes).toEqual([...KNOWN_SRC_MODES]);
    expect(modesFor("nope,nada").modes).toEqual([...KNOWN_SRC_MODES]);
  });

  it("a single enabled mode disables the rest (the others would 400)", () => {
    const { modes, defaultMode } = modesFor("proxy");
    expect(modes).toEqual(["proxy"]);
    expect(defaultMode).toBe("proxy");
    expect(modes).not.toContain("teiserver");
    expect(modes).not.toContain("rtsapi");
  });
});
