/**
 * EFTW-90 (amendment P2): a quick run has no suite run, so no box for
 * iteration scripts or grading. A suite whose iterations need one is refused
 * before anything is written; Advisory code evaluators are declared Not run.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
const actionMock = vi.hoisted(() => vi.fn());

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class MockConvexHttpClient {
    setAuth = vi.fn();
    query = (...args: unknown[]) => queryMock(...args);
    mutation = vi.fn(async () => null);
    action = (...args: unknown[]) => actionMock(...args);
  },
}));

vi.mock("../../../utils/harness/local/run-resources.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../utils/harness/local/run-resources.js")
  >()),
  shouldUseLocalHarness: vi.fn(async () => false),
}));

import { prepareSingleCaseExecution } from "../evals";
import { QUICK_RUN_NOT_RUN } from "../../../services/evals/sandbox-phases/quick-run.js";

const clientManager = {
  listServers: vi.fn(() => ["srv-1"]),
  hasServer: vi.fn((id: string) => id === "srv-1"),
  getToolsForAiSdk: vi.fn(async () => ({})),
};

const request = {
  testCaseId: "case-1",
  projectId: "project-1",
  model: "anthropic/claude-haiku-4.5",
  provider: "anthropic",
  serverIds: ["srv-1"],
  convexAuthToken: "token",
} as Parameters<typeof prepareSingleCaseExecution>[1];

const advisory = {
  id: "report",
  fileName: "report.sh",
  script: "echo 1",
  role: "advisory",
};

describe("prepareSingleCaseExecution: code evaluators and scripts", () => {
  let suite: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://example.convex.cloud";
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    suite = { _id: "suite-1" };
    queryMock.mockImplementation(async (name: unknown, args: unknown) => {
      const fn = String(
        typeof name === "string"
          ? name
          : (name as Record<symbol, unknown>)[
              Symbol.for("functionName")
            ] ?? "",
      );
      if (fn === "testSuites:getTestCase") {
        return {
          _id: "case-1",
          title: "Refund",
          query: "Refund the last charge",
          evalTestSuiteId: "suite-1",
          projectId: "project-1",
        };
      }
      if (fn === "testSuites:getTestSuite") {
        expect(args).toMatchObject({ suiteId: "suite-1" });
        return suite;
      }
      return null;
    });
    actionMock.mockResolvedValue(null);
  });

  async function refusal() {
    const error = await prepareSingleCaseExecution(
      clientManager as never,
      request,
    ).then(
      () => undefined,
      (caught: unknown) => caught as { status: number; message: string },
    );
    // Refused before any commit: nothing was written.
    expect(actionMock).not.toHaveBeenCalled();
    return error;
  }

  it("refuses iteration scripts and Required evaluators, pointing to the suite", async () => {
    suite.scripts = { iterationSetup: "seed" };
    expect(await refusal()).toMatchObject({
      status: 400,
      message:
        "Quick runs can't run this suite's iteration setup and cleanup scripts. Run the case from its suite.",
      details: { reason: "EVAL_CODE_EVALUATORS_UNAVAILABLE" },
    });

    suite.scripts = undefined;
    suite.codeEvaluators = [{ ...advisory, role: "required" }];
    expect((await refusal())?.message).toBe(
      "Quick runs can't run this suite's Required code evaluators. Run the case from its suite.",
    );
  });

  it("runs with run scripts and Advisory evaluators, declaring them Not run", async () => {
    suite.scripts = { runSetup: "seed", runCleanup: "drop" };
    suite.codeEvaluators = [advisory];
    const prepared = await prepareSingleCaseExecution(
      clientManager as never,
      request,
    );
    expect(prepared.test.codeGradingNotRun).toEqual({
      evaluators: [advisory],
      outcomes: {},
      notRun: QUICK_RUN_NOT_RUN,
    });
  });
});
