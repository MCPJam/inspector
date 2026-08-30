import { describe, expect, it } from "vitest";
import { computeStateToken, shortHash } from "../state-token";

const base = { tabId: "tab-1", navCounter: 3, url: "https://x.test/a", domSignal: "<a><b>" };

describe("computeStateToken (L3)", () => {
  it("is stable for identical inputs", () => {
    expect(computeStateToken(base)).toEqual(computeStateToken({ ...base }));
  });

  it("passes tabId and navCounter through verbatim", () => {
    const t = computeStateToken(base);
    expect(t.tabId).toBe("tab-1");
    expect(t.navCounter).toBe(3);
  });

  it("changes urlHash when the URL changes (navigation)", () => {
    const a = computeStateToken(base);
    const b = computeStateToken({ ...base, url: "https://x.test/b" });
    expect(b.urlHash).not.toBe(a.urlHash);
    expect(b.domHash).toBe(a.domHash); // DOM signal unchanged
  });

  it("changes domHash when the structure changes (a banner shifted the DOM)", () => {
    const a = computeStateToken(base);
    const b = computeStateToken({ ...base, domSignal: "<a><banner><b>" });
    expect(b.domHash).not.toBe(a.domHash);
    expect(b.urlHash).toBe(a.urlHash); // same URL
  });

  it("distinguishes back/forward to the same URL via navCounter", () => {
    const a = computeStateToken(base);
    const b = computeStateToken({ ...base, navCounter: 5 });
    expect(b.navCounter).not.toBe(a.navCounter);
    expect(b.urlHash).toBe(a.urlHash);
  });
});

describe("shortHash", () => {
  it("is deterministic and compact", () => {
    expect(shortHash("hello")).toBe(shortHash("hello"));
    expect(shortHash("hello")).toHaveLength(16);
    expect(shortHash("hello")).not.toBe(shortHash("world"));
  });
});
