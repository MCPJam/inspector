import { beforeEach, describe, expect, it, vi } from "vitest";
const token = "access-link-secret-with-enough-entropy";
beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  localStorage.clear();
  history.replaceState(null, "", "/");
});
describe("access links", () => {
  it("consumes and removes the fragment before bootstrap while preserving navigation", async () => {
    history.replaceState(
      { index: 3 },
      "",
      `/?foo=bar#token=${token}&tab=tools`,
    );
    const access = await import("../access-link");
    access.consumeAccessLinkFromUrl();
    expect(access.readAccessToken()).toBe(token);
    expect(location.hash).toBe("#tools");
    expect(location.search).toBe("?foo=bar");
    expect(history.state).toEqual({ index: 3 });
    expect(localStorage.getItem(access.LOCAL_ACCESS_KEY)).toBe(token);
  });
  it("keeps credentials in memory when both storage operations throw", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    history.replaceState(null, "", `/#token=${token}`);
    const access = await import("../access-link");
    access.consumeAccessLinkFromUrl();
    expect(access.readAccessToken()).toBe(token);
    expect(location.hash).toBe("");
  });
  it("also scrubs malformed token fragments", async () => {
    history.replaceState(null, "", "/#token=bad");
    const access = await import("../access-link");
    access.consumeAccessLinkFromUrl();
    expect(access.readAccessToken()).toBeNull();
    expect(location.hash).toBe("");
  });
  it("accepts a full link or a bare credential without navigating to a pasted host", async () => {
    const access = await import("../access-link");
    expect(
      access.parseAccessLink(`http://another-machine:8080/#token=${token}`),
    ).toBe(token);
    expect(access.parseAccessLink(token)).toBe(token);
    expect(access.parseAccessLink("bad")).toBeNull();
  });
});
