import { beforeEach, describe, expect, it, vi } from "vitest";

// The worker tests stub out `runEvalSuite`, so nothing there can see what the
// REAL `defaultRunEvalSuite` hands to `prepareEvalRun`. The provenance label
// (`source: 'github_check'`) lives exactly in that gap: a regression back to
// 'api' would pass every existing test while silently mislabeling every check
// run in the dashboard — and dropping it from the stale-run watchdog's source
// gate on the backend. This file mocks the three integration boundaries and
// asserts on the actual call.

const prepareEvalRun = vi.fn();
const createAuthorizedManager = vi.fn();
const createConvexClient = vi.fn();

vi.mock("../../routes/shared/evals.js", () => ({
  prepareEvalRun: (...args: unknown[]) => prepareEvalRun(...args),
  // The real rule: only a replayed run that already finished skips execution.
  shouldSkipExecution: (prepared: { deduped?: boolean; status?: string }) =>
    prepared.deduped === true &&
    ["completed", "failed", "cancelled", "timed_out", "grading"].includes(
      prepared.status ?? "",
    ),
}));
vi.mock("../../routes/web/auth.js", () => ({
  createAuthorizedManager: (...args: unknown[]) =>
    createAuthorizedManager(...args),
}));
vi.mock("../evals/route-helpers.js", () => ({
  createConvexClient: (...args: unknown[]) => createConvexClient(...args),
}));

import { defaultRunEvalSuiteForTests } from "../github-checks-worker";

