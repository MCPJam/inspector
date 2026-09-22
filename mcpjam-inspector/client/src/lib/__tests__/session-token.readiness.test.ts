/**
 * The hosted bearer on the readiness routes — and, just as importantly, off
 * everything beside them.
 *
 * `/web/registry/*` shipped without a `HOSTED_AUTH_PATH_PREFIXES` entry and
 * every call went out unauthenticated, so this is the failure mode with
 * precedent. Readiness cannot use a prefix at all: its scope sits in the
 * MIDDLE of the path (`/api/v1/projects/{id}/readiness-runs`), and the prefix
 * that would cover it — `/api/v1/projects/` — would hand the user's bearer to
 * every project-scoped public-API route that ever ships.
 *
 * So the grant is a pattern, and the half of this file that matters most is
 * the second half: proof that the pattern stayed narrow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/apis/web/context", () => ({
  getApiAuthorizationHeader: vi.fn(async () => "Bearer hosted-bearer"),
}));

vi.mock("@/lib/convex-site-url", () => ({
  getConvexSiteUrl: () => "https://outstanding-fennec-304.convex.site",
}));

describe("authFetch bearer on directory-readiness routes", () => {
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
    "/api/v1/projects/proj_1/servers/srv_1/readiness-runs/claude",
    "/api/v1/projects/proj_1/servers/srv_1/readiness-runs/openai",
    "/api/v1/projects/proj_1/readiness-runs",
    "/api/v1/projects/proj_1/readiness-runs/run_1",
    "/api/v1/projects/proj_1/readiness-runs/run_1/cancel",
    "/api/v1/projects/proj_1/readiness-runs/run_1/report",
  ]) {
    it(`attaches the bearer to ${path}`, async () => {
      await sessionToken.authFetch(path, { method: "POST" });
      expect(headersOf(0).Authorization).toBe("Bearer hosted-bearer");
    });
  }

  it("attaches it with a query string, which the list call always has", async () => {
    await sessionToken.authFetch(
      "/api/v1/projects/proj_1/readiness-runs?readinessKind=claude&limit=1",
      { method: "GET" },
    );
    expect(headersOf(0).Authorization).toBe("Bearer hosted-bearer");
  });

  for (const path of [
    // The blanket prefix this pattern exists to avoid: a sibling
    // project-scoped route must NOT inherit the UI's bearer.
    "/api/v1/projects/proj_1/servers/srv_1/tools",
    "/api/v1/projects/proj_1/evals",
    "/api/v1/projects/proj_1",
    // A path that merely starts the same way.
    "/api/v1/projects/proj_1/readiness-runs-export",
    // One segment too many under a run.
    "/api/v1/projects/proj_1/readiness-runs/run_1/report/raw",
    // The publisher is a closed set, not a wildcard.
    "/api/v1/projects/proj_1/servers/srv_1/readiness-runs/anthropic",
  ]) {
    it(`does NOT attach the bearer to ${path}`, async () => {
      await sessionToken.authFetch(path, { method: "POST" });
      expect(headersOf(0).Authorization).toBeUndefined();
    });
  }

  it("does not attach the bearer to a foreign origin on a readiness path", async () => {
    await sessionToken.authFetch(
      "https://evil.example.com/api/v1/projects/proj_1/readiness-runs",
      { method: "GET" },
    );
    expect(headersOf(0).Authorization).toBeUndefined();
  });
});
