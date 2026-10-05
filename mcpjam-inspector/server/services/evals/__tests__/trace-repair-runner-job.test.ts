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

  // The rewrite dropped every expected call: nothing left can fail.
  const vacuousPack = {
    session: { candidateRevisionId: "rev-cand" },
    candidateSnapshot: {
      query: "hello",
      steps: [promptStep("hello")],
      expectedToolCalls: [],
      isNegativeTest: false,
      models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
    },
  };

  function recordingMutations(
    mutation: ReturnType<typeof createConvexStubs>["mutation"],
    lifecycle: ReturnType<typeof sessionLifecycle>,
  ) {
    mutation.mockImplementation(async (mn: string) => {
      if (mn === "testSuites:requestTraceRepairCandidate") {
        return { sessionId: "sess-1" };
      }
      if (mn === "testSuites:recordRefinementVerificationRun") {
        lifecycle.markVerified();
      }
      return {};
    });
  }

  const called = (
    mutation: ReturnType<typeof createConvexStubs>["mutation"],
    name: string,
  ) => mutation.mock.calls.some(([mn]) => mn === name);

  it("rejects a candidate that passes on an empty answer and never verifies it", async () => {
    const lifecycle = sessionLifecycle();
    const { convexClient, mutation } = createConvexStubs({
      refinementSessionImpl: lifecycle.impl,
      // The suite's only default check: no tool errors.
      suite: { defaultPredicates: [{ type: "noToolErrors" }] },
      verificationPack: vacuousPack,
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
    expect(called(mutation, "testSuites:recordRefinementVerificationRun")).toBe(
      false,
    );
    expect(called(mutation, "testSuites:promoteRefinementCandidate")).toBe(
      false,
    );
  });

  it("still refuses the vacuous rewrite when the rejection cannot be recorded", async () => {
    const lifecycle = sessionLifecycle();
    const { convexClient, mutation } = createConvexStubs({
      refinementSessionImpl: lifecycle.impl,
      suite: { defaultPredicates: [{ type: "noToolErrors" }] },
      verificationPack: vacuousPack,
    });
    mutation.mockImplementation(async (mn: string) => {
      if (mn === "testSuites:requestTraceRepairCandidate") {
        return { sessionId: "sess-1" };
      }
      if (mn === "testSuites:recordTraceRepairCandidateRejection") {
        throw new Error("unknown function");
      }
      return {};
    });

    await runTraceRepairJob({
      convexClient,
      convexAuthToken: "tok",
      jobId: "job-1",
    });

    expect(runEvalMock).not.toHaveBeenCalled();
    expect(called(mutation, "testSuites:promoteRefinementCandidate")).toBe(
      false,
    );
  });

  it("verifies a candidate a required judge grades instead of refusing it", async () => {
    // Same rewrite, but the suite's judge gates: an empty answer would fail.
    const lifecycle = sessionLifecycle();
    const { convexClient, mutation } = createConvexStubs({
      refinementSessionImpl: lifecycle.impl,
      suite: {
        defaultPredicates: [{ type: "noToolErrors" }],
        judgeConfig: { goalCompletion: { enabled: true, role: "required" } },
      },
      verificationPack: vacuousPack,
    });
    recordingMutations(mutation, lifecycle);

    await runTraceRepairJob({
      convexClient,
      convexAuthToken: "tok",
      jobId: "job-1",
    });

    expect(
      called(mutation, "testSuites:recordTraceRepairCandidateRejection"),
    ).toBe(false);
    expect(runEvalMock).toHaveBeenCalledTimes(1);
  });

  it("verifies the candidate's own steps, checks and rubric", async () => {
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
    const { convexClient, mutation, query } = createConvexStubs({
      refinementSessionImpl: lifecycle.impl,
      suite: { defaultPredicates: [{ type: "noToolErrors" }] },
      verificationPack: {
        session: { candidateRevisionId: "rev-cand" },
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
    // The stored case the candidate replaces: other steps, a rubric, a
    // replace-mode envelope. None of it may reach verification.
    const listCases = query.getMockImplementation()!;
    query.mockImplementation(async (qn: string, qa?: any) =>
      qn === "testSuites:listTestCases"
        ? [
            {
              _id: "tc-target",
              models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
              steps: [promptStep("Say hello.")],
              expectedOutput: "A friendly greeting.",
              predicates: { mode: "replace", list: [] },
            },
          ]
        : listCases(qn, qa),
    );
    recordingMutations(mutation, lifecycle);

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
      // Suite default + the candidate's extension, resolved as live grading.
      successPredicates: [
        { type: "noToolErrors" },
        { type: "responseContains", needle: "Ada" },
      ],
      runs: 1,
    });

    // The envelope is not sent: the resolved list above outranks it.
    expect(overrides).not.toHaveProperty("predicates");
    // The backend reads what ran off the iteration itself; the runner sends
    // nothing a backend of any version would refuse.
    const record = mutation.mock.calls.find(
      ([name]) => name === "testSuites:recordRefinementVerificationRun",
    );
    expect(record?.[1]).toEqual({
      sessionId: "sess-1",
      label: "same-model-1",
      iterationId: "ver-it-1",
    });
    expect(
      called(mutation, "testSuites:recordTraceRepairCandidateRejection"),
    ).toBe(false);
    expect(called(mutation, "testSuites:promoteRefinementCandidate")).toBe(
      true,
    );
  });

  it("verifies a candidate the can-it-fail check cannot read (fails open)", async () => {
    const lifecycle = sessionLifecycle();
    const candidateSnapshot = {
      ...vacuousPack.candidateSnapshot,
      // Read only by the check (for the judge opt-out); it throws there.
      get judgeConfigOverride(): unknown {
        throw new Error("unreadable");
      },
    };
    const { convexClient, mutation } = createConvexStubs({
      refinementSessionImpl: lifecycle.impl,
      suite: { defaultPredicates: [{ type: "noToolErrors" }] },
      verificationPack: { ...vacuousPack, candidateSnapshot },
    });
    recordingMutations(mutation, lifecycle);

    await runTraceRepairJob({
      convexClient,
      convexAuthToken: "tok",
      jobId: "job-1",
    });

    expect(
      called(mutation, "testSuites:recordTraceRepairCandidateRejection"),
    ).toBe(false);
    expect(runEvalMock).toHaveBeenCalledTimes(1);
  });

  it("does not count a refused promotion as promoted", async () => {
    const lifecycle = sessionLifecycle();
    const { convexClient, mutation } = createConvexStubs({
      refinementSessionImpl: lifecycle.impl,
      suite: {
        defaultPredicates: [{ type: "noToolErrors" }],
        judgeConfig: { goalCompletion: { enabled: true, role: "required" } },
      },
      verificationPack: vacuousPack,
    });
    mutation.mockImplementation(async (mn: string) => {
      if (mn === "testSuites:requestTraceRepairCandidate") {
        return { sessionId: "sess-1" };
      }
      if (mn === "testSuites:recordRefinementVerificationRun") {
        lifecycle.markVerified();
      }
      if (mn === "testSuites:promoteRefinementCandidate") {
        return {
          success: false,
          reason: "the case was edited after this repair started",
        };
      }
      return {};
    });

    await runTraceRepairJob({
      convexClient,
      convexAuthToken: "tok",
      jobId: "job-1",
    });

    expect(called(mutation, "testSuites:promoteRefinementCandidate")).toBe(
      true,
    );
    expect(
      called(mutation, "traceRepair:syncTraceRepairJobConfigAfterPromote"),
    ).toBe(false);
    expect(executeReplayMock).not.toHaveBeenCalled();
  });

  it("never verifies the stored case when the pack names no candidate", async () => {
    const lifecycle = sessionLifecycle();
    const { convexClient, mutation } = createConvexStubs({
      refinementSessionImpl: lifecycle.impl,
      verificationPack: { session: {}, candidateSnapshot: null },
    });
    recordingMutations(mutation, lifecycle);

    await runTraceRepairJob({
      convexClient,
      convexAuthToken: "tok",
      jobId: "job-1",
    });

    expect(runEvalMock).not.toHaveBeenCalled();
    expect(called(mutation, "testSuites:promoteRefinementCandidate")).toBe(
      false,
    );
  });
});
