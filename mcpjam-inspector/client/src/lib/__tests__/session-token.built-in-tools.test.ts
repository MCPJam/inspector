/**
 * The hosted bearer on MCPJam's built-in tool definitions — and off everything
 * beside them.
 *
 * The fourth instance of one failure mode, and the first where it was INVISIBLE.
 * `/api/v1/*` gets the user's bearer only from a path-by-path allowlist, so a
 * route the list does not name ships no `Authorization` at all and the API
 * answers "Bearer token required". The eval-chain reads at least rendered that
 * 401 as service copy; this one is read by a panel that soft-fails an
 * unreachable catalog to "no tools", so the Browser section simply never
 * appeared — a feature that looked unbuilt rather than unauthorized.
 *
 * The second half is the half that matters over time: proof the grant stayed at
 * the built-in-tools catalog rather than becoming `/api/v1/`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/apis/web/context", () => ({
  getApiAuthorizationHeader: vi.fn(async () => "Bearer hosted-bearer"),
}));

vi.mock("@/lib/convex-site-url", () => ({
  getConvexSiteUrl: () => "https://outstanding-fennec-304.convex.site",
}));

describe("authFetch bearer on the built-in tool definitions", () => {
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

  it("attaches the bearer to the browser definitions", async () => {
    await sessionToken.authFetch("/api/v1/built-in-tools/browser/definitions", {
      method: "GET",
    });
    expect(headersOf(0).Authorization).toBe("Bearer hosted-bearer");
  });

  it("attaches it with the engine query the Tools panel sends", async () => {
    // The panel always sends one, so a rule that only matched the bare path
    // would pass a test and fail every real call.
    await sessionToken.authFetch(
      "/api/v1/built-in-tools/browser/definitions?engine=local",
      { method: "GET" },
    );
    expect(headersOf(0).Authorization).toBe("Bearer hosted-bearer");
  });

  for (const path of [
    // Paths that merely start the same way — the boundary is `/`.
    "/api/v1/built-in-toolsets/browser/definitions",
    "/api/v1/built-in-tools-catalog",
    // A sibling public-API surface must not inherit the UI's bearer just
    // because this one needed it.
    "/api/v1/projects/proj_1/servers",
    "/api/v1/clients",
  ]) {
    it(`does NOT attach the bearer to ${path}`, async () => {
      await sessionToken.authFetch(path, { method: "GET" });
      expect(headersOf(0).Authorization).toBeUndefined();
    });
  }

  it("does not attach the bearer to a foreign origin on this path", async () => {
    // The exfiltration guard: a path match is not enough, the origin has to be
    // ours. Otherwise an absolute URL that merely looks right takes the token.
    await sessionToken.authFetch(
      "https://evil.example.com/api/v1/built-in-tools/browser/definitions",
      { method: "GET" },
    );
    expect(headersOf(0).Authorization).toBeUndefined();
  });
});
