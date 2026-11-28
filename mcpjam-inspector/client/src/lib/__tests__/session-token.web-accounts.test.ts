/**
 * The hosted bearer on the web account routes, and off the local connector
 * routes beside them. Without it a hosted sign-in answered 401 and no browser
 * opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/apis/web/context", () => ({
  getApiAuthorizationHeader: vi.fn(async () => "Bearer hosted-bearer"),
}));

vi.mock("@/lib/convex-site-url", () => ({
  getConvexSiteUrl: () => "https://outstanding-fennec-304.convex.site",
}));

describe("authFetch bearer on the web account routes", () => {
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

  function authorizationOf(call: number): string | undefined {
    const init = vi.mocked(global.fetch).mock.calls[call]?.[1] as RequestInit;
    return ((init?.headers ?? {}) as Record<string, string>).Authorization;
  }

  for (const path of [
    "/api/web-clients/accounts/acc_1/sign-in",
    "/api/web-clients/accounts/acc_1/save-profile",
    "/api/web-clients/reconnect/req_1/handback",
  ]) {
    it(`attaches the bearer to ${path}`, async () => {
      await sessionToken.authFetch(path, { method: "POST", body: "{}" });
      expect(authorizationOf(0)).toBe("Bearer hosted-bearer");
    });
  }

  it("does NOT attach it to the local connector routes", async () => {
    await sessionToken.authFetch("/api/web-clients/local-connectors", {
      method: "POST",
      body: "{}",
    });
    expect(authorizationOf(0)).toBeUndefined();
  });

  it("does not attach it to a foreign origin on the same path", async () => {
    await sessionToken.authFetch(
      "https://evil.example.com/api/web-clients/accounts/acc_1/sign-in",
      { method: "POST", body: "{}" },
    );
    expect(authorizationOf(0)).toBeUndefined();
  });
});
