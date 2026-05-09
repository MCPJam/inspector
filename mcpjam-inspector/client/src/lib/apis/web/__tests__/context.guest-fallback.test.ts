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

  it("prefers guest token for chatbox guests without calling WorkOS", async () => {
    const getAccessToken = vi
      .fn()
      .mockResolvedValue("workos-token-should-skip");
    setApiContext({
      projectId: "ws-chatbox",
      isAuthenticated: false,
      serverIdsByName: { bench: "srv-1" },
      getAccessToken,
      chatboxToken: "chatbox_tok_123",
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-chatbox");

    const result = await getApiAuthorizationHeader();

    expect(result).toBe("Bearer guest-chatbox");
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("does not fall back to a guest token while an AuthKit session is resolving", async () => {
    const getAccessToken = vi.fn().mockResolvedValue(null);
    setApiContext({
      projectId: null,
      isAuthenticated: false,
      hasSession: true,
      serverIdsByName: {},
      getAccessToken,
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-despite-session");

    const result = await getApiAuthorizationHeader();

    expect(result).toBeNull();
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(getGuestBearerToken).not.toHaveBeenCalled();
  });

  it("prefers guest token for guest-owned projects (unauthed + projectId, no share/chatbox)", async () => {
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

  it("buildServerRequest uses project path for chatbox guests", () => {
    setApiContext({
      projectId: "ws-chatbox",
      isAuthenticated: false,
      chatboxToken: "chatbox_tok_123",
      serverIdsByName: { "my-server": "srv-1" },
    });

    const result = buildServerRequest("my-server");

    expect(result).toMatchObject({
      projectId: "ws-chatbox",
      serverId: "srv-1",
      serverName: "my-server",
      chatboxToken: "chatbox_tok_123",
    });
  });
});
