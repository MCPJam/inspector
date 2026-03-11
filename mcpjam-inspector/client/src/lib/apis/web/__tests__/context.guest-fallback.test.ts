/**
 * getHostedAuthorizationHeader Guest Fallback Tests
 *
 * Tests for the core behavior change: when WorkOS getAccessToken() is
 * unavailable or throws LoginRequiredError, the function falls back
 * to a guest bearer token instead of returning null.
 */

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/guest-session", () => ({
  getGuestBearerToken: vi.fn(),
}));

import { setHostedApiContext, getHostedAuthorizationHeader } from "../context";

import { getGuestBearerToken } from "@/lib/guest-session";

describe("getHostedAuthorizationHeader guest fallback", () => {
  beforeEach(() => {
    // Reset context between tests to clear cachedBearerToken
    setHostedApiContext(null);
    vi.mocked(getGuestBearerToken).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns WorkOS token when getAccessToken succeeds", async () => {
    setHostedApiContext({
      workspaceId: "ws-1",
      serverIdsByName: {},
      getAccessToken: () => Promise.resolve("workos-token-abc"),
    });

    const result = await getHostedAuthorizationHeader();

    expect(result).toBe("Bearer workos-token-abc");
    expect(getGuestBearerToken).not.toHaveBeenCalled();
  });

  it("falls back to guest token when getAccessToken throws", async () => {
    setHostedApiContext({
      workspaceId: "ws-1",
      serverIdsByName: {},
      getAccessToken: () => {
        throw new Error("LoginRequiredError");
      },
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-token-xyz");

    const result = await getHostedAuthorizationHeader();

    expect(result).toBe("Bearer guest-token-xyz");
    expect(getGuestBearerToken).toHaveBeenCalled();
  });

  it("falls back to guest token when getAccessToken rejects", async () => {
    setHostedApiContext({
      workspaceId: "ws-1",
      serverIdsByName: {},
      getAccessToken: () => Promise.reject(new Error("LoginRequiredError")),
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-token-abc");

    const result = await getHostedAuthorizationHeader();

    expect(result).toBe("Bearer guest-token-abc");
  });

  it("falls back to guest token when getAccessToken returns null", async () => {
    setHostedApiContext({
      workspaceId: "ws-1",
      serverIdsByName: {},
      getAccessToken: () => Promise.resolve(null),
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-fallback");

    const result = await getHostedAuthorizationHeader();

    expect(result).toBe("Bearer guest-fallback");
  });

  it("falls back to guest token when getAccessToken returns undefined", async () => {
    setHostedApiContext({
      workspaceId: "ws-1",
      serverIdsByName: {},
      getAccessToken: () => Promise.resolve(undefined),
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-undef");

    const result = await getHostedAuthorizationHeader();

    expect(result).toBe("Bearer guest-undef");
  });

  it("falls back to guest token when getAccessToken is not set", async () => {
    setHostedApiContext({
      workspaceId: "ws-1",
      serverIdsByName: {},
      // No getAccessToken — simulates no WorkOS provider
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-no-workos");

    const result = await getHostedAuthorizationHeader();

    expect(result).toBe("Bearer guest-no-workos");
  });

  it("prefers guest token in guest mode without calling getAccessToken", async () => {
    const getAccessToken = vi
      .fn()
      .mockResolvedValue("workos-token-should-skip");
    setHostedApiContext({
      workspaceId: null,
      isAuthenticated: false,
      serverIdsByName: {},
      getAccessToken,
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-first");

    const result = await getHostedAuthorizationHeader();

    expect(result).toBe("Bearer guest-first");
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("still prefers guest token when no workspace is loaded but AuthKit session exists", async () => {
    const getAccessToken = vi
      .fn()
      .mockResolvedValue("workos-token-should-skip");
    setHostedApiContext({
      workspaceId: null,
      isAuthenticated: false,
      hasSession: true,
      serverIdsByName: {},
      getAccessToken,
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-despite-session");

    const result = await getHostedAuthorizationHeader();

    expect(result).toBe("Bearer guest-despite-session");
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("returns null when both WorkOS and guest token fail", async () => {
    setHostedApiContext({
      workspaceId: "ws-1",
      serverIdsByName: {},
      getAccessToken: () => Promise.reject(new Error("LoginRequiredError")),
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue(null);

    const result = await getHostedAuthorizationHeader();

    expect(result).toBeNull();
  });

  it("caches WorkOS token and does not call guest on subsequent calls", async () => {
    const getAccessToken = vi.fn().mockResolvedValue("cached-workos");
    setHostedApiContext({
      workspaceId: "ws-1",
      serverIdsByName: {},
      getAccessToken,
    });

    const result1 = await getHostedAuthorizationHeader();
    const result2 = await getHostedAuthorizationHeader();

    expect(result1).toBe("Bearer cached-workos");
    expect(result2).toBe("Bearer cached-workos");
    // getAccessToken called once, then cached for 30s
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(getGuestBearerToken).not.toHaveBeenCalled();
  });

  it("re-evaluates after cache expires", async () => {
    vi.useFakeTimers();

    setHostedApiContext({
      workspaceId: "ws-1",
      serverIdsByName: {},
      getAccessToken: () => Promise.reject(new Error("LoginRequiredError")),
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-1");

    const result1 = await getHostedAuthorizationHeader();
    expect(result1).toBe("Bearer guest-1");

    vi.advanceTimersByTime(30_001);
    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-2");

    const result2 = await getHostedAuthorizationHeader();
    expect(result2).toBe("Bearer guest-2");

    vi.useRealTimers();
  });
});
