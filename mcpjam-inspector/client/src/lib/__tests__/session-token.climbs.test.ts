/**
 * The hosted bearer on the Climb tab's and the mock sheet's routes, and off
 * everything beside them.
 *
 * Both screens call `/api/v1/projects/{projectId}/climbs…` and
 * `…/mock-servers…` through `authFetch`, which attaches the bearer only to
 * paths its list names. Without these entries every call answered "Bearer
 * token required" on a running build (found in QA, stage 3), while the tests
 * that mock the client stayed green.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/apis/web/context", () => ({
  getApiAuthorizationHeader: vi.fn(async () => "Bearer hosted-bearer"),
}));

vi.mock("@/lib/convex-site-url", () => ({
  getConvexSiteUrl: () => "https://outstanding-fennec-304.convex.site",
}));

describe("authFetch bearer on the climb and mock server routes", () => {
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
    // Start and list.
    "/api/v1/projects/proj_1/climbs",
    // Read, and change what the climb is for.
    "/api/v1/projects/proj_1/climbs/climb_1",
    // Submit a round, read one, overrule it.
    "/api/v1/projects/proj_1/climbs/climb_1/rounds",
    "/api/v1/projects/proj_1/climbs/climb_1/rounds/2",
    "/api/v1/projects/proj_1/climbs/climb_1/rounds/2/decision",
    // The climb's own actions.
    "/api/v1/projects/proj_1/climbs/climb_1/stop",
    "/api/v1/projects/proj_1/climbs/climb_1/confirmation",
    "/api/v1/projects/proj_1/climbs/climb_1/draft",
    "/api/v1/projects/proj_1/climbs/climb_1/continue",
    "/api/v1/projects/proj_1/climbs/climb_1/verifications",
    // The mock sheet.
    "/api/v1/projects/proj_1/mock-servers",
    "/api/v1/projects/proj_1/mock-servers/mock_1",
    "/api/v1/projects/proj_1/mock-servers/mock_1/versions",
  ]) {
    it(`attaches the bearer to ${path}`, async () => {
      await sessionToken.authFetch(path, { method: "GET" });
      expect(headersOf(0).Authorization).toBe("Bearer hosted-bearer");
    });
  }

  it("attaches it with a query string", async () => {
    await sessionToken.authFetch(
      "/api/v1/projects/proj_1/climbs?suiteId=suite_1&limit=20",
      { method: "GET" },
    );
    expect(headersOf(0).Authorization).toBe("Bearer hosted-bearer");
  });

  for (const path of [
    // The sibling the patterns must not become.
    "/api/v1/projects/proj_1/servers",
    // Paths that merely start the same way.
    "/api/v1/projects/proj_1/climbs-export",
    "/api/v1/projects/proj_1/mock-servers-export",
    // The climb's suffix is a closed set.
    "/api/v1/projects/proj_1/climbs/climb_1/runs",
    "/api/v1/projects/proj_1/climbs/climb_1/stop/all",
    // A round number is digits, and nothing hangs beneath a decision.
    "/api/v1/projects/proj_1/climbs/climb_1/rounds/two",
    "/api/v1/projects/proj_1/climbs/climb_1/rounds/2/decision/undo",
    // Nothing hangs beneath a mock's versions or beside them.
    "/api/v1/projects/proj_1/mock-servers/mock_1/versions/3",
    "/api/v1/projects/proj_1/mock-servers/mock_1/answers",
  ]) {
    it(`does NOT attach the bearer to ${path}`, async () => {
      await sessionToken.authFetch(path, { method: "GET" });
      expect(headersOf(0).Authorization).toBeUndefined();
    });
  }

  it("does not attach the bearer to a foreign origin on a climb path", async () => {
    await sessionToken.authFetch(
      "https://evil.example.com/api/v1/projects/proj_1/climbs/climb_1",
      { method: "GET" },
    );
    expect(headersOf(0).Authorization).toBeUndefined();
  });
});
