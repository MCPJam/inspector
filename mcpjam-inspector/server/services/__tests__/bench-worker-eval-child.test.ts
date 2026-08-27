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
import { createBenchmarkArtifactLedger } from "../evals/artifact-ledger";

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
    ledger: createBenchmarkArtifactLedger(),
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

  it("licenses the hidden source with the claim's benchmarkRunId", async () => {
    // `source: 'benchmark'` is a CAPABILITY, not a label (mcpjam-backend#1160):
    // it hides the child from every project list and suppresses its
    // notifications, so `startTestSuiteRun` refuses it unless the caller also
    // names a live parent benchmark run it can already reach. Sending the
    // source without the id fails EVERY benchmark child at the mutation —
    // after the claim is leased and the MCP session is open.
    await run();

    const request = prepareEvalRun.mock.calls[0][1] as Record<string, unknown>;
    expect(request.source).toBe("benchmark");
    // Straight pass-through from the claim, not a re-derivation: the parent is
    // a fact of the job, and looking it up again is how a child gets filed
    // under the wrong benchmark.
    expect(request.benchmarkRunId).toBe(JOB.benchmarkRunId);
    expect(request.benchmarkRunId).toBe("brun-1");
  });

  it("sends the parent id of THIS claim, not a remembered one", async () => {
    // One worker process drives many jobs. A cached or module-scoped parent id
    // would pass the assertion above on the first job and silently file every
    // later job's children under it.
    await defaultRunEvalCellForTests()({
      job: { ...JOB, benchmarkRunId: "brun-2" },
      entry: ENTRY,
      cell: ENTRY.evalCell!,
      grantHeaders: { "x-mcpjam-benchmark-grant": "grant-token" },
    });

    expect(
      (prepareEvalRun.mock.calls[0][1] as Record<string, unknown>)
        .benchmarkRunId,
    ).toBe("brun-2");
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

  it("runs the cell at its PINNED repetition count, not the suite default", async () => {
    // `minimumRepetitionsPerRequiredCell` is a publication floor, so a cell
    // declared at N that runs at the suite's default (often 1) is not merely
    // thinner evidence — it can never clear the floor, and every hosted run of
    // that definition comes out provisional.
    await run();

    expect(
      (prepareEvalRun.mock.calls[0][1] as Record<string, unknown>)
        .iterationOverride,
    ).toBe(2);
  });

  it("sends no override when the roster pins no repetition count", async () => {
    const entry = { ...ENTRY };
    delete entry.repetitions;

    await defaultRunEvalCellForTests()({
      job: JOB,
      entry,
      cell: entry.evalCell!,
      grantHeaders: { "x-mcpjam-benchmark-grant": "grant-token" },
      ledger: createBenchmarkArtifactLedger(),
    });

    expect(
      (prepareEvalRun.mock.calls[0][1] as Record<string, unknown>)
        .iterationOverride,
    ).toBeUndefined();
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

  it("does not drive a replayed child that is still RUNNING", async () => {
    // `shouldSkipExecution` answers false here on purpose — for ordinary evals
    // a replay of a non-terminal run is more likely a crashed process worth
    // resuming than a live one worth leaving alone. That trade inverts for a
    // benchmark: a lease expires on a network partition as readily as on a
    // dead worker, so driving it can mean two workers running the same exam
    // against somebody else's server and billing the budget for both.
    shouldSkipExecution.mockReturnValue(false);
    prepareEvalRun.mockResolvedValue({
      runId: "run-1",
      recorder: null,
      execute,
      deduped: true,
      status: "running",
    });

    const result = await run();

    expect(execute).not.toHaveBeenCalled();
    // The pointer still comes back, so the row gets bound to the child that
    // does exist rather than reading as a cell that never started.
    expect(result).toEqual({ runId: "run-1", executed: false });
  });

  it("still executes a child this process actually created", async () => {
    // The byte-identity guard for the guard above: a fresh run is not deduped,
    // and refusing to drive it would mean no benchmark ever runs at all.
    prepareEvalRun.mockResolvedValue({
      runId: "run-1",
      recorder: null,
      execute,
      deduped: false,
      status: "running",
    });

    const result = await run();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ runId: "run-1", executed: true });
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
