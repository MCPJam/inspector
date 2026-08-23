import { beforeEach, describe, expect, it, vi } from "vitest";

const { getApiAuthorizationHeader } = vi.hoisted(() => ({
  getApiAuthorizationHeader: vi.fn(
    async (): Promise<string | null> => "Bearer workos-jwt"
  ),
}));

vi.mock("@/lib/config", () => ({ HOSTED_MODE: false }));
vi.mock("@/lib/apis/web/context", () => ({
  getApiAuthorizationHeader,
  resetTokenCache: vi.fn(),
  shouldRetryApiAuth401: vi.fn(() => false),
}));
vi.mock("@/lib/guest-session", () => ({
  forceRefreshGuestSession: vi.fn(),
}));
vi.mock("@/lib/convex-site-url", () => ({
  getConvexSiteUrl: vi.fn(() => null),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { authFetch } from "../session-token";

describe("authFetch local chat bearer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.__MCP_SESSION_TOKEN__ = "local-session";
    vi.mocked(global.fetch).mockReset();
    vi.mocked(global.fetch).mockResolvedValue(
      new Response("", { status: 200 })
    );
  });

  it("resolves and attaches the Convex bearer to /api/mcp/chat-v2", async () => {
    await authFetch("/api/mcp/chat-v2", { method: "POST" });

    expect(getApiAuthorizationHeader).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("/api/mcp/chat-v2", {
      method: "POST",
      headers: {
        "X-MCP-Session-Auth": "Bearer local-session",
        Authorization: "Bearer workos-jwt",
      },
    });
  });

  it("omits Authorization when bearer resolution returns empty", async () => {
    getApiAuthorizationHeader.mockResolvedValueOnce(null);

    await authFetch("/api/mcp/chat-v2", { method: "POST" });

    expect(global.fetch).toHaveBeenCalledWith("/api/mcp/chat-v2", {
      method: "POST",
      headers: {
        "X-MCP-Session-Auth": "Bearer local-session",
      },
    });
  });

  it("does not send when bearer resolution rejects", async () => {
    const error = new Error("bearer lookup failed");
    getApiAuthorizationHeader.mockRejectedValueOnce(error);

    await expect(
      authFetch("/api/mcp/chat-v2", { method: "POST" })
    ).rejects.toBe(error);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
