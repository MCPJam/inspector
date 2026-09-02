import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/guest-session", () => ({
  getGuestBearerToken: vi.fn(),
}));

import { getGuestBearerToken } from "@/lib/guest-session";
import {
  getApiAuthorizationHeader,
  setApiContext,
  buildServerRequest,
} from "../context";

describe("getApiAuthorizationHeader guest fallback", () => {
  beforeEach(() => {
    setApiContext(null);
    vi.mocked(getGuestBearerToken).mockReset();
  });

  afterEach(() => {
    setApiContext(null);
    vi.restoreAllMocks();
  });

  it("returns WorkOS token when getAccessToken succeeds", async () => {
    setApiContext({
      projectId: "ws-1",
      serverIdsByName: {},
      getAccessToken: () => Promise.resolve("workos-token-abc"),
      isAuthenticated: true,
    });

    const result = await getApiAuthorizationHeader();

    expect(result).toBe("Bearer workos-token-abc");
    expect(getGuestBearerToken).not.toHaveBeenCalled();
  });

  it("prefers guest token for direct guest mode without calling WorkOS", async () => {
    const getAccessToken = vi
      .fn()
      .mockResolvedValue("workos-token-should-skip");
    setApiContext({
      projectId: null,
      isAuthenticated: false,
      serverIdsByName: {},
      getAccessToken,
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-direct");

    const result = await getApiAuthorizationHeader();

    expect(result).toBe("Bearer guest-direct");
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("prefers guest token for scenario guests without calling WorkOS", async () => {
    const getAccessToken = vi
      .fn()
      .mockResolvedValue("workos-token-should-skip");
    setApiContext({
      projectId: "ws-scenario",
      isAuthenticated: false,
      serverIdsByName: { bench: "srv-1" },
      getAccessToken,
      scenarioId: "cbx_123",
      accessVersion: 1,
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-scenario");

    const result = await getApiAuthorizationHeader();

    expect(result).toBe("Bearer guest-scenario");
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("does not fall back to a guest token while an AuthKit session is resolving", async () => {
    vi.useFakeTimers();
    const getAccessToken = vi.fn().mockResolvedValue(null);
    setApiContext({
      projectId: null,
      isAuthenticated: false,
      hasSession: true,
      serverIdsByName: {},
      getAccessToken,
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-despite-session");

    const pending = getApiAuthorizationHeader();
    // Past the wait budget: a session whose token never arrives still resolves
    // to null rather than borrowing a guest bearer.
    await vi.advanceTimersByTimeAsync(4_000);

    expect(await pending).toBeNull();
    expect(getGuestBearerToken).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("waits for an AuthKit token that is still resolving instead of firing bearer-less", async () => {
    // The Describe-step 401: `getAccessToken()` answers null for the first tick
    // of a bootstrap/refresh, and the old code returned null immediately — so
    // authFetch sent a `/api/web/*` request with no Authorization header and
    // `bearerAuthMiddleware` answered "Bearer token required". Nothing retried
    // it, because a resolving session must not be swapped for a guest bearer.
    vi.useFakeTimers();
    const getAccessToken = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue("workos-token-late");
    setApiContext({
      projectId: null,
      isAuthenticated: false,
      hasSession: true,
      serverIdsByName: {},
      getAccessToken,
    });

    const pending = getApiAuthorizationHeader();
    await vi.advanceTimersByTimeAsync(300);

    expect(await pending).toBe("Bearer workos-token-late");
    expect(getGuestBearerToken).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("stops waiting once a throwing session resolves to a guest", async () => {
    // `getAccessToken` throwing is AuthKit's LoginRequiredError. If the actor
    // turns out to be a guest while we wait, the wait must hand back rather
    // than burn its whole budget on a token that is not coming.
    vi.useFakeTimers();
    const getAccessToken = vi
      .fn()
      .mockRejectedValue(new Error("LoginRequiredError"));
    setApiContext({
      projectId: null,
      isAuthenticated: false,
      hasSession: true,
      serverIdsByName: {},
      getAccessToken,
    });

    const pending = getApiAuthorizationHeader();
    await vi.advanceTimersByTimeAsync(150);
    setApiContext({
      projectId: null,
      isAuthenticated: false,
      hasSession: false,
      serverIdsByName: {},
      getAccessToken,
    });
    await vi.advanceTimersByTimeAsync(150);

    expect(await pending).toBeNull();

    vi.useRealTimers();
  });

  it("prefers guest token for guest-owned projects (unauthed + projectId, no share/scenario)", async () => {
    // Pre-"guests are users" this case returned null because a set projectId
    // was treated as proof of an authed session. Guests can now own projects,
    // so this path must surface a guest bearer.
    const getAccessToken = vi
      .fn()
      .mockResolvedValue("workos-token-should-skip");
    setApiContext({
      projectId: "ws-guest-owned",
      isAuthenticated: false,
      serverIdsByName: { bench: "srv-1" },
      getAccessToken,
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-owns-project");

    const result = await getApiAuthorizationHeader();

    expect(result).toBe("Bearer guest-owns-project");
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("caches WorkOS token and does not call guest on subsequent calls", async () => {
    const getAccessToken = vi.fn().mockResolvedValue("cached-workos");
    setApiContext({
      projectId: "ws-1",
      serverIdsByName: {},
      getAccessToken,
      isAuthenticated: true,
    });

    const result1 = await getApiAuthorizationHeader();
    const result2 = await getApiAuthorizationHeader();

    expect(result1).toBe("Bearer cached-workos");
    expect(result2).toBe("Bearer cached-workos");
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(getGuestBearerToken).not.toHaveBeenCalled();
  });

  it("does not reuse a cached guest bearer after sign-in", async () => {
    setApiContext({
      projectId: "ws-guest-owned",
      isAuthenticated: false,
      serverIdsByName: {},
    });
    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-stale");

    const guestResult = await getApiAuthorizationHeader();
    expect(guestResult).toBe("Bearer guest-stale");
    expect(getGuestBearerToken).toHaveBeenCalledTimes(1);

    // No `resetTokenCache` spy here: `setApiContext` calls it through the
    // module's own binding, so a namespace spy never takes effect. The real
    // reset runs, and the assertions below hold on that behavior.
    const getAccessToken = vi.fn().mockResolvedValue("workos-after-sign-in");
    setApiContext({
      projectId: "ws-guest-owned",
      serverIdsByName: {},
      getAccessToken,
      isAuthenticated: true,
    });

    const signedInResult = await getApiAuthorizationHeader();

    expect(signedInResult).toBe("Bearer workos-after-sign-in");
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(getGuestBearerToken).toHaveBeenCalledTimes(1);
  });

  it("does not hand back a guest token minted for an actor that just signed in", async () => {
    // Guest mode at the start; the sign-in lands while the guest bearer
    // lookup is still in flight.
    setApiContext({
      projectId: null,
      isAuthenticated: false,
      serverIdsByName: {},
    });

    const getAccessToken = vi.fn().mockResolvedValue("workos-after-switch");
    vi.mocked(getGuestBearerToken).mockImplementationOnce(async () => {
      setApiContext({
        projectId: "ws-1",
        serverIdsByName: {},
        getAccessToken,
        isAuthenticated: true,
      });
      return "guest-from-previous-actor";
    });

    const result = await getApiAuthorizationHeader();

    expect(result).toBe("Bearer workos-after-switch");
    // And the stale guest token was not cached for the next caller either.
    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-should-not-be-used");
    expect(await getApiAuthorizationHeader()).toBe("Bearer workos-after-switch");
  });

  it("re-evaluates guest token after cache expiry", async () => {
    vi.useFakeTimers();

    setApiContext({
      projectId: null,
      isAuthenticated: false,
      serverIdsByName: {},
    });

    vi.mocked(getGuestBearerToken).mockResolvedValueOnce("guest-1");
    vi.mocked(getGuestBearerToken).mockResolvedValueOnce("guest-2");

    const result1 = await getApiAuthorizationHeader();
    expect(result1).toBe("Bearer guest-1");

    vi.advanceTimersByTime(30_001);

    const result2 = await getApiAuthorizationHeader();
    expect(result2).toBe("Bearer guest-2");

    vi.useRealTimers();
  });
});

describe("guest-owned project request building", () => {
  beforeEach(() => {
    setApiContext(null);
  });

  afterEach(() => {
    setApiContext(null);
  });

  it("buildServerRequest throws BootstrapNotReadyError when projectId is missing", async () => {
    setApiContext({
      projectId: null,
      isAuthenticated: false,
      hasSession: true,
      serverIdsByName: {},
    });

    const { BootstrapNotReadyError } = await import("@/lib/app-ready");
    expect(() => buildServerRequest("my-server")).toThrow(
      BootstrapNotReadyError,
    );
  });

  it("buildServerRequest uses project path for scenario guests", () => {
    setApiContext({
      projectId: "ws-scenario",
      isAuthenticated: false,
      scenarioId: "cbx_123",
      accessVersion: 1,
      serverIdsByName: { "my-server": "srv-1" },
    });

    const result = buildServerRequest("my-server");

    expect(result).toMatchObject({
      projectId: "ws-scenario",
      serverId: "srv-1",
      serverName: "my-server",
      scenarioId: "cbx_123",
      accessVersion: 1,
    });
  });
});
