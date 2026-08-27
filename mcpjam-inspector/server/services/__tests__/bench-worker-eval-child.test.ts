import { beforeEach, describe, expect, it, vi } from "vitest";

// The orchestration tests stub `runEvalCell`, so nothing there can see what the
// REAL `defaultRunEvalCell` hands to the eval pipeline. Everything that makes a
// benchmark child a BENCHMARK child lives exactly in that gap: the
// `source: 'benchmark'` provenance the backend's readers gate on, the scoped
// runner bearer, the grant that tells `/stream` which budget to charge, and the
// idempotency key that stops a redelivered claim paying twice. This file mocks
// the two integration boundaries and asserts on the actual calls.

const prepareEvalRun = vi.fn();
const shouldSkipExecution = vi.fn();
const createAuthorizedManager = vi.fn();

vi.mock("../../routes/shared/evals.js", () => ({
  prepareEvalRun: (...args: unknown[]) => prepareEvalRun(...args),
  shouldSkipExecution: (...args: unknown[]) => shouldSkipExecution(...args),
}));
vi.mock("../../routes/web/auth.js", () => ({
  createAuthorizedManager: (...args: unknown[]) =>
    createAuthorizedManager(...args),
}));

import {
  defaultRunEvalCellForTests,
  type BenchmarkRosterEntry,
  type ClaimedBenchmarkJob,
} from "../bench-worker";

const JOB: ClaimedBenchmarkJob = {
  jobId: "job-1",
  benchmarkRunId: "brun-1",
  organizationId: "org-1",
  projectId: "proj-1",
  serverId: "srv-1",
  serverName: "Target",
  leaseGeneration: 3,
  definitionHash: "def-1",
  pins: { definitionHash: "def-1" },
  roster: [],
  grant: "grant-token",
  runnerBearer: "runner-bearer",
};

const ENTRY: BenchmarkRosterEntry = {
  evidenceKey: "eval:sonnet-emulated",
  kind: "eval_run",
  status: "expected",
  required: true,
  repetitions: 2,
  evalCell: {
    cellId: "sonnet-emulated",
    suiteId: "suite-1",
    environmentId: "env-sonnet",
    namedHostId: "host-emulated",
    writeCases: false,
  },
};

function run(grantHeaders?: Record<string, string>) {
  return defaultRunEvalCellForTests()({
    job: JOB,
    entry: ENTRY,
    cell: ENTRY.evalCell!,
    grantHeaders: grantHeaders ?? { "x-mcpjam-benchmark-grant": "grant-token" },
  });
}

describe("defaultRunEvalCell", () => {
  let disconnectAllServers: ReturnType<typeof vi.fn>;
  let execute: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    disconnectAllServers = vi.fn().mockResolvedValue(undefined);
    execute = vi.fn().mockResolvedValue(undefined);
    createAuthorizedManager.mockResolvedValue({
      manager: { disconnectAllServers },
    });
    prepareEvalRun.mockResolvedValue({
      runId: "run-1",
      recorder: null,
      execute,
    });
    shouldSkipExecution.mockReturnValue(false);
  });

  it("launches the cell as a benchmark-sourced run of the pinned exam", async () => {
    const result = await run();

    expect(result).toEqual({ runId: "run-1", executed: true });
    const request = prepareEvalRun.mock.calls[0][1] as Record<string, unknown>;
    // Provenance. A regression to 'api' would pass every other test while
    // mislabeling every benchmark child — and dropping it out of the backend's
    // benchmark-sourced hiding, so exam runs would surface in Evaluate.
    expect(request.source).toBe("benchmark");
    expect(request.suiteId).toBe("suite-1");
    expect(request.projectId).toBe("proj-1");
    expect(request.serverIds).toEqual(["srv-1"]);
    expect(request.suiteRerun).toBe(true);
    expect(request.environmentId).toBe("env-sonnet");
    expect(request.namedHostId).toBe("host-emulated");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("runs the child as the run's scoped bearer, not the inspector", async () => {
    await run();

    const [caller, bearer, projectId, serverIds] =
      createAuthorizedManager.mock.calls[0];
    expect(caller).toEqual({});
    expect(bearer).toBe("runner-bearer");
    expect(projectId).toBe("proj-1");
    expect(serverIds).toEqual(["srv-1"]);
    expect(
      (prepareEvalRun.mock.calls[0][1] as Record<string, unknown>)
        .convexAuthToken,
    ).toBe("runner-bearer");
  });

  it("keys the child by benchmarkRunId + evidenceKey", async () => {
    await run();

    expect(
      (prepareEvalRun.mock.calls[0][1] as Record<string, unknown>)
        .idempotencyKey,
    ).toBe("brun-1:eval:sonnet-emulated");
  });

  it("carries the grant header object by reference so a reissue reaches this run", async () => {
    const grantHeaders = { "x-mcpjam-benchmark-grant": "grant-token" };
    await run(grantHeaders);

    const request = prepareEvalRun.mock.calls[0][1] as Record<string, unknown>;
    // The SAME object, not a copy: the heartbeat rotates the grant inside it
    // while the run's steps are still being dispatched.
    expect(request.extraHeaders).toBe(grantHeaders);
  });

  it("does not re-execute a replayed child that already finished", async () => {
    // The double-charge this whole idempotency story exists to prevent: the
    // exam would run a second time against someone else's server, against a
    // child whose results the roster already holds.
    shouldSkipExecution.mockReturnValue(true);
    prepareEvalRun.mockResolvedValue({
      runId: "run-1",
      recorder: null,
      execute,
      deduped: true,
      status: "completed",
    });

    const result = await run();

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({ runId: "run-1", executed: false });
  });

  it("keeps the run id when the exam itself fails", async () => {
    // The run EXISTS and the eval runner has already finalized it. Losing the
    // id here would leave the evidence row with no pointer, and an unattached
    // row reads as a cell that never started rather than one that failed
    // against the target — the difference between a coverage gap and a result.
    execute.mockRejectedValue(new Error("target went away"));

    await expect(run()).resolves.toEqual({ runId: "run-1", executed: true });
    expect(disconnectAllServers).toHaveBeenCalledTimes(1);
  });

  it("tears the MCP session down when the run cannot even be created", async () => {
    prepareEvalRun.mockRejectedValue(new Error("suite is gone"));

    await expect(run()).rejects.toThrow("suite is gone");
    expect(disconnectAllServers).toHaveBeenCalledTimes(1);
  });
});
