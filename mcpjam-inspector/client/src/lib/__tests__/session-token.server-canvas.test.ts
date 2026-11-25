/**
 * The server canvas's local routes check the rollout and authorize the
 * server with the caller's bearer, so `authFetch` must attach it to both the
 * Apps bridge observations route and Refresh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/apis/web/context", () => ({
  getApiAuthorizationHeader: vi.fn(async () => "Bearer hosted-bearer"),
}));

describe("authFetch bearer on the server canvas routes", () => {
  let sessionToken: typeof import("../session-token");

  beforeEach(async () => {
    vi.resetModules();
    vi.mocked(global.fetch).mockReset();
    vi.mocked(global.fetch).mockResolvedValue(
      new Response("{}", { status: 202 }),
    );
    sessionToken = await import("../session-token");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function authorizationOf(call: number): string | undefined {
    const init = vi.mocked(global.fetch).mock.calls[call]?.[1];
    return new Headers(init?.headers).get("Authorization") ?? undefined;
  }

  it.each([
    "/api/mcp/servers/canvas/refresh",
    "/api/mcp/server-features/observations",
  ])("attaches the bearer to %s", async (path) => {
    await sessionToken.authFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(authorizationOf(0)).toBe("Bearer hosted-bearer");
  });

  it.each([
    "/api/mcp/servers/canvas/refresh-all",
    "https://untrusted.example/api/mcp/servers/canvas/refresh",
  ])("does not attach the bearer to %s", async (path) => {
    await sessionToken.authFetch(path, { method: "POST" });
    expect(authorizationOf(0)).toBeUndefined();
  });
});
