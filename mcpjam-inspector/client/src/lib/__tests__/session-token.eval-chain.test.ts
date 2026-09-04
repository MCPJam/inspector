/**
 * The hosted bearer on the Evaluate (New) chain reads — and, just as
 * importantly, off everything beside them.
 *
 * Third instance of one failure mode: `/web/registry/*` shipped with no
 * `HOSTED_AUTH_PATH_PREFIXES` entry, readiness needed a pattern because its
 * scope sits mid-path, and then D9's decision summary and D5c's stage
 * analytics shipped with neither. All three go out through `authFetch`, which
 * is the ONE owner of the bearer, so a route the list does not name sends no
 * `Authorization` at all and the API answers "Bearer token required".
 *
 * That 401 is what makes this worth pinning rather than eyeballing: both
 * panels render it as service copy ("could not be loaded"), which reads as a
 * backend outage. The API is fine; the header never left the browser.
 *
 * As with readiness, the half of this file that matters most is the second
 * half — proof the grant stayed as narrow as the id segments in the middle,
 * rather than becoming the `/api/v1/projects/` prefix nobody wants.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/apis/web/context", () => ({
  getApiAuthorizationHeader: vi.fn(async () => "Bearer hosted-bearer"),
}));

vi.mock("@/lib/convex-site-url", () => ({
  getConvexSiteUrl: () => "https://outstanding-fennec-304.convex.site",
}));

describe("authFetch bearer on the eval chain routes", () => {
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
    // D9 — the canonical decision summary the run view renders.
    "/api/v1/projects/proj_1/eval-runs/run_1/decision-summary",
    // D5c — stage analytics, both the suite page and the run-scoped reader.
    "/api/v1/projects/proj_1/eval-suites/suite_1/stage-analytics",
    "/api/v1/projects/proj_1/eval-runs/run_1/stage-analytics",
    // The per-trial chains: one page of iterations, each carrying its own
    // stage rows. MOVED here from the negative list below — it was correctly
    // pinned as unreachable until a reader needed it, and the entry it now
    // requires is the one that would otherwise 401 as "could not be loaded".
    "/api/v1/projects/proj_1/eval-runs/run_1/iterations",
    // What changed since the previous run.
    "/api/v1/projects/proj_1/eval-runs/run_1/compare",
  ]) {
    it(`attaches the bearer to ${path}`, async () => {
      await sessionToken.authFetch(path, { method: "GET" });
      expect(headersOf(0).Authorization).toBe("Bearer hosted-bearer");
    });
  }

  it("attaches it with a query string, which both paged reads carry", async () => {
    await sessionToken.authFetch(
      "/api/v1/projects/proj_1/eval-suites/suite_1/stage-analytics?limit=25&cursor=abc",
      { method: "GET" },
    );
    expect(headersOf(0).Authorization).toBe("Bearer hosted-bearer");
  });

  for (const path of [
    // The blanket prefix these patterns exist to avoid: a sibling
    // project-scoped route must NOT inherit the UI's bearer.
    "/api/v1/projects/proj_1/eval-runs/run_1",
    "/api/v1/projects/proj_1/eval-suites/suite_1",
    "/api/v1/projects/proj_1/eval-suites/suite_1/runs",
    // Paths that merely start the same way.
    "/api/v1/projects/proj_1/eval-runs/run_1/decision-summary-export",
    "/api/v1/projects/proj_1/eval-suites/suite_1/stage-analytics-raw",
    // One segment too many under either read.
    "/api/v1/projects/proj_1/eval-runs/run_1/decision-summary/page/2",
    "/api/v1/projects/proj_1/eval-suites/suite_1/stage-analytics/overall",
    // The run-scoped suffix is a closed set, not a wildcard.
    "/api/v1/projects/proj_1/eval-runs/run_1/insights",
    // Granting the iterations LIST must not grant what hangs beneath it. A
    // trace is a transcript and steps are authored results; both are read by
    // other paths with their own auth, and a pattern that swallowed them
    // would be the blanket prefix these tests exist to catch.
    "/api/v1/projects/proj_1/eval-runs/run_1/iterations/iter_1/trace",
    "/api/v1/projects/proj_1/eval-runs/run_1/iterations/iter_1",
    "/api/v1/projects/proj_1/eval-runs/run_1/steps",
    // Same narrowness for the compare read: the literal segment only.
    "/api/v1/projects/proj_1/eval-runs/run_1/compare-export",
    "/api/v1/projects/proj_1/eval-runs/run_1/compare/cases",
    // The suite's revision history is an AGENT read. The app reads the same
    // history through Convex (`testSuites:listSuiteRevisions`), so allowlisting
    // this route would widen the UI bearer's reach for nothing the app uses.
    "/api/v1/projects/proj_1/eval-suites/suite_1/revisions",
  ]) {
    it(`does NOT attach the bearer to ${path}`, async () => {
      await sessionToken.authFetch(path, { method: "GET" });
      expect(headersOf(0).Authorization).toBeUndefined();
    });
  }

  it("does not attach the bearer to a foreign origin on a chain path", async () => {
    await sessionToken.authFetch(
      "https://evil.example.com/api/v1/projects/proj_1/eval-runs/run_1/decision-summary",
      { method: "GET" },
    );
    expect(headersOf(0).Authorization).toBeUndefined();
  });
});
