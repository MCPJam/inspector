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

// The runner imports `../../routes/shared/evals.js`; from this directory that
// module is one level further up.
vi.mock("../../../routes/shared/evals.js", () => ({
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
  /** Extra suite fields (e.g. `defaultPredicates`). */
  suite?: Record<string, unknown>;
  /** Replaces the `getRefinementSessionForVerification` pack. */
  verificationPack?: unknown;
}) {
  const query = vi.fn(async (qn: string, qa?: Record<string, unknown>) => {
    if (qn === "traceRepair:getTraceRepairJob") {
      return { ...CASE_JOB };
    }
    if (qn === "testSuites:getTestSuite") {
      return { configRevision: "rev-1", ...options.suite };
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
      if (options.verificationPack !== undefined) {
        return options.verificationPack;
      }
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

describe("runTraceRepairJob candidate verification", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  // Ready on the first poll; completed (passing) once verification recorded.
  function sessionLifecycle() {
    let verified = false;
    return {
      markVerified: () => {
        verified = true;
      },
      impl: async () =>
        verified
          ? { status: "completed", outcome: "improved_test" }
          : { status: "ready", candidateRevisionId: "rev-cand" },
    };
  }

  const promptStep = (prompt: string) => ({
    id: "p1",
    kind: "prompt" as const,
    prompt,
  });

  it("rejects a candidate that passes on an empty answer and never verifies it", async () => {
    vi.stubEnv("MCPJAM_TRACE_REPAIR_VACUOUS_GUARD", "on");
    const lifecycle = sessionLifecycle();
    const { convexClient, mutation } = createConvexStubs({
      refinementSessionImpl: lifecycle.impl,
      // The suite's only default check: no tool errors.
      suite: { defaultPredicates: [{ type: "noToolErrors" }] },
      verificationPack: {
        session: { candidateRevisionId: "rev-cand" },
        candidateSnapshotHash: "hash-cand",
        // The rewrite dropped every expected call: nothing left can fail.
        candidateSnapshot: {
          query: "hello",
          steps: [promptStep("hello")],
          expectedToolCalls: [],
          isNegativeTest: false,
          models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
        },
      },
    });

    await runTraceRepairJob({
      convexClient,
      convexAuthToken: "tok",
      jobId: "job-1",
    });

    const rejection = mutation.mock.calls.find(
      ([name]) => name === "testSuites:recordTraceRepairCandidateRejection",
    );
    expect(rejection?.[1]).toMatchObject({
      sessionId: "sess-1",
      candidateRevisionId: "rev-cand",
      caseCanFail: { verdict: "vacuous" },
    });
    expect(String((rejection?.[1] as any)?.caseCanFail?.reason)).toContain(
      "noToolErrors",
    );
    expect(runEvalMock).not.toHaveBeenCalled();
    expect(
      mutation.mock.calls.some(
        ([name]) => name === "testSuites:promoteRefinementCandidate",
      ),
    ).toBe(false);
  });

  it("with the guard off, a vacuous candidate is only logged and still verified", async () => {
    vi.stubEnv("MCPJAM_TRACE_REPAIR_VACUOUS_GUARD", "");
    const lifecycle = sessionLifecycle();
    const { convexClient, mutation } = createConvexStubs({
      refinementSessionImpl: lifecycle.impl,
      suite: { defaultPredicates: [{ type: "noToolErrors" }] },
      verificationPack: {
        session: { candidateRevisionId: "rev-cand" },
        candidateSnapshotHash: "hash-cand",
        candidateSnapshot: {
          query: "hello",
          steps: [promptStep("hello")],
          expectedToolCalls: [],
          isNegativeTest: false,
          models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
        },
      },
    });

    await runTraceRepairJob({
      convexClient,
      convexAuthToken: "tok",
      jobId: "job-1",
    });

    expect(
      mutation.mock.calls.some(
        ([name]) => name === "testSuites:recordTraceRepairCandidateRejection",
      ),
    ).toBe(false);
  });

  it("verifies the candidate's own steps, checks and rubric, and attests it", async () => {
    const lifecycle = sessionLifecycle();
    const candidateSteps = [
      promptStep("Find the greeting tool and greet Ada."),
      {
        id: "a1",
        kind: "assert" as const,
        assertion: {
          type: "toolCalledWith" as const,
          toolName: "greet",
          args: { args: { name: "Ada" } },
        },
      },
    ];
    const candidatePredicates = {
      mode: "extend" as const,
      list: [{ type: "responseContains" as const, needle: "Ada" }],
    };
    const { convexClient, mutation } = createConvexStubs({
      refinementSessionImpl: lifecycle.impl,
      suite: { defaultPredicates: [{ type: "noToolErrors" }] },
      verificationPack: {
        session: { candidateRevisionId: "rev-cand" },
        candidateSnapshotHash: "hash-cand",
        candidateSnapshot: {
          query: "Find the greeting tool and greet Ada.",
          steps: candidateSteps,
          expectedToolCalls: [
            { toolName: "greet", arguments: { name: "Ada" } },
          ],
          isNegativeTest: false,
          // Intentionally removed: the stored case's rubric must not return.
          expectedOutput: undefined,
          predicates: candidatePredicates,
          models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
        },
      },
    });
    mutation.mockImplementation(async (mn: string) => {
      if (mn === "testSuites:requestTraceRepairCandidate") {
        return { sessionId: "sess-1" };
      }
      if (mn === "testSuites:recordRefinementVerificationRun") {
        lifecycle.markVerified();
      }
      return {};
    });

    await runTraceRepairJob({
      convexClient,
      convexAuthToken: "tok",
      jobId: "job-1",
    });

    expect(runEvalMock).toHaveBeenCalledTimes(1);
    const overrides = (runEvalMock.mock.calls[0] as any[])[1].testCaseOverrides;
    expect(overrides).toMatchObject({
      query: "Find the greeting tool and greet Ada.",
      steps: candidateSteps,
      expectedToolCalls: [{ toolName: "greet", arguments: { name: "Ada" } }],
      expectedOutput: "",
      matchOptions: {},
      predicates: candidatePredicates,
      // Suite default + the candidate's extension, resolved as live grading.
      successPredicates: [
        { type: "noToolErrors" },
        { type: "responseContains", needle: "Ada" },
      ],
      runs: 1,
    });

    const record = mutation.mock.calls.find(
      ([name]) => name === "testSuites:recordRefinementVerificationRun",
    );
    expect(record?.[1]).toMatchObject({
      sessionId: "sess-1",
      candidateRevisionId: "rev-cand",
      candidateSnapshotHash: "hash-cand",
    });
    expect(
      mutation.mock.calls.some(
        ([name]) => name === "testSuites:recordTraceRepairCandidateRejection",
      ),
    ).toBe(false);
    expect(
      mutation.mock.calls.some(
        ([name]) => name === "testSuites:promoteRefinementCandidate",
      ),
    ).toBe(true);
  });
});
