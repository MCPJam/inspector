import { afterEach, describe, expect, it, vi } from "vitest";

const {
  fetchReplayConfigMock,
  buildReplayManagerMock,
  connectMock,
  captureMock,
  runEvalMock,
  executeReplayMock,
} = vi.hoisted(() => ({
  fetchReplayConfigMock: vi.fn().mockResolvedValue({
    runId: "run-1",
    suiteId: "suite-1",
    servers: [{ serverId: "srv1", url: "http://example.com" }],
  }),
  buildReplayManagerMock: vi.fn(() => ({
    disconnectAllServers: vi.fn().mockResolvedValue(undefined),
    connectToServer: vi.fn().mockResolvedValue(undefined),
  })),
  connectMock: vi.fn().mockResolvedValue(undefined),
  captureMock: vi.fn().mockResolvedValue({
    toolSnapshot: { version: 1, capturedAt: 1, servers: [] },
    toolSnapshotDebug: {},
  }),
  runEvalMock: vi.fn().mockResolvedValue({
    iteration: { _id: "ver-it-1" },
  }),
  executeReplayMock: vi.fn(),
}));

vi.mock("../route-helpers.js", () => ({
  fetchReplayConfig: (...args: unknown[]) => fetchReplayConfigMock(...args),
  buildReplayManager: (...args: unknown[]) => buildReplayManagerMock(...args),
  connectReplayManagerServers: (...args: unknown[]) => connectMock(...args),
  captureToolSnapshotForEvalAuthoring: (...args: unknown[]) =>
    captureMock(...args),
}));

vi.mock("../../routes/shared/evals.js", () => ({
  runEvalTestCaseWithManager: (...args: unknown[]) => runEvalMock(...args),
}));

vi.mock("../replay-suite-run.js", () => ({
  executeSuiteReplayFromRun: (...args: unknown[]) => executeReplayMock(...args),
}));

import {
  CANDIDATE_TIMEOUT_MS,
  runTraceRepairJob,
} from "../trace-repair-runner.js";

const CASE_JOB = {
  testSuiteId: "suite-1",
  sourceRunId: "run-1",
  scope: "case" as const,
  targetTestCaseId: "tc-target",
  targetSourceIterationId: "iter-second",
  status: "running",
  expectedConfigRevision: "rev-1",
  attemptLimit: 1,
  quickPassesRequired: 1,
};

function createConvexStubs(options: {
  refinementSessionImpl?: (name: string) => Promise<unknown>;
}) {
  const query = vi.fn(async (qn: string, qa?: Record<string, unknown>) => {
    if (qn === "traceRepair:getTraceRepairJob") {
      return { ...CASE_JOB };
    }
    if (qn === "testSuites:getTestSuite") {
      return { configRevision: "rev-1" };
    }
    if (qn === "testSuites:getTestIteration") {
      expect(qa?.iterationId).toBe("iter-second");
      return {
        _id: "iter-second",
        testCaseId: "tc-target",
        testCaseSnapshot: {
          caseKey: "ck-a",
          model: "openai/gpt-5-mini",
          provider: "openai",
          title: "t",
          query: "q",
          runs: 1,
          expectedToolCalls: [],
          isNegativeTest: false,
        },
      };
    }
    if (qn === "testSuites:listTestCases") {
      return [
        {
          models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
        },
      ];
    }
    if (qn === "testSuites:getTestSuiteRunDetails") {
      return {
        iterations: [
          {
            result: "failed",
            testCaseId: "tc-target",
            testCaseSnapshot: {
              caseKey: "ck-a",
              model: "openai/gpt-5-mini",
              provider: "openai",
              title: "t",
              query: "q",
              runs: 1,
              expectedToolCalls: [],
              isNegativeTest: false,
            },
          },
        ],
      };
    }
    if (qn === "testSuites:getRunReplayMetadata") {
      return { hasServerReplayConfig: true };
    }
    if (qn === "testSuites:getRefinementSession") {
      return options.refinementSessionImpl
        ? options.refinementSessionImpl(qn)
        : Promise.resolve({ status: "pending_candidate" });
    }
    if (qn === "testSuites:getRefinementSessionForVerification") {
      return {
        session: {
          candidateParaphraseQuery: "paraphrase hello",
        },
        candidateSnapshot: {
          query: "hello",
          models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
          expectedToolCalls: [{ toolName: "greet", arguments: {} }],
          isNegativeTest: false,
        },
      };
    }
    return null;
  });

  const mutation = vi.fn(async (mn: string, ma?: Record<string, unknown>) => {
    if (mn === "traceRepair:claimTraceRepairJobLease") {
      return {};
    }
    if (mn === "traceRepair:heartbeatTraceRepairJob") {
      return {};
    }
    if (mn === "traceRepair:advanceTraceRepairJob") {
      return {};
    }
    if (mn === "traceRepair:finalizeTraceRepairJob") {
      return {};
    }
    if (mn === "traceRepair:cancelTraceRepairJobForSuiteChange") {
      return {};
    }
    if (mn === "traceRepair:recordTraceRepairToolSnapshot") {
      return {};
    }
    if (mn === "testSuites:requestTraceRepairCandidate") {
      return { sessionId: "sess-1" };
    }
    if (mn === "testSuites:beginRefinementVerification") {
      return {};
    }
    if (mn === "testSuites:recordTraceRepairVerificationPlan") {
      return {};
    }
    if (mn === "testSuites:recordRefinementVerificationRun") {
      return {};
    }
    if (mn === "testSuites:promoteRefinementCandidate") {
      return {};
    }
    if (mn === "traceRepair:syncTraceRepairJobConfigAfterPromote") {
      return {};
    }
    if (mn === "testSuites:finalizeTraceRepairAttemptFailure") {
      return {};
    }
    return {};
  });

  return { query, mutation, convexClient: { query, mutation } as any };
}

