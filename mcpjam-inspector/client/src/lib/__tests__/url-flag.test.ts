import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeUrlFlag } from "@/lib/url-flag";

/**
 * One-shot deep-link flags (`?topup=open`, `?plans=open`). Two properties
 * carry the weight: the flag is gone from the URL afterwards, so a reload
 * doesn't replay whatever it triggered, and everything else in the query
 * survives — these land on the billing page, which reads its own params.
 */
const setUrl = (search: string) => {
  window.history.replaceState(
    null,
    "",
    `/organizations/org-1/billing${search}`,
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("consumeUrlFlag", () => {
  it("reports the flag and strips it from the URL", () => {
    setUrl("?plans=open");

    expect(consumeUrlFlag("plans", "open")).toBe(true);
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe("/organizations/org-1/billing");
  });

  it("is one-shot — a second read no longer sees it", () => {
    setUrl("?plans=open");

    expect(consumeUrlFlag("plans", "open")).toBe(true);
    expect(consumeUrlFlag("plans", "open")).toBe(false);
  });

  it("keeps unrelated params", () => {
    setUrl("?tab=usage&plans=open&interval=annual");

    expect(consumeUrlFlag("plans", "open")).toBe(true);
    const params = new URLSearchParams(window.location.search);
    expect(params.get("tab")).toBe("usage");
    expect(params.get("interval")).toBe("annual");
    expect(params.has("plans")).toBe(false);
  });

  it("leaves the URL alone when the value doesn't match", () => {
    setUrl("?plans=closed");

    expect(consumeUrlFlag("plans", "open")).toBe(false);
    expect(window.location.search).toBe("?plans=closed");
  });

  it("returns false for an absent flag and an empty query", () => {
    setUrl("?tab=usage");
    expect(consumeUrlFlag("plans", "open")).toBe(false);
    expect(window.location.search).toBe("?tab=usage");

    setUrl("");
    expect(consumeUrlFlag("plans", "open")).toBe(false);
  });

  it("does not touch the two flags for each other", () => {
    setUrl("?topup=open&plans=open");

    expect(consumeUrlFlag("topup", "open")).toBe(true);
    expect(window.location.search).toBe("?plans=open");
    expect(consumeUrlFlag("plans", "open")).toBe(true);
    expect(window.location.search).toBe("");
  });

  it("returns false without a window instead of throwing", () => {
    vi.stubGlobal("window", undefined);
    expect(consumeUrlFlag("plans", "open")).toBe(false);
  });
});
