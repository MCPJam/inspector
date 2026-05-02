import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/guest-session", () => ({
  getGuestBearerToken: vi.fn(),
}));

import { getGuestBearerToken } from "@/lib/guest-session";
import {
  getHostedAuthorizationHeader,
  setHostedApiContext,
  isGuestMode,
  buildHostedServerRequest,
  buildGuestServerRequest,
} from "../context";

describe("getHostedAuthorizationHeader guest fallback", () => {
  beforeEach(() => {
    setHostedApiContext(null);
    vi.mocked(getGuestBearerToken).mockReset();
  });

  afterEach(() => {
    setHostedApiContext(null);
    vi.restoreAllMocks();
  });

  it("returns WorkOS token when getAccessToken succeeds", async () => {
    setHostedApiContext({
      projectId: "ws-1",
      serverIdsByName: {},
      getAccessToken: () => Promise.resolve("workos-token-abc"),
      isAuthenticated: true,
    });

    const result = await getHostedAuthorizationHeader();

    expect(result).toBe("Bearer workos-token-abc");
    expect(getGuestBearerToken).not.toHaveBeenCalled();
  });

  it("prefers guest token for direct guest mode without calling WorkOS", async () => {
    const getAccessToken = vi
      .fn()
      .mockResolvedValue("workos-token-should-skip");
    setHostedApiContext({
      projectId: null,
      isAuthenticated: false,
      serverIdsByName: {},
      getAccessToken,
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-direct");

    const result = await getHostedAuthorizationHeader();

    expect(result).toBe("Bearer guest-direct");
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("prefers guest token for shared guests without calling WorkOS", async () => {
    const getAccessToken = vi
      .fn()
      .mockResolvedValue("workos-token-should-skip");
    setHostedApiContext({
      projectId: "ws-shared",
      isAuthenticated: false,
      serverIdsByName: { bench: "srv-1" },
      getAccessToken,
      shareToken: "share_tok_123",
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-shared");

    const result = await getHostedAuthorizationHeader();

    expect(result).toBe("Bearer guest-shared");
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("prefers guest token for chatbox guests without calling WorkOS", async () => {
    const getAccessToken = vi
      .fn()
      .mockResolvedValue("workos-token-should-skip");
    setHostedApiContext({
      projectId: "ws-chatbox",
      isAuthenticated: false,
      serverIdsByName: { bench: "srv-1" },
      getAccessToken,
      chatboxToken: "chatbox_tok_123",
    });

    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-chatbox");

    const result = await getHostedAuthorizationHeader();

    expect(result).toBe("Bearer guest-chatbox");
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("still prefers guest token when no project is loaded but AuthKit session exists", async () => {
    const getAccessToken = vi
      .fn()
      .mockResolvedValue("workos-token-should-skip");
    setHostedApiContext({
      projectId: null,
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

  it("returns null for hosted project requests that do not allow guest access", async () => {
    const getAccessToken = vi
      .fn()
      .mockRejectedValue(new Error("LoginRequired"));
    setHostedApiContext({
      projectId: "ws-member",
      isAuthenticated: false,
      serverIdsByName: { bench: "srv-1" },
      getAccessToken,
    });

    const result = await getHostedAuthorizationHeader();

    expect(result).toBeNull();
    expect(getGuestBearerToken).not.toHaveBeenCalled();
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("caches WorkOS token and does not call guest on subsequent calls", async () => {
    const getAccessToken = vi.fn().mockResolvedValue("cached-workos");
    setHostedApiContext({
      projectId: "ws-1",
      serverIdsByName: {},
      getAccessToken,
      isAuthenticated: true,
    });

    const result1 = await getHostedAuthorizationHeader();
    const result2 = await getHostedAuthorizationHeader();

    expect(result1).toBe("Bearer cached-workos");
    expect(result2).toBe("Bearer cached-workos");
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(getGuestBearerToken).not.toHaveBeenCalled();
  });

  it("re-evaluates guest token after cache expiry", async () => {
    vi.useFakeTimers();

    setHostedApiContext({
      projectId: null,
      isAuthenticated: false,
      serverIdsByName: {},
    });

    vi.mocked(getGuestBearerToken).mockResolvedValueOnce("guest-1");
    vi.mocked(getGuestBearerToken).mockResolvedValueOnce("guest-2");

    const result1 = await getHostedAuthorizationHeader();
    expect(result1).toBe("Bearer guest-1");

    vi.advanceTimersByTime(30_001);

    const result2 = await getHostedAuthorizationHeader();
    expect(result2).toBe("Bearer guest-2");

    vi.useRealTimers();
  });
});

describe("isGuestMode and buildHostedServerRequest consistency", () => {
  beforeEach(() => {
    setHostedApiContext(null);
  });

  afterEach(() => {
    setHostedApiContext(null);
  });

  it("isGuestMode returns true for direct guests (no project, not authenticated)", () => {
    setHostedApiContext({
      projectId: null,
      isAuthenticated: false,
      serverIdsByName: {},
    });

    expect(isGuestMode()).toBe(true);
  });

  it("isGuestMode returns false for shared guests (has project + shareToken)", () => {
    setHostedApiContext({
      projectId: "ws-shared",
      isAuthenticated: false,
      shareToken: "share_tok_123",
      serverIdsByName: { bench: "srv-1" },
    });

    expect(isGuestMode()).toBe(false);
  });

  it("isGuestMode returns false for authenticated users", () => {
    setHostedApiContext({
      projectId: "ws-1",
      isAuthenticated: true,
      serverIdsByName: {},
    });

    expect(isGuestMode()).toBe(false);
  });

  it("buildHostedServerRequest uses guest path for direct guests with server config", () => {
    setHostedApiContext({
      projectId: null,
      isAuthenticated: false,
      serverIdsByName: {},
      serverConfigs: {
        "my-server": { url: "https://my-mcp.example.com/sse" },
      },
    });

    const result = buildHostedServerRequest("my-server");

    expect(result).toMatchObject({
      serverUrl: "https://my-mcp.example.com/sse",
      serverName: "my-server",
    });
    // Should NOT have projectId — this is a guest request
    expect(result).not.toHaveProperty("projectId");
  });

  it("buildHostedServerRequest uses project path for shared guests", () => {
    setHostedApiContext({
      projectId: "ws-shared",
      isAuthenticated: false,
      shareToken: "share_tok_123",
      serverIdsByName: { "my-server": "srv-1" },
    });

    const result = buildHostedServerRequest("my-server");

    expect(result).toMatchObject({
      projectId: "ws-shared",
      serverId: "srv-1",
      serverName: "my-server",
      shareToken: "share_tok_123",
    });
  });

  it("buildHostedServerRequest uses project path for chatbox guests", () => {
    setHostedApiContext({
      projectId: "ws-chatbox",
      isAuthenticated: false,
      chatboxToken: "chatbox_tok_123",
      serverIdsByName: { "my-server": "srv-1" },
    });

    const result = buildHostedServerRequest("my-server");

    expect(result).toMatchObject({
      projectId: "ws-chatbox",
      serverId: "srv-1",
      serverName: "my-server",
      chatboxToken: "chatbox_tok_123",
    });
  });

  it("buildHostedServerRequest throws for direct guests without server config", () => {
    setHostedApiContext({
      projectId: null,
      isAuthenticated: false,
      serverIdsByName: {},
      serverConfigs: {},
    });

    expect(() => buildHostedServerRequest("unknown-server")).toThrow(
      /No guest server config found/,
    );
  });

  it("buildGuestServerRequest forwards explicit clientCapabilities overrides", () => {
    expect(
      buildGuestServerRequest(
        {
          url: "https://example.com/mcp",
        },
        undefined,
        {
          elicitation: {},
          experimental: { inspectorProfile: true },
        },
        "example-server",
      ),
    ).toEqual({
      serverUrl: "https://example.com/mcp",
      serverName: "example-server",
      clientCapabilities: {
        elicitation: {},
        experimental: { inspectorProfile: true },
      },
    });
  });
});
