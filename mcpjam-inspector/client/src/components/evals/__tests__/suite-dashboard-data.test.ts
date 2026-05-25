import { describe, expect, it } from "vitest";
import { buildSuiteDashboardMatrixFoundation } from "../suite-dashboard-data";
import type { EvalCase, EvalIteration, EvalSuiteRun } from "../types";

const baseRun: EvalSuiteRun = {
  _id: "run-latest",
  suiteId: "suite-1",
  createdBy: "user-1",
  runNumber: 2,
  configRevision: "1",
  configSnapshot: { tests: [], environment: { servers: [] } },
  status: "completed",
  createdAt: 10,
  completedAt: 20,
};

const olderRun: EvalSuiteRun = {
  ...baseRun,
  _id: "run-old",
  runNumber: 1,
  createdAt: 1,
  completedAt: 5,
};

const testCase: EvalCase = {
  _id: "case-1",
  testSuiteId: "suite-1",
  createdBy: "user-1",
  title: "Create a diagram",
  query: "Create a diagram",
  models: [{ provider: "anthropic", model: "claude-haiku-4-5" }],
  runs: 10,
  expectedToolCalls: [],
};

const iteration: EvalIteration = {
  _id: "iter-1",
  testCaseId: "case-1",
  suiteRunId: "run-latest",
  createdBy: "user-1",
  createdAt: 11,
  startedAt: 12,
  updatedAt: 15,
  iterationNumber: 1,
  status: "completed",
  result: "failed",
  actualToolCalls: [{ toolName: "search_shapes", arguments: {} }],
  tokensUsed: 120,
  metadata: { missingCount: 1 },
  testCaseSnapshot: {
    title: "Create a diagram",
    query: "Create a diagram",
    provider: "openai",
    model: "gpt-4o-mini",
    expectedToolCalls: [{ toolName: "create_diagram", arguments: {} }],
  },
};

describe("buildSuiteDashboardMatrixFoundation", () => {
  it("identifies the latest completed run and dashboard matrix axes", () => {
    const foundation = buildSuiteDashboardMatrixFoundation({
      cases: [testCase],
      allIterations: [iteration],
      runs: [olderRun, baseRun],
    });

    expect(foundation.latestCompletedRun?._id).toBe("run-latest");
    expect(foundation.latestRunIterations.map((item) => item._id)).toEqual([
      "iter-1",
    ]);
    expect(foundation.caseIds).toEqual(["case-1"]);
    expect(foundation.modelKeys).toEqual([
      "anthropic/claude-haiku-4-5",
      "openai/gpt-4o-mini",
    ]);
    expect(foundation.availableMetrics).toEqual([
      "pass-rate",
      "latency",
      "tokens",
      "validators",
    ]);
  });

  it("falls back to all iterations when no completed run exists", () => {
    const foundation = buildSuiteDashboardMatrixFoundation({
      cases: [],
      allIterations: [iteration],
      runs: [{ ...baseRun, status: "running", completedAt: undefined }],
    });

    expect(foundation.latestCompletedRun).toBeNull();
    expect(foundation.latestRunIterations).toEqual([]);
    expect(foundation.caseIds).toEqual(["case-1"]);
    expect(foundation.availableMetrics).toContain("pass-rate");
  });
});
