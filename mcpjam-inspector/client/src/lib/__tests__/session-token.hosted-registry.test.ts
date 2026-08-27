/**
 * Regression coverage for the hosted bearer on absolute Convex HTTP action
 * URLs. `/web/registry/*` shipped without a `HOSTED_AUTH_PATH_PREFIXES` entry,
 * so every catalog/star call went out unauthenticated and the Convex handler
 * answered 401 "Missing or invalid bearer token".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/apis/web/context", () => ({
  getApiAuthorizationHeader: vi.fn(async () => "Bearer hosted-bearer"),
}));

vi.mock("@/lib/convex-site-url", () => ({
  getConvexSiteUrl: () => "https://outstanding-fennec-304.convex.site",
}));

const CONVEX_SITE = "https://outstanding-fennec-304.convex.site";

describe("authFetch hosted bearer on Convex HTTP actions", () => {
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
    "/web/registry/catalog",
    "/web/registry/star",
    "/web/registry/unstar",
    "/web/registry/merge-guest-stars",
  ]) {
    it(`attaches the bearer to ${path}`, async () => {
      await sessionToken.authFetch(`${CONVEX_SITE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      expect(headersOf(0).Authorization).toBe("Bearer hosted-bearer");
    });
  }

  it("does not attach the bearer to a foreign origin on the same path", async () => {
    await sessionToken.authFetch(
      "https://evil.example.com/web/registry/catalog",
      { method: "POST" },
    );

    expect(headersOf(0).Authorization).toBeUndefined();
  });
});
