/**
 * `GET …/eval-runs/:runId/stage-analytics` — one run's document, at the read
 * boundary.
 *
 * The suite listing already has its own file; this one exists because the
 * run-scoped route makes DIFFERENT promises. It is a resource, not a page, so
 * "no document" is a 404 rather than an empty list — and that 404 has to be
 * indistinguishable from "you cannot see this run", or the API would confirm
 * the existence of runs in projects the caller has no access to.
 *
 * Stubbed BY FUNCTION NAME rather than by call order: the route makes two
 * reads and their order is an implementation detail. The populated fixture is
 * the SDK's shared golden document rather than a local hand-copy, so a
 * contract change breaks this test instead of drifting past it.
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
 * The SHARED golden document, validated on load — this file builds variations
 * of it, so a corpus that stopped satisfying the refined schema would make
 * every assertion below measure a fixture bug rather than the route.
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
const RUN_ID = "run_1";
const BEARER = "caller-bearer-token";

/** The golden document re-homed onto this test's project/suite/run ids. */
function row(
  overrides: Partial<EvalStageAnalyticsV1> = {},
): EvalStageAnalyticsV1 {
  return {
    ...GOLDEN,
    projectId: PROJECT_ID,
    suiteId: SUITE_ID,
    runId: RUN_ID,
    ...overrides,
  } as EvalStageAnalyticsV1;
}

function request(path: string): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app.request(`/api/v1${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${BEARER}` },
  });
}

/** Stub BY NAME: the route's two reads are not order-guaranteed. */
function stub(options: {
  run?: unknown;
  runError?: unknown;
  document?: unknown;
  documentError?: unknown;
}): void {
  const run =
    options.run === undefined
      ? { projectId: PROJECT_ID, suiteId: SUITE_ID }
      : options.run;
  convexQueryMock.mockImplementation((name: string) => {
    if (name === "testSuites:getTestSuiteRun") {
      if (options.runError) return Promise.reject(options.runError);
      return Promise.resolve(run);
    }
    if (name === "testSuites:getEvalRunStageAnalytics") {
      if (options.documentError) return Promise.reject(options.documentError);
      return Promise.resolve(
        options.document === undefined ? row() : options.document,
      );
    }
    return Promise.resolve(null);
  });
}

const PATH = `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/stage-analytics`;

beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
  validateGuestTokenMock.mockResolvedValue({ valid: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET …/eval-runs/:runId/stage-analytics", () => {
  it("returns the run's document as a resource, not a page", async () => {
    stub({});
    const res = await request(PATH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // A RESOURCE: the document itself, with no `items`/`nextCursor` envelope.
    // Wrapping one document in a page would invite exactly the cross-run merge
    // the contract refuses.
    expect(body).toEqual(row());
    expect("items" in body).toBe(false);
    expect("nextCursor" in body).toBe(false);
  });

  it("asks Convex for this run and nothing else", async () => {
    stub({});
    await request(PATH);
    const call = convexQueryMock.mock.calls.find(
      ([name]) => name === "testSuites:getEvalRunStageAnalytics",
    );
    expect(call?.[1]).toEqual({ runId: RUN_ID });
  });

  it("answers 404 when the run has no document", async () => {
    // The reader's own "no row" answer. NOT a 200 with an empty funnel: a run
    // that terminalized before the materializer shipped was never measured,
    // and zeroes would read as "measured, and everything failed".
    stub({ document: null });
    const res = await request(PATH);
    expect(res.status).toBe(404);
  });

  it("answers the SAME 404 when the run is not visible", async () => {
    // Indistinguishable on purpose. A distinct status or message would confirm
    // that a run exists in a project the caller cannot see.
    stub({ document: null });
    const absent = await request(PATH);
    const absentBody = await absent.json();

    stub({ runError: new Error("Not a member of this organization") });
    const denied = await request(PATH);
    const deniedBody = await denied.json();

    expect(denied.status).toBe(absent.status);
    expect((deniedBody as { error?: { code?: string } }).error?.code).toBe(
      (absentBody as { error?: { code?: string } }).error?.code,
    );
  });

  it("reads a run from ANOTHER project as not found", async () => {
    // Convex enforces membership; the project cross-check is what stops a
    // valid run id from another of the caller's own projects being served
    // under this path's project scope.
    stub({ run: { projectId: "proj_other", suiteId: SUITE_ID } });
    const res = await request(PATH);
    expect(res.status).toBe(404);
  });

  it("refuses a payload that fails the contract, rather than serving it", async () => {
    // A document with TWO overall slices passes a structural check and fails
    // the refined one — and every rate a reader draws rests on there being
    // exactly one. An upstream fault is a service error, never a 200.
    const golden = row();
    stub({
      document: {
        ...golden,
        slices: [...golden.slices, golden.slices[0]],
      },
    });
    const res = await request(PATH);
    expect(res.status).toBe(502);
  });

  it("refuses a valid document that is for a DIFFERENT run", async () => {
    // Shape is not identity: `runId` is only `string().min(1)` to the schema,
    // so another run's document parses perfectly and would then be rendered
    // under this run's heading. Nothing upstream binds the answer to the
    // question; this route does.
    stub({ document: row({ runId: "run_somebody_else" }) });
    const res = await request(PATH);
    expect(res.status).toBe(502);
  });
});
