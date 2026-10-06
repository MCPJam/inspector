/**
 * The stdio command approval route (PLB-192) re-reads the server row through
 * Convex with the caller's bearer, so `authFetch` must attach it the same way
 * it does for `/api/mcp/connect` and `/api/mcp/servers/reconnect`. The first
 * live pass shipped it without a `HOSTED_AUTH_PATH_PREFIXES` entry: the dialog
 * opened, Allow answered 401, and the connect failed with a generic error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/apis/web/context", () => ({
  getApiAuthorizationHeader: vi.fn(async () => "Bearer hosted-bearer"),
}));

describe("authFetch hosted bearer on the stdio approval route", () => {
  let sessionToken: typeof import("../session-token");

  beforeEach(async () => {
    vi.resetModules();
    delete (window as any).__MCP_SESSION_TOKEN__;
    vi.mocked(global.fetch).mockReset();
    vi.mocked(global.fetch).mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    sessionToken = await import("../session-token");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function headersOf(call: number): Record<string, string> {
    const init = vi.mocked(global.fetch).mock.calls[call]?.[1] as RequestInit;
    return (init?.headers ?? {}) as Record<string, string>;
  }

  for (const path of [
    "/api/mcp/servers/reconnect",
    "/api/mcp/servers/approve-command",
  ]) {
    it(`attaches the bearer to ${path}`, async () => {
      await sessionToken.authFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      expect(headersOf(0).Authorization).toBe("Bearer hosted-bearer");
    });
  }
});
