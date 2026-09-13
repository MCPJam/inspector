/**
 * `GET …/eval-runs/:runId/gate` — the stored suite policy's answer.
 *
 * A 404 is only "this run is not visible". `not_configured` is a 200
 * report. A missing Convex function is 501, never a 404 that could be
 * read as "no policy".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  suiteGatePolicyHash,
  suiteGateReportSchema,
} from "@mcpjam/sdk/contract";

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

const PROJECT_ID = "proj_1";
const SUITE_ID = "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx";
// Id-SHAPED: `:runId` is checked for the Convex id shape before it is
// forwarded, so a `run_1` label would exercise the gate, not this route.
const RUN_ID = "run1xxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const BEARER = "caller-bearer-token";
const PATH = `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/gate`;

function report(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const policy = {};
  return {
    schemaVersion: 1,
    evaluatorVersion: 1,
    policy,
    policyHash: suiteGatePolicyHash(policy),
    outcome: "not_configured",
    conditions: [],
    ...overrides,
  };
}

function request(path: string): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app.request(`/api/v1${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${BEARER}` },
  });
}

function stub(options: {
  run?: unknown;
  runError?: unknown;
  evaluation?: unknown;
  evaluationError?: unknown;
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
    if (name === "testSuites:evaluateSuiteGate") {
      if (options.evaluationError) {
        return Promise.reject(options.evaluationError);
      }
      return Promise.resolve(
        options.evaluation === undefined
          ? { report: report() }
          : options.evaluation,
      );
    }
    return Promise.resolve(null);
  });
}

beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
  validateGuestTokenMock.mockResolvedValue({ valid: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET …/eval-runs/:runId/gate", () => {
  it("returns the suite-gate report as a resource", async () => {
    stub({});
    const res = await request(PATH);
    expect(res.status).toBe(200);
    const body = suiteGateReportSchema.parse(await res.json());
    expect(body.outcome).toBe("not_configured");
    expect("items" in body).toBe(false);
  });

  it("unwraps B1b's { report, receipt, evidence } wrapper", async () => {
    stub({
      evaluation: {
        report: report({ outcome: "passed" }),
        receipt: { suiteRevision: 3 },
        evidence: { subject: { runId: RUN_ID } },
      },
    });
    const res = await request(PATH);
    expect(res.status).toBe(200);
    const body = suiteGateReportSchema.parse(await res.json());
    expect(body.outcome).toBe("passed");
    expect("receipt" in body).toBe(false);
  });

  it("answers 404 when the run is not visible", async () => {
    stub({ runError: new Error("not found") });
    const res = await request(PATH);
    expect(res.status).toBe(404);
  });

  it("answers FEATURE_NOT_SUPPORTED when the evaluator is not deployed", async () => {
    stub({
      evaluationError: new Error(
        "Could not find public function testSuites:evaluateSuiteGate",
      ),
    });
    const res = await request(PATH);
    // v1 maps FEATURE_NOT_SUPPORTED to 422 — never a 404 that could be
    // read as "this run has no policy".
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("FEATURE_NOT_SUPPORTED");
  });

  it("does not treat a missing report as no policy", async () => {
    stub({ evaluation: null });
    const res = await request(PATH);
    expect(res.status).toBe(502);
  });
});
