/**
 * The hosted bearer on the Readiness page's reviewer sign-in routes, and off
 * every path beside them. Without it every attempt call there 401s unseen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/apis/web/context", () => ({
  getApiAuthorizationHeader: vi.fn(async () => "Bearer hosted-bearer"),
}));

vi.mock("@/lib/convex-site-url", () => ({
  getConvexSiteUrl: () => "https://outstanding-fennec-304.convex.site",
}));

const ATTEMPTS =
  "/api/v1/projects/proj_1/directory-submissions/sub_1/reviewer-attempts";

describe("authFetch bearer on reviewer sign-in attempts", () => {
  let sessionToken: typeof import("../session-token");

  beforeEach(async () => {
    vi.resetModules();
    vi.mocked(globalThis.fetch).mockReset();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    sessionToken = await import("../session-token");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function authorizationOf(call: number) {
    const init = vi.mocked(globalThis.fetch).mock.calls[call]?.[1];
    return new Headers(init?.headers).get("Authorization");
  }

  for (const path of [
    ATTEMPTS,
    `${ATTEMPTS}?limit=1`,
    `${ATTEMPTS}/att_1`,
    `${ATTEMPTS}/att_1/resume`,
    `${ATTEMPTS}/att_1/cancel`,
  ]) {
    it(`attaches the bearer to ${path}`, async () => {
      await sessionToken.authFetch(path, { method: "POST" });
      expect(authorizationOf(0)).toBe("Bearer hosted-bearer");
    });
  }

  for (const path of [
    // Another action, or one segment too many under an attempt.
    `${ATTEMPTS}/att_1/stages`,
    `${ATTEMPTS}/att_1/resume/now`,
    // A path that merely starts the same way.
    `${ATTEMPTS}-export`,
    // Attempts belong to one submission, never to the project.
    "/api/v1/projects/proj_1/reviewer-attempts",
  ]) {
    it(`does NOT attach the bearer to ${path}`, async () => {
      await sessionToken.authFetch(path, { method: "POST" });
      expect(authorizationOf(0)).toBeNull();
    });
  }
});
