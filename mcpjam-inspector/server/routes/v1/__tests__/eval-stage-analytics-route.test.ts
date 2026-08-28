/**
 * `GET …/eval-suites/:suiteId/stage-analytics` — the read boundary, end to end.
 *
 * The claim under test is not "the route returns a body". It is that this route
 * is the only place a stage-analytics document crosses into the public API, and
 * that it refuses to launder anything on the way: a suite from another project
 * reads as NOT_FOUND, a payload that fails the CONTRACT is a service error
 * rather than a 200 with the bad row quietly dropped, and an inverted window is
 * a caller error rather than a silently empty page.
 *
 * So the Convex mock is stubbed BY FUNCTION NAME rather than by call order —
 * the route makes two reads and their order is an implementation detail — and
 * the populated fixtures are the SDK's shared golden document rather than a
 * local hand-copy, so a contract change breaks this test instead of drifting
 * past it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Hono } from "hono";
import { evalStageAnalyticsSchema } from "@mcpjam/sdk/contract";
import type { EvalStageAnalyticsV1 } from "@mcpjam/sdk/contract";

const { validateGuestTokenMock, convexQueryMock } = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  convexQueryMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: vi.fn(),
    action: vi.fn(),
  })),
}));

import v1Routes from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The SHARED golden document, validated on load.
 *
 * Validated here rather than trusted because this file builds variations of it:
 * if the corpus itself ever stopped satisfying the refined schema, every
 * assertion below would be measuring a fixture bug rather than the route.
 */
const GOLDEN: EvalStageAnalyticsV1 = evalStageAnalyticsSchema.parse(
  JSON.parse(
    readFileSync(
      resolve(
        here,
        "../../../../../sdk/tests/fixtures/stage-analytics-golden.json",
      ),
      "utf8",
    ),
  ),
) as EvalStageAnalyticsV1;

const PROJECT_ID = "proj_1";
const SUITE_ID = "suite_1";
const BEARER = "caller-bearer-token";

/** The golden document re-homed onto this test's project/suite ids. */
function row(
  overrides: Partial<EvalStageAnalyticsV1> = {},
): EvalStageAnalyticsV1 {
  return {
    ...GOLDEN,
    suiteId: SUITE_ID,
    projectId: PROJECT_ID,
    ...overrides,
  } as EvalStageAnalyticsV1;
}

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function request(path: string): Promise<Response> {
  return makeApp().request(`/api/v1${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${BEARER}` },
  });
}

/** Stub BY NAME: the route's two reads are not order-guaranteed. */
function stub(options: {
  suite?: unknown;
  suiteError?: unknown;
  page?: { page: unknown[]; isDone: boolean; continueCursor: string };
  pageError?: unknown;
}): void {
  const suite =
    options.suite === undefined ? { projectId: PROJECT_ID } : options.suite;
  convexQueryMock.mockImplementation((name: string) => {
    if (name === "testSuites:getTestSuite") {
      if (options.suiteError) return Promise.reject(options.suiteError);
      return Promise.resolve(suite);
    }
    if (name === "testSuites:listEvalStageAnalytics") {
      if (options.pageError) return Promise.reject(options.pageError);
      return Promise.resolve(
        options.page ?? { page: [], isDone: true, continueCursor: "" },
      );
    }
    return Promise.resolve(null);
  });
}

/** The args the route passed to the analytics query. */
function analyticsArgs(): Record<string, unknown> {
  const call = convexQueryMock.mock.calls.find(
    ([name]) => name === "testSuites:listEvalStageAnalytics",
  );
  return (call?.[1] ?? {}) as Record<string, unknown>;
}

const PATH = `/projects/${PROJECT_ID}/eval-suites/${SUITE_ID}/stage-analytics`;

beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
  validateGuestTokenMock.mockResolvedValue({ valid: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET …/eval-suites/:suiteId/stage-analytics", () => {
  it("returns the documents and pages with the v1 envelope", async () => {
    stub({
      page: { page: [row()], isDone: false, continueCursor: "cursor_2" },
    });
    const res = await request(PATH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: EvalStageAnalyticsV1[];
      nextCursor?: string;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toEqual(row());
    expect(body.nextCursor).toBe("cursor_2");
    // The Convex-internal `isDone`/`continueCursor`/`page` names never reach
    // the wire — completeness is `nextCursor`'s ABSENCE.
    expect(Object.keys(body).sort()).toEqual(["items", "nextCursor"]);
  });

  it("defaults to 25 items and a null first cursor", async () => {
    stub({});
    await request(PATH);
    expect(analyticsArgs()).toEqual({
      projectId: PROJECT_ID,
      suiteId: SUITE_ID,
      // `null`, not `undefined`: Convex pagination requires an explicit first
      // cursor, and an `undefined` would be dropped from the args entirely.
      paginationOpts: { numItems: 25, cursor: null },
    });
  });

  it("forwards every optional filter, and omits the ones not supplied", async () => {
    stub({});
    await request(
      `${PATH}?from=1700000000000&to=1700000100000&runGroupId=grp_1&cursor=c1&limit=10`,
    );
    expect(analyticsArgs()).toEqual({
      projectId: PROJECT_ID,
      suiteId: SUITE_ID,
      // Numbers, not the raw query strings: `from`/`to` are epoch ms and the
      // backend indexes on them numerically.
      from: 1700000000000,
      to: 1700000100000,
      runGroupId: "grp_1",
      paginationOpts: { numItems: 10, cursor: "c1" },
    });
  });

  it("omits nextCursor entirely on the last page", async () => {
    stub({ page: { page: [row()], isDone: true, continueCursor: "" } });
    const res = await request(PATH);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect("nextCursor" in body).toBe(false);
  });

  it("answers an empty page as a valid 200, not an error", async () => {
    // The backend's tenant-safe deny path returns a well-formed EMPTY page
    // rather than throwing. That serializes here as a plain empty 200: a real
    // "no documents" answer, which the UI must be free to tell apart from a
    // service failure.
    stub({ page: { page: [], isDone: true, continueCursor: "" } });
    const res = await request(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it("refuses a suite belonging to another project as NOT_FOUND", async () => {
    stub({ suite: { projectId: "some-other-project" } });
    const res = await request(PATH);
    expect(res.status).toBe(404);
    // The analytics query is never reached: the project cross-check is what
    // stops a valid suite id from another project reading across the scope the
    // path declares.
    expect(analyticsArgs()).toEqual({});
  });

  it("maps a Convex visibility failure to NOT_FOUND", async () => {
    stub({ suiteError: new Error("Not a member of this organization") });
    const res = await request(PATH);
    expect(res.status).toBe(404);
  });

  describe("window validation", () => {
    it("rejects an inverted window at the edge", async () => {
      stub({});
      const res = await request(`${PATH}?from=200&to=100`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR",
      );
      expect(analyticsArgs()).toEqual({});
    });

    it.each([
      ["non-numeric from", "?from=abc"],
      ["negative from", "?from=-1"],
      ["fractional to", "?to=1.5"],
      ["limit above the maximum", "?limit=101"],
      ["limit below the minimum", "?limit=0"],
      ["non-numeric limit", "?limit=many"],
    ])("rejects %s with a 400", async (_label, query) => {
      stub({});
      const res = await request(`${PATH}${query}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR",
      );
    });

    it("maps the backend's own INVALID_ARGUMENT throw to a 400", async () => {
      // Unreachable while the edge schema holds. Mapped anyway so the contract
      // cannot drift into answering a caller error with a 500.
      const convexError = Object.assign(new Error("inverted window"), {
        data: {
          code: "INVALID_ARGUMENT",
          message:
            "from must be less than or equal to to (inclusive epoch ms over runCompletedAt).",
        },
      });
      stub({ pageError: convexError });
      const res = await request(PATH);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR",
      );
    });
  });

  describe("contract enforcement at the boundary", () => {
    it("answers a schema-invalid row with a 502, not a 200", async () => {
      // `measured` that is not `passed + failed` — an arithmetic break the
      // STRUCTURAL schema would let through and the refined one catches.
      const broken = JSON.parse(JSON.stringify(row())) as any;
      broken.slices[0].stages[0].passed = 99;
      stub({ page: { page: [broken], isDone: true, continueCursor: "" } });
      const res = await request(PATH);
      expect(res.status).toBe(502);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("SERVER_UNREACHABLE");
      // The response names the failure without echoing the payload: these
      // documents carry intent labels and host names.
      expect(JSON.stringify(body)).not.toContain("host_a");
    });

    it("rejects a row that breaks a REFINED invariant the structure allows", async () => {
      // Two `overall` slices: structurally a valid array of slice rows, and a
      // document no reader can trust — "the overall funnel" would be ambiguous.
      const broken = JSON.parse(JSON.stringify(row())) as any;
      broken.slices.push(JSON.parse(JSON.stringify(broken.slices[0])));
      stub({ page: { page: [broken], isDone: true, continueCursor: "" } });
      const res = await request(PATH);
      expect(res.status).toBe(502);
    });

    it("fails the whole page rather than dropping the bad row from it", async () => {
      // A silently shortened page is a denominator that changed without saying
      // so — the one failure mode this contract exists to prevent.
      const broken = JSON.parse(JSON.stringify(row())) as any;
      broken.includedTrials = broken.totalTrials + 1;
      stub({
        page: { page: [row(), broken], isDone: true, continueCursor: "" },
      });
      const res = await request(PATH);
      expect(res.status).toBe(502);
    });
  });

  it("propagates a non-visibility Convex failure as a non-200", async () => {
    stub({ pageError: new Error("ECONNRESET") });
    const res = await request(PATH);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("is NOT guest-allowed", async () => {
    // Omission from the guest allowlist is what denies guests, and an omission
    // is invisible in a diff. Pinned so re-adding it has to be deliberate.
    const { isGuestAllowedV1Request } = await import(
      "../guest-allowed-paths.js"
    );
    expect(
      isGuestAllowedV1Request(
        "GET",
        `/api/v1/projects/${PROJECT_ID}/eval-suites/${SUITE_ID}/stage-analytics`,
      ),
    ).toBe(false);
  });
});