describe("defaultRunEvalSuite provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAuthorizedManager.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    prepareEvalRun.mockResolvedValue({
      runId: "run-1",
      recorder: null,
      execute: vi.fn().mockResolvedValue(undefined),
    });
    // First query: snapshot ownership check (null environment → 'ours');
    // second: the terminal run read.
    createConvexClient.mockReturnValue({
      query: vi
        .fn()
        .mockResolvedValueOnce({ configSnapshot: { environment: null } })
        .mockResolvedValue({
          status: "completed",
          result: "passed",
          summary: { total: 2, passed: 2, failed: 0, passRate: 1 },
        }),
      mutation: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("passes source: 'github_check' (never 'api') to prepareEvalRun", async () => {
    const run = defaultRunEvalSuiteForTests();
    const result = await run({
      claimed: {
        triggerId: "trig-src",
        repoFullName: "mcpjam/mcp-check-fixture",
        prNumber: 1,
        headSha: "a".repeat(40),
        organizationId: "org-1",
        projectId: "proj-1",
        createdByExternalId: "user_x",
        suiteId: "suite-1",
        repoPrivate: false,
        credentialPolicyVersion: 2,
        isFork: false,
        githubCredentialPolicy: "same_repository",
        allowedBuiltInToolIds: [],
      },
      bearer: "bearer-token",
      serverId: "srv-1",
      serverName: "gh-check-trig-src",
    });

    expect(prepareEvalRun).toHaveBeenCalledTimes(1);
    const request = prepareEvalRun.mock.calls[0][1] as Record<string, unknown>;
    expect(request.source).toBe("github_check");
    // The rest of the provenance-bearing contract, pinned alongside it:
    expect(request.idempotencyKey).toBe("trig-src");
    expect(request.suiteRerun).toBe(true);
    expect(request).not.toHaveProperty("refreshSnapshot");
    expect(result.result).toBe("passed");
  });

  it("does not strand the run when BINDING it throws", async () => {
    // `prepareEvalRun` has already created the run row and one pending
    // iteration row per attempt by the time the `eval` attempt is posted, and a
    // throw from there (a 409 from the state machine, an unreachable backend)
    // bypasses the catch around `execute()` where the cleanup lives. Aborting
    // is right — a run nothing may read must not be paid for — but the run must
    // not be left `running` with every iteration `pending`, forever.
    const recorder = { finalize: vi.fn().mockResolvedValue(undefined) };
    const execute = vi.fn().mockResolvedValue(undefined);
    prepareEvalRun.mockResolvedValue({ runId: "run-9", recorder, execute });
    const mutation = vi.fn().mockResolvedValue(undefined);
    createConvexClient.mockReturnValue({
      query: vi
        .fn()
        .mockResolvedValue({ configSnapshot: { environment: null } }),
      mutation,
    });

    const run = defaultRunEvalSuiteForTests();
    await expect(
      run({
        claimed: {
          triggerId: "trig-bind",
          repoFullName: "mcpjam/mcp-check-fixture",
          prNumber: 1,
          headSha: "a".repeat(40),
          organizationId: "org-1",
          projectId: "proj-1",
          createdByExternalId: "user_x",
          suiteId: "suite-1",
          repoPrivate: false,
          credentialPolicyVersion: 2,
          isFork: false,
          githubCredentialPolicy: "same_repository",
          allowedBuiltInToolIds: [],
        },
        bearer: "bearer-token",
        serverId: "srv-1",
        serverName: "gh-check-trig-bind",
        onRunStarted: async () => {
          throw new Error("plan refused the eval attempt (409)");
        },
      }),
    ).rejects.toThrow("plan refused the eval attempt (409)");

    // Nothing was evaluated…
    expect(execute).not.toHaveBeenCalled();
    // …and both halves of the run reached a terminal state.
    expect(mutation).toHaveBeenCalledWith(
      "testSuites:markSetupPendingIterationsFailed",
      expect.objectContaining({ runId: "run-9" }),
    );
    expect(recorder.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });
});

describe("defaultRunEvalSuite — a multi-environment run set", () => {
  const claimed = {
    triggerId: "trig-set",
    repoFullName: "mcpjam/mcp-check-fixture",
    prNumber: 1,
    headSha: "a".repeat(40),
    organizationId: "org-1",
    projectId: "proj-1",
    createdByExternalId: "user_x",
    suiteId: "suite-1",
    repoPrivate: false,
    credentialPolicyVersion: 2 as const,
    isFork: false,
    githubCredentialPolicy: "same_repository" as const,
    allowedBuiltInToolIds: [],
  };
  const targets = [
    {
      environmentId: "env-a",
      environmentRevision: 1,
      runKey: "trig-set:env-a",
    },
    {
      environmentId: "env-b",
      environmentRevision: 1,
      runKey: "trig-set:env-b",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    createAuthorizedManager.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("launches and binds one run per environment before executing any", async () => {
    const order: string[] = [];
    const executeA = vi.fn(async () => {
      order.push("execute run-a");
    });
    const executeB = vi.fn(async () => {
      order.push("execute run-b");
    });
    prepareEvalRun
      .mockResolvedValueOnce({
        runId: "run-a",
        recorder: null,
        execute: executeA,
      })
      .mockResolvedValueOnce({
        runId: "run-b",
        recorder: null,
        execute: executeB,
      });
    createConvexClient.mockReturnValue({
      query: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          status: "completed",
          result: "passed",
          summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
        })
        .mockResolvedValueOnce({
          status: "completed",
          result: "failed",
          summary: { total: 1, passed: 0, failed: 1, passRate: 0 },
        }),
      mutation: vi.fn().mockResolvedValue(undefined),
    });
    const bindTargetRun = vi.fn(async (runKey: string, runId: string) => {
      order.push(`bind ${runKey}=${runId}`);
    });
    const onRunStarted = vi.fn(async (runId: string) => {
      order.push(`eval ${runId}`);
    });

    const result = await defaultRunEvalSuiteForTests()({
      claimed,
      bearer: "bearer-token",
      serverId: "srv-1",
      serverName: "gh-check-trig-set",
      targets,
      bindTargetRun,
      onRunStarted,
    });

    const requests = prepareEvalRun.mock.calls.map(
      (call) => call[1] as Record<string, unknown>,
    );
    expect(
      requests.map((request) => [
        request.environmentId,
        request.idempotencyKey,
      ]),
    ).toEqual([
      ["env-a", "trig-set:env-a"],
      ["env-b", "trig-set:env-b"],
    ]);
    // Every run is bound before anything executes.
    expect(order).toEqual([
      "bind trig-set:env-a=run-a",
      "bind trig-set:env-b=run-b",
      "eval run-a",
      "execute run-a",
      "execute run-b",
    ]);
    expect(result).toMatchObject({
      runId: "run-a",
      result: "failed",
      summary: { total: 2, passed: 1, failed: 1, passRate: 0.5 },
    });
  });

  it("a refused binding settles every launched run and executes none", async () => {
    const executeA = vi.fn();
    const executeB = vi.fn();
    const recorder = { finalize: vi.fn().mockResolvedValue(undefined) };
    prepareEvalRun
      .mockResolvedValueOnce({ runId: "run-a", recorder, execute: executeA })
      .mockResolvedValueOnce({ runId: "run-b", recorder, execute: executeB });
    const mutation = vi.fn().mockResolvedValue(undefined);
    createConvexClient.mockReturnValue({
      query: vi.fn().mockResolvedValue({}),
      mutation,
    });
    const bindTargetRun = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("target_already_bound (409)"));

    await expect(
      defaultRunEvalSuiteForTests()({
        claimed,
        bearer: "bearer-token",
        serverId: "srv-1",
        serverName: "gh-check-trig-set",
        targets,
        bindTargetRun,
        onRunStarted: vi.fn(),
      }),
    ).rejects.toThrow("target_already_bound");

    expect(executeA).not.toHaveBeenCalled();
    expect(executeB).not.toHaveBeenCalled();
    const settled = mutation.mock.calls
      .filter(
        ([name]) => name === "testSuites:markSetupPendingIterationsFailed",
      )
      .map(([, args]) => (args as { runId: string }).runId);
    expect(settled).toEqual(["run-a", "run-b"]);
  });
});
