import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ hosted: false }));
const getApiAuthorizationHeader = vi.hoisted(() =>
  vi.fn<() => Promise<string | null>>(),
);
vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return state.hosted;
  },
}));
vi.mock("@/lib/apis/web/context", () => ({
  getApiAuthorizationHeader,
  resetTokenCache: vi.fn(),
  shouldRetryApiAuth401: vi.fn(() => false),
}));
vi.mock("@/lib/convex-site-url", () => ({ getConvexSiteUrl: () => null }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { authFetch } from "../session-token";

function sentHeaders() {
  return new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers);
}

describe("local browser authentication across deployment modes", () => {
  beforeEach(() => {
    state.hosted = false;
    window.__MCP_SESSION_TOKEN__ = "local-session";
    getApiAuthorizationHeader
      .mockReset()
      .mockResolvedValue("Bearer account-token");
    vi.mocked(fetch).mockReset().mockResolvedValue(new Response("{}"));
  });

  afterEach(() => {
    delete window.__MCP_SESSION_TOKEN__;
    state.hosted = false;
  });

  it.each([
    ["status", "GET"],
    ["ensure", "POST"],
    ["sessions", "POST"],
    ["token", "POST"],
    ["page-tools", "POST"],
    ["profile/export", "POST"],
  ])("sends both credentials for local/Electron %s", async (path, method) => {
    await authFetch(`/api/mcp/computers/local-browser/${path}`, { method });
    expect(sentHeaders().get("Authorization")).toBe("Bearer account-token");
    expect(sentHeaders().get("X-MCP-Session-Auth")).toBe(
      "Bearer local-session",
    );
  });

  it("preserves consent and a caller-provided account credential", async () => {
    await authFetch("/api/mcp/computers/local-browser/ensure", {
      method: "POST",
      headers: {
        Authorization: "Bearer explicit",
        "X-MCPJam-Browser-Consent": "consent",
      },
    });
    expect(sentHeaders().get("Authorization")).toBe("Bearer explicit");
    expect(sentHeaders().get("X-MCPJam-Browser-Consent")).toBe("consent");
  });

  it("does not fabricate account credentials for an OSS client without a bearer", async () => {
    getApiAuthorizationHeader.mockResolvedValue(null);
    await authFetch("/api/mcp/computers/local-browser/status");
    expect(sentHeaders().get("Authorization")).toBeNull();
    expect(sentHeaders().get("X-MCP-Session-Auth")).toBe(
      "Bearer local-session",
    );
  });

  it("keeps hosted browser requests bearer-only", async () => {
    state.hosted = true;
    await authFetch("/api/web/computers/browser/status");
    expect(sentHeaders().get("Authorization")).toBe("Bearer account-token");
    expect(sentHeaders().get("X-MCP-Session-Auth")).toBeNull();
  });

  it.each([
    "/api/mcp/computers/local-browser-other/status",
    "/api/mcp/tools/list",
    "https://example.com/api/mcp/computers/local-browser/status",
  ])("does not attach account credentials to %s", async (path) => {
    await authFetch(path);
    expect(getApiAuthorizationHeader).not.toHaveBeenCalled();
    expect(sentHeaders().get("Authorization")).toBeNull();
    if (path.startsWith("https:")) {
      expect(sentHeaders().get("X-MCP-Session-Auth")).toBeNull();
    }
  });
});
