import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/config", () => ({ HOSTED_MODE: false }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/guest-session", () => ({
  getGuestBearerToken: vi.fn(),
  forceRefreshGuestSession: vi.fn(),
}));
vi.mock("@/lib/apis/web/context", () => ({
  getApiAuthorizationHeader: vi.fn(),
  resetTokenCache: vi.fn(),
  shouldRetryApiAuth401: vi.fn(() => false),
}));
const oldToken = "old-access-token-long-enough";
const newToken = "new-access-token-long-enough";
const response = (status: number, body: unknown, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });
let auth: typeof import("../session-token");
beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  vi.mocked(fetch).mockReset();
  localStorage.setItem("mcpjam.local-access", oldToken);
  auth = await import("../session-token");
  vi.mocked(fetch).mockResolvedValueOnce(response(200, { ok: true }));
  await auth.initializeSessionToken();
  vi.mocked(fetch).mockReset();
});
afterEach(() => vi.restoreAllMocks());
describe("local credential recovery", () => {
  it("re-reads a newer link from another tab and retries once", async () => {
    localStorage.setItem("mcpjam.local-access", newToken);
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response(401, {}, { "X-MCPJam-Session": "invalid" }),
      )
      .mockResolvedValueOnce(response(200, { ok: true }))
      .mockResolvedValueOnce(response(200, { result: true }));
    expect((await auth.authFetch("/api/mcp/tools/list")).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls[2][1]?.headers).toMatchObject({
      "X-MCP-Session-Auth": `Bearer ${newToken}`,
    });
  });
  it.each([{}, { "X-MCP-Auth-Required": "oauth" }])(
    "does not refresh an upstream 401 (%j)",
    async (headers) => {
      vi.mocked(fetch).mockResolvedValueOnce(response(401, {}, headers));
      expect((await auth.authFetch("/api/mcp/tools/list")).status).toBe(401);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("shows the access screen when the old credential is rejected", async () => {
    const listener = vi.fn();
    window.addEventListener("mcpjam:access-required", listener);
    try {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          response(401, {}, { "X-MCPJam-Session": "invalid" }),
        )
        .mockResolvedValueOnce(response(401, { code: "ACCESS_LINK_REQUIRED" }));
      expect((await auth.authFetch("/api/mcp/tools/list")).status).toBe(401);
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("mcpjam:access-required", listener);
    }
  });
  it("does not replay a mutation when credential confirmation fails", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response(401, {}, { "X-MCPJam-Session": "invalid" }),
      )
      .mockResolvedValueOnce(response(500, {}));
    await auth.authFetch("/api/mcp/connect", { method: "POST", body: "{}" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