describe("runTraceRepairJob (case scope integration stubs)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("exports candidate timeout >= backend refinement LLM budget", () => {
    expect(CANDIDATE_TIMEOUT_MS).toBe(130_000);
  });

  it("uses targetSourceIterationId for requestTraceRepairCandidate", async () => {
    let sourceIterationId: unknown;
    const { convexClient, mutation } = createConvexStubs({});
    mutation.mockImplementation(
      async (mn: string, ma?: Record<string, unknown>) => {
        if (mn === "traceRepair:claimTraceRepairJobLease") {
          return {};
        }
        if (mn === "traceRepair:heartbeatTraceRepairJob") {
          return {};
        }
        if (mn === "traceRepair:advanceTraceRepairJob") {
          return {};
        }
        if (mn === "traceRepair:finalizeTraceRepairJob") {
          return {};
        }
        if (mn === "traceRepair:cancelTraceRepairJobForSuiteChange") {
          return {};
        }
        if (mn === "traceRepair:recordTraceRepairToolSnapshot") {
          return {};
        }
        if (mn === "testSuites:requestTraceRepairCandidate") {
          sourceIterationId = ma?.sourceIterationId;
          throw new Error("stop-after-candidate-request");
        }
        return {};
      },
    );

    await runTraceRepairJob({
      convexClient,
      convexAuthToken: "tok",
      jobId: "job-1",
    });

    expect(sourceIterationId).toBe("iter-second");
  });

  it("still reaches beginRefinementVerification when session becomes ready after 46s of polling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(0);

    let beginCalls = 0;
    const { convexClient, mutation } = createConvexStubs({
      refinementSessionImpl: async () => {
        if (Date.now() < 46_000) {
          return { status: "pending_candidate" };
        }
        return {
          status: "ready",
          candidateRevisionId: "r",
          candidateParaphraseQuery: "p",
        };
      },
    });

    mutation.mockImplementation(
      async (mn: string, ma?: Record<string, unknown>) => {
        if (mn === "traceRepair:claimTraceRepairJobLease") {
          return {};
        }
        if (mn === "traceRepair:heartbeatTraceRepairJob") {
          return {};
        }
        if (mn === "traceRepair:advanceTraceRepairJob") {
          return {};
        }
        if (mn === "traceRepair:finalizeTraceRepairJob") {
          return {};
        }
        if (mn === "traceRepair:cancelTraceRepairJobForSuiteChange") {
          return {};
        }
        if (mn === "traceRepair:recordTraceRepairToolSnapshot") {
          return {};
        }
        if (mn === "testSuites:requestTraceRepairCandidate") {
          return { sessionId: "sess-1" };
        }
        if (mn === "testSuites:beginRefinementVerification") {
          beginCalls += 1;
          throw new Error("stop-after-begin-verification");
        }
        if (mn === "testSuites:recordTraceRepairVerificationPlan") {
          return {};
        }
        if (mn === "testSuites:recordRefinementVerificationRun") {
          return {};
        }
        if (mn === "testSuites:promoteRefinementCandidate") {
          return {};
        }
        if (mn === "traceRepair:syncTraceRepairJobConfigAfterPromote") {
          return {};
        }
        if (mn === "testSuites:finalizeTraceRepairAttemptFailure") {
          return {};
        }
        return {};
      },
    );

    const jobPromise = runTraceRepairJob({
      convexClient,
      convexAuthToken: "tok",
      jobId: "job-1",
    });

    await vi.advanceTimersByTimeAsync(46_500);
    await jobPromise;

    expect(beginCalls).toBe(1);
  });
});
