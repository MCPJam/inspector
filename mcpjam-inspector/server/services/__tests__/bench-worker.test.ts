import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertClaimExecutable,
  BENCH_SERVICE_ROUTES,
  claimNextForTests,
  decodeClaimedJob,
  resolveEvalCellSpec,
  sendHeartbeatForTests,
  evalChildIdempotencyKey,
  executeClaimedJob,
  JobUnexecutableError,
  LeaseLostError,
  startBenchWorker,
  type BenchExecutionDeps,
  type BenchmarkHeartbeat,
  type BenchmarkRosterEntry,
  type ClaimedBenchmarkJob,
} from "../bench-worker";

const CLAIMED_BY = "inspector-bench-test";
const DEFINITION_HASH = "def-hash-1";
const TARGET_URL = "https://target.example/mcp";

/**
 * One roster row, in the shape `rosterFor()` sends it.
 *
 * `environmentId` is set here even though the backend does not send it yet:
 * these tests exercise the path where a cell CAN be launched, and the path
 * where it cannot is asserted separately in `resolveEvalCellSpec`.
 */
function cell(
  cellId: string,
  options?: { status?: BenchmarkRosterEntry["status"] },
): BenchmarkRosterEntry {
  return {
    evidenceKey: `eval:${cellId}`,
    externalRunId: `benchmark:brun-1:eval:${cellId}`,
    pillar: "agentic",
    kind: "eval_run",
    status: options?.status ?? "expected",
    required: true,
    repetitions: 1,
    cellId,
    environmentId: `env-${cellId}`,
    namedHostId: null,
  };
}

function job(overrides?: Partial<ClaimedBenchmarkJob>): ClaimedBenchmarkJob {
  return {
    jobId: "job-1",
    benchmarkRunId: "brun-1",
    organizationId: "org-1",
    projectId: "proj-1",
    serverId: "srv-1",
    serverName: "Target",
    leaseGeneration: 7,
    pins: {
      definitionHash: DEFINITION_HASH,
      consentHash: "consent-1",
      suiteId: "suite-1",
    },
    target: { targetKind: "server", targetKey: "srv-1", serverUrl: TARGET_URL },
    // Read-only by default: the whole matrix runs in parallel unless the payer
    // consented to write cases, which is the only per-run signal the claim
    // carries about side effects.
    consent: { authenticatedChecks: false, writeCases: false },
    roster: [
      // A pillar this lane does not own; it must be left entirely alone.
      {
        evidenceKey: "claude-readiness",
        kind: "claude_readiness",
        status: "expected",
        required: true,
      },
      cell("a"),
      cell("b"),
    ],
    grant: "grant-token",
    grantExpiresAt: 4_000_000_000_000,
    runnerBearer: "runner-bearer",
    ...overrides,
  };
}

type Recorded = {
  launched: string[];
  attached: Array<{ evidenceKey: string; testSuiteRunId: string }>;
  /** Every call, including the ones that threw — the retry ladder is the point. */
  attachAttempts: number;
  completed: Array<{ stoppedReason?: string }>;
  aborted: Array<{ reason: string; retryable: boolean }>;
  /** Header objects handed to each cell, so grant rotation is observable. */
  grantHeaders: Array<Record<string, string>>;
};

function harness(options?: {
  heartbeat?: (
    job: ClaimedBenchmarkJob,
    claimedBy: string,
  ) => Promise<BenchmarkHeartbeat>;
  runEvalCell?: BenchExecutionDeps["runEvalCell"];
  attachThrows?: unknown;
  /** Throw from `attachEvidence` for the first N calls, then succeed. */
  attachThrowsTimes?: number;
}): { deps: Partial<BenchExecutionDeps>; recorded: Recorded } {
  const recorded: Recorded = {
    launched: [],
    attached: [],
    attachAttempts: 0,
    aborted: [],
    completed: [],
    grantHeaders: [],
  };

  const runCell: BenchExecutionDeps["runEvalCell"] =
    options?.runEvalCell ??
    (async (args) => ({ runId: `run-${args.cell.cellId}`, executed: true }));

  const deps: Partial<BenchExecutionDeps> = {
    // Wrapped rather than replaced, so "which cells were launched" is recorded
    // the same way whatever a test scripts the child itself to do.
    runEvalCell: async (args) => {
      recorded.launched.push(args.cell.cellId);
      recorded.grantHeaders.push(args.grantHeaders);
      return runCell(args);
    },
    attachEvidence: async (args) => {
      recorded.attachAttempts++;
      if (options?.attachThrows) throw options.attachThrows;
      if (
        options?.attachThrowsTimes &&
        recorded.attachAttempts <= options.attachThrowsTimes
      ) {
        throw new Error("evidence attach rejected (503)");
      }
      recorded.attached.push({
        evidenceKey: args.evidenceKey,
        testSuiteRunId: args.testSuiteRunId,
      });
    },
    executionComplete: async (args) => {
      recorded.completed.push({
        ...(args.stoppedReason ? { stoppedReason: args.stoppedReason } : {}),
      });
    },
    abort: async (args) => {
      recorded.aborted.push({ reason: args.reason, retryable: args.retryable });
    },
    heartbeat: options?.heartbeat ?? (async () => ({ leaseOk: true })),
    // Long enough that no beat fires unless a test advances the clock.
    heartbeatIntervalMs: 20_000,
  };

  return { deps, recorded };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("assertClaimExecutable", () => {
  // WAS: "refuses a job whose definition was republished after admission",
  // comparing a job-level `definitionHash` against `pins.definitionHash`. The
  // claim response carries ONE hash, so that compared a field with itself. The
  // republish check lives backend-side (`loadDefinition` re-hashes on read;
  // `claimNextBenchmarkJob` fails the job DEFINITION_UNRESOLVABLE). What is
  // left to assert here is that the pin arrived at all.
  it("refuses a claim that names no pinned definition", () => {
    expect(() =>
      assertClaimExecutable(job({ pins: { definitionHash: "" } })),
    ).toThrow(JobUnexecutableError);
  });

  it("refuses a rostered cell with no launch spec", () => {
    const claimed = job();
    claimed.roster = [
      {
        evidenceKey: "eval:a",
        kind: "eval_run",
        status: "expected",
        required: true,
        cellId: "a",
      },
    ];
    // No environmentId/namedHostId: the model this cell is supposed to run is
    // unknown, and launching it anyway would spend the payer's credits on an
    // exam the backend then refuses to attach.
    expect(() => assertClaimExecutable(claimed)).toThrow(JobUnexecutableError);
    expect(() => assertClaimExecutable(claimed)).toThrow(
      /environmentId\/namedHostId/,
    );
  });

  it("does not refuse the job over a cell that already ran", () => {
    // A terminal row owes no child, so it needs no launch spec. Refusing here
    // would strand a run that is nearly finished.
    const claimed = job();
    claimed.roster = [
      {
        evidenceKey: "eval:a",
        kind: "eval_run",
        status: "completed",
        required: true,
        cellId: "a",
      },
    ];
    expect(() => assertClaimExecutable(claimed)).not.toThrow();
  });

  it("refuses a claim carrying no grant", () => {
    expect(() => assertClaimExecutable(job({ grant: "" }))).toThrow(
      JobUnexecutableError,
    );
  });

  it("refuses a claim carrying no benchmark run id", () => {
    // The parent id is what LICENSES this job's children to carry the hidden
    // `benchmark` source: `startTestSuiteRun` refuses that source without a
    // live parent run (mcpjam-backend#1160). The claim type says `string`, but
    // it is hand-mirrored from the wire and absent fields are ignored rather
    // than rejected — so an older or changed backend reaches this worker as
    // `undefined`, and without this check every cell would fail at Convex with
    // an opaque FORBIDDEN, one lease and one MCP session in.
    expect(() => assertClaimExecutable(job({ benchmarkRunId: "" }))).toThrow(
      JobUnexecutableError,
    );
    expect(() =>
      assertClaimExecutable(
        job({ benchmarkRunId: undefined as unknown as string }),
      ),
    ).toThrow(JobUnexecutableError);
  });

  it("accepts a claim whose pins agree", () => {
    expect(() => assertClaimExecutable(job())).not.toThrow();
  });
});

describe("executeClaimedJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs one eval child per rostered cell and attaches each one", async () => {
    const { deps, recorded } = harness();
    await executeClaimedJob(job(), CLAIMED_BY, deps);

    expect(recorded.launched).toEqual(["a", "b"]);
    expect(recorded.attached).toEqual([
      { evidenceKey: "eval:a", testSuiteRunId: "run-a" },
      { evidenceKey: "eval:b", testSuiteRunId: "run-b" },
    ]);
    expect(recorded.completed).toEqual([{}]);
    expect(recorded.aborted).toEqual([]);
  });

  it("does not relaunch a cell whose evidence already reached a terminal status", async () => {
    // The resume case: a redelivered claim carries the roster as it stands, and
    // a settled row owes nothing. Relaunching would pay a second time for
    // evidence the run already holds.
    const claimed = job();
    claimed.roster = [
      cell("a", { status: "completed" }),
      cell("b", { status: "failed" }),
      cell("c", { status: "not_applicable" }),
      cell("d", { status: "running" }),
    ];

    const { deps, recorded } = harness();
    await executeClaimedJob(claimed, CLAIMED_BY, deps);

    expect(recorded.launched).toEqual(["d"]);
  });

  it("keys every child by benchmarkRunId + evidenceKey so a duplicate claim joins it", async () => {
    // Two workers claiming the same job compute the SAME key, so the eval
    // platform's idempotency lookup hands both the one child.
    const keys: string[] = [];
    const { deps } = harness({
      runEvalCell: async (args) => {
        keys.push(
          evalChildIdempotencyKey(
            args.job.benchmarkRunId,
            args.entry.evidenceKey,
          ),
        );
        return { runId: `run-${args.cell.cellId}`, executed: true };
      },
    });

    await executeClaimedJob(job(), CLAIMED_BY, deps);
    await executeClaimedJob(job(), CLAIMED_BY, deps);

    expect(keys).toEqual([
      "brun-1:eval:a",
      "brun-1:eval:b",
      "brun-1:eval:a",
      "brun-1:eval:b",
    ]);
  });

  it("caps read-only children at two in flight", async () => {
    const claimed = job();
    claimed.roster = ["a", "b", "c", "d", "e"].map((id) => cell(id));

    let inFlight = 0;
    let maxInFlight = 0;
    const release: Array<() => void> = [];
    const { deps, recorded } = harness({
      runEvalCell: async (args) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const gate = deferred<void>();
        release.push(gate.resolve);
        await gate.promise;
        inFlight--;
        return { runId: `run-${args.cell.cellId}`, executed: true };
      },
    });

    const running = executeClaimedJob(claimed, CLAIMED_BY, deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(maxInFlight).toBe(2);

    // Drain: each release admits the next queued cell, never a third at once.
    while (release.length) {
      release.shift()!();
      await vi.advanceTimersByTimeAsync(0);
    }
    await running;

    expect(maxInFlight).toBe(2);
    expect(recorded.completed).toEqual([{}]);
  });

  it("runs cells one at a time once the run may write at all", async () => {
    // The claim says nothing about which CELL writes — per-case side effects
    // live in the definition's `caseMetadata`, keyed by case. What it does say
    // is whether the payer consented to write cases at all, and a run that may
    // write anywhere is run strictly serially: two concurrent write cells
    // create artifacts on someone else's server at the same time, and a
    // list-style case then observes its sibling's.
    const claimed = job({
      consent: { authenticatedChecks: false, writeCases: true },
    });
    claimed.roster = [cell("w1"), cell("r1"), cell("w2"), cell("r2")];

    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const { deps } = harness({
      runEvalCell: async (args) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(args.cell.cellId);
        await Promise.resolve();
        inFlight--;
        return { runId: `run-${args.cell.cellId}`, executed: true };
      },
    });

    await executeClaimedJob(claimed, CLAIMED_BY, deps);

    expect(order).toEqual(["r1", "r2", "w1", "w2"]);
    expect(maxInFlight).toBe(1);
  });

  it("treats a cell with no declared side effects as a write cell", async () => {
    // Absent is not read-only. Two concurrent write cells create artifacts on
    // someone else's server at the same time, and a list-style case then sees
    // its sibling's.
    const claimed = job();
    const unknown = cell("u");
    // No consent decision at all on the wire: not "read only", just unsaid.
    (claimed as { consent?: unknown }).consent = undefined;
    claimed.roster = [unknown, cell("r1"), cell("r2")];

    const order: string[] = [];
    let inFlight = 0;
    let overlappedWithUnknown = false;
    const { deps } = harness({
      runEvalCell: async (args) => {
        order.push(args.cell.cellId);
        inFlight++;
        if (inFlight > 1 && order.includes("u")) overlappedWithUnknown = true;
        await Promise.resolve();
        inFlight--;
        return { runId: `run-${args.cell.cellId}`, executed: true };
      },
    });

    await executeClaimedJob(claimed, CLAIMED_BY, deps);

    // Ordering alone would not prove it — an unknown cell sorted last happens
    // to run last either way. What must hold is that it never shares the wire
    // with a sibling.
    expect(order).toEqual(["r1", "r2", "u"]);
    expect(overlappedWithUnknown).toBe(false);
  });

  it("stops launching, writes nothing, and abandons the job when the lease is lost", async () => {
    const claimed = job();
    claimed.roster = ["a", "b", "c", "d"].map((id) => cell(id));

    const release: Array<() => void> = [];
    const { deps, recorded } = harness({
      heartbeat: async () => ({ leaseOk: false }),
      runEvalCell: async (args) => {
        const gate = deferred<void>();
        release.push(gate.resolve);
        await gate.promise;
        return { runId: `run-${args.cell.cellId}`, executed: true };
      },
    });

    const running = executeClaimedJob(claimed, CLAIMED_BY, deps);
    await vi.advanceTimersByTimeAsync(0);
    // The first two are in flight; the beat takes the lease away.
    await vi.advanceTimersByTimeAsync(20_000);
    while (release.length) {
      release.shift()!();
      await vi.advanceTimersByTimeAsync(0);
    }
    await running;

    // The two queued behind them were never launched, their evidence was never
    // attached, and — the point — the worker filed no completion and no abort
    // for a job another worker now owns.
    expect(recorded.launched).toEqual(["a", "b"]);
    expect(recorded.attached).toEqual([]);
    expect(recorded.completed).toEqual([]);
    expect(recorded.aborted).toEqual([]);
  });

  it("treats a 409 lease_lost from a write route exactly like a failed heartbeat", async () => {
    const { deps, recorded } = harness({
      attachThrows: new LeaseLostError("attach rejected the lease generation"),
    });

    await executeClaimedJob(job(), CLAIMED_BY, deps);

    expect(recorded.completed).toEqual([]);
    expect(recorded.aborted).toEqual([]);
  });

  it("stops launching but still reports the phase when the run is cancelled", async () => {
    const claimed = job();
    claimed.roster = ["a", "b", "c", "d"].map((id) => cell(id));

    const release: Array<() => void> = [];
    const { deps, recorded } = harness({
      heartbeat: async () => ({ leaseOk: true, cancelRequested: true }),
      runEvalCell: async (args) => {
        const gate = deferred<void>();
        release.push(gate.resolve);
        await gate.promise;
        return { runId: `run-${args.cell.cellId}`, executed: true };
      },
    });

    const running = executeClaimedJob(claimed, CLAIMED_BY, deps);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    while (release.length) {
      release.shift()!();
      await vi.advanceTimersByTimeAsync(0);
    }
    await running;

    expect(recorded.launched).toEqual(["a", "b"]);
    // The lease is still ours, so the children that DID run are reported.
    expect(recorded.attached.map((a) => a.evidenceKey)).toEqual([
      "eval:a",
      "eval:b",
    ]);
    expect(recorded.completed).toEqual([{ stoppedReason: "cancelled" }]);
  });

  it("stops launching when the budget is exhausted", async () => {
    const claimed = job();
    claimed.roster = ["a", "b", "c"].map((id) => cell(id));

    const release: Array<() => void> = [];
    const { deps, recorded } = harness({
      heartbeat: async () => ({ leaseOk: true, budgetStatus: "exhausted" }),
      runEvalCell: async (args) => {
        const gate = deferred<void>();
        release.push(gate.resolve);
        await gate.promise;
        return { runId: `run-${args.cell.cellId}`, executed: true };
      },
    });

    const running = executeClaimedJob(claimed, CLAIMED_BY, deps);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    while (release.length) {
      release.shift()!();
      await vi.advanceTimersByTimeAsync(0);
    }
    await running;

    expect(recorded.launched).toEqual(["a", "b"]);
    expect(recorded.completed).toEqual([
      { stoppedReason: "budget_exhausted" },
    ]);
  });

  it("adopts a grant the heartbeat reissued, in the children already running", async () => {
    const claimed = job();
    claimed.roster = [cell("a")];

    const gate = deferred<void>();
    const seen: Array<Record<string, string>> = [];
    const { deps } = harness({
      // The backend spells a reissue `credentials: { grant, grantExpiresAt }`,
      // spread alongside the beat — there is no `result` wrapper and no
      // top-level `grant`.
      heartbeat: async () => ({
        leaseOk: true,
        credentials: { grant: "grant-token-2", grantExpiresAt: 9_000 },
      }),
      runEvalCell: async (args) => {
        seen.push(args.grantHeaders);
        await gate.promise;
        return { runId: "run-a", executed: true };
      },
    });

    const running = executeClaimedJob(claimed, CLAIMED_BY, deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen[0]["x-mcpjam-benchmark-grant"]).toBe("grant-token");

    await vi.advanceTimersByTimeAsync(20_000);
    // The SAME object the in-flight child is holding — a replaced object would
    // leave it stamping the expired grant for the rest of its steps.
    expect(seen[0]["x-mcpjam-benchmark-grant"]).toBe("grant-token-2");
    // And the JOB, because that is what every post-claim write sends. Rotating
    // one and not the other leaves half the job authenticating with a grant
    // that has expired.
    expect(claimed.grant).toBe("grant-token-2");
    expect(claimed.grantExpiresAt).toBe(9_000);

    gate.resolve();
    await running;
  });

  it("carries on when a cell cannot be launched at all", async () => {
    const claimed = job();
    claimed.roster = [cell("a"), cell("b")];

    const { deps, recorded } = harness({
      runEvalCell: async (args) => {
        if (args.cell.cellId === "a") {
          throw new Error("target refused the connection");
        }
        return { runId: `run-${args.cell.cellId}`, executed: true };
      },
    });

    await executeClaimedJob(claimed, CLAIMED_BY, deps);

    // No child was created, so there is no pointer to attach — but the sibling
    // is unaffected and the phase still closes, which is what turns the missing
    // cell into a coverage gap instead of a wedged run.
    expect(recorded.attached).toEqual([
      { evidenceKey: "eval:b", testSuiteRunId: "run-b" },
    ]);
    expect(recorded.completed).toEqual([{}]);
  });

  it("rides out a transient attach failure instead of losing the child", async () => {
    const claimed = job();
    claimed.roster = [cell("a")];

    const { deps, recorded } = harness({ attachThrowsTimes: 2 });

    const running = executeClaimedJob(claimed, CLAIMED_BY, deps);
    // Two backoffs, then the third call lands.
    await vi.advanceTimersByTimeAsync(5_000);
    await running;

    expect(recorded.attachAttempts).toBe(3);
    expect(recorded.attached).toEqual([
      { evidenceKey: "eval:a", testSuiteRunId: "run-a" },
    ]);
    expect(recorded.completed).toEqual([{}]);
    expect(recorded.aborted).toEqual([]);
  });

  it("hands the job back rather than reporting a phase that lost a child", async () => {
    // The unrecoverable one. `execution-complete` moves the run to
    // `awaiting_evidence` and a scorecard is inserted once and never patched,
    // so an unattached child that really ran is dropped from the result for
    // good — showing as a coverage gap that never existed. Another attempt
    // costs one requeue and re-attaches the same child rather than re-running
    // it.
    const claimed = job();
    claimed.roster = [cell("a"), cell("b")];

    const { deps, recorded } = harness({
      attachThrows: new Error("evidence attach rejected (503)"),
    });

    const running = executeClaimedJob(claimed, CLAIMED_BY, deps);
    await vi.advanceTimersByTimeAsync(30_000);
    await running;

    // Both cells ran, both exhausted the ladder, and NOTHING was reported as
    // complete.
    expect(recorded.launched).toEqual(["a", "b"]);
    expect(recorded.completed).toEqual([]);
    expect(recorded.aborted).toHaveLength(1);
    expect(recorded.aborted[0].retryable).toBe(true);
    expect(recorded.aborted[0].reason).toContain("eval:a");
    expect(recorded.aborted[0].reason).toContain("eval:b");
  });

  it("does not retry an attach the lease was taken away from", async () => {
    // A lost lease refuses every write, so retrying is pure delay — and the
    // whole point of standing down is to stop writing at all.
    const claimed = job();
    claimed.roster = [cell("a")];

    const { deps, recorded } = harness({
      attachThrows: new LeaseLostError("attach rejected the lease generation"),
    });

    await executeClaimedJob(claimed, CLAIMED_BY, deps);

    expect(recorded.attachAttempts).toBe(1);
    expect(recorded.completed).toEqual([]);
    expect(recorded.aborted).toEqual([]);
  });

  it("aborts non-retryably when the claim can never be executed", async () => {
    const { deps, recorded } = harness();
    await executeClaimedJob(
      job({ pins: { definitionHash: "" } }),
      CLAIMED_BY,
      deps,
    );

    expect(recorded.launched).toEqual([]);
    expect(recorded.aborted).toHaveLength(1);
    expect(recorded.aborted[0].retryable).toBe(false);
    expect(recorded.aborted[0].reason).toContain("pinned definition hash");
  });

  it("launches nothing and aborts non-retryably when a cell has no launch spec", async () => {
    // THE FINDING THIS LOCKS: the claim roster has no launch parameters on it,
    // so filtering the matrix by "has a spec" left `cells` empty and the worker
    // reported a complete execution phase having run nothing at all. A cell
    // that cannot be launched must end the job with a reason, never be dropped.
    const claimed = job();
    claimed.roster = [
      {
        evidenceKey: "eval:a",
        kind: "eval_run",
        status: "expected",
        required: true,
        cellId: "a",
      },
    ];
    const { deps, recorded } = harness();

    await executeClaimedJob(claimed, CLAIMED_BY, deps);

    expect(recorded.launched).toEqual([]);
    // The one thing that must not happen: reporting a clean phase.
    expect(recorded.completed).toEqual([]);
    expect(recorded.aborted).toHaveLength(1);
    expect(recorded.aborted[0].retryable).toBe(false);
    expect(recorded.aborted[0].reason).toContain("eval:a");
  });

  it("aborts retryably when the phase cannot be reported", async () => {
    const { deps, recorded } = harness();
    deps.executionComplete = async () => {
      throw new Error("convex unreachable");
    };

    await executeClaimedJob(job(), CLAIMED_BY, deps);

    expect(recorded.aborted).toHaveLength(1);
    expect(recorded.aborted[0].retryable).toBe(true);
  });

  it("ignores rostered evidence this lane does not own", async () => {
    const { deps, recorded } = harness();
    await executeClaimedJob(job(), CLAIMED_BY, deps);

    expect(recorded.attached.map((a) => a.evidenceKey)).not.toContain(
      "claude-readiness",
    );
  });
});

/**
 * ── THE BACKEND'S WORKER-FAMILY ROUTES, COPIED OUT OF ITS ROUTER ──────────
 *
 * Every `http.route({ path })` `registerBenchmarkJobRoutes` publishes under
 * `/internal/v1/bench` that the WORKER calls, transcribed from
 * `convex/benchmarkJobRoutes.ts` on `main`. The relay family (`/preflight`,
 * `/quotes`, `/runs`, `/runs/get`, `/runs/cancel`, `/results/get`) is
 * deliberately absent: those are called by `routes/web/bench.ts` on a person's
 * behalf and need a forwarded user bearer this process does not have.
 *
 * A path typo is invisible without this: the backend answers an unregistered
 * path with a bare 404, `isFeatureDisabled` reads a bare 404 as "benchmark
 * runs are switched off here", and the worker then parks on a slow poll
 * forever rather than reporting anything at all.
 */
const BACKEND_WORKER_ROUTES = [
  "/internal/v1/bench/jobs/claim",
  "/internal/v1/bench/jobs/heartbeat",
  "/internal/v1/bench/jobs/complete",
  "/internal/v1/bench/jobs/abort",
  "/internal/v1/bench/evidence/attach",
  "/internal/v1/bench/evidence/unobtainable",
  "/internal/v1/bench/artifacts",
  "/internal/v1/bench/evidence/claim-child",
  "/internal/v1/bench/evidence/probe",
  "/internal/v1/bench/runs/roster",
  "/internal/v1/bench/runs/finalize",
  "/internal/v1/bench/runs/execution-complete",
];

describe("service route paths", () => {
  it("matches the backend's registered worker routes exactly", () => {
    expect(Object.values(BENCH_SERVICE_ROUTES).slice().sort()).toEqual(
      BACKEND_WORKER_ROUTES.slice().sort(),
    );
  });

  it("reports the execution phase at /runs/execution-complete", () => {
    // THE FINDING THIS LOCKS: it was posted to `/jobs/execution-complete`,
    // which the backend does not register. Every call 404'd, the run never
    // reached `awaiting_evidence`, and nothing ever finalized.
    expect(BENCH_SERVICE_ROUTES.executionComplete).toBe(
      "/internal/v1/bench/runs/execution-complete",
    );
  });
});

describe("decodeClaimedJob", () => {
  const CLAIM_BODY = {
    ok: true,
    claimed: true,
    job: {
      jobId: "job-9",
      benchmarkRunId: "brun-9",
      organizationId: "org-9",
      projectId: "proj-9",
      serverId: "srv-9",
      leaseGeneration: 4,
      leaseExpiresAt: 1_700_000_090_000,
      deadlineAt: 1_700_003_600_000,
      heartbeatIntervalMs: 20_000,
      attempt: 1,
      maxAttempts: 3,
      cancelRequested: false,
    },
    pins: { definitionHash: "def-9", suiteId: "suite-9", consentHash: "c-9" },
    target: { targetKind: "server", targetKey: "k", serverUrl: TARGET_URL },
    consent: { authenticatedChecks: true, writeCases: false },
    payerKind: "org_credits",
    roster: [
      {
        evidenceKey: "eval:a",
        externalRunId: "benchmark:brun-9:eval:a",
        pillar: "agentic",
        kind: "eval_run",
        required: true,
        status: "expected",
        cellId: "a",
        repetitions: 3,
      },
    ],
    credentials: {
      grant: "grant-9",
      grantExpiresAt: 1_700_000_600_000,
      runnerBearer: "bearer-9",
      runnerBearerExpiresAt: 1_700_003_000_000,
    },
  };

  it("assembles the job from the claim's siblings, not from `claimed`", () => {
    // THE FINDING THIS LOCKS: `body.claimed` is the literal boolean `true`, and
    // casting it into the job type produced an object whose every property was
    // `undefined` — no ids, no grant, no bearer, no roster. Every claimed job
    // then died at `assertClaimExecutable` before launching anything.
    const decoded = decodeClaimedJob(CLAIM_BODY)!;

    expect(decoded.jobId).toBe("job-9");
    expect(decoded.benchmarkRunId).toBe("brun-9");
    expect(decoded.projectId).toBe("proj-9");
    expect(decoded.serverId).toBe("srv-9");
    expect(decoded.leaseGeneration).toBe(4);
    expect(decoded.grant).toBe("grant-9");
    expect(decoded.grantExpiresAt).toBe(1_700_000_600_000);
    expect(decoded.runnerBearer).toBe("bearer-9");
    expect(decoded.pins.definitionHash).toBe("def-9");
    expect(decoded.pins.suiteId).toBe("suite-9");
    expect(decoded.target.serverUrl).toBe(TARGET_URL);
    expect(decoded.consent).toEqual({
      authenticatedChecks: true,
      writeCases: false,
    });
    expect(decoded.roster).toHaveLength(1);
    expect(decoded.roster[0].cellId).toBe("a");
    expect(decoded.roster[0].repetitions).toBe(3);
  });

  it("reads an idle claim as no job", () => {
    expect(decodeClaimedJob({ ok: true, claimed: false, retryAfterMs: 5000 }))
      .toBeNull();
  });

  it("refuses a claim missing a credential rather than executing without it", () => {
    const body = {
      ...CLAIM_BODY,
      credentials: { runnerBearer: "bearer-9" },
    };
    expect(() => decodeClaimedJob(body)).toThrow(JobUnexecutableError);
    expect(() => decodeClaimedJob(body)).toThrow(/credentials\.grant/);
  });

  it("treats absent consent as consent to nothing", () => {
    const decoded = decodeClaimedJob({ ...CLAIM_BODY, consent: undefined })!;
    expect(decoded.consent).toEqual({
      authenticatedChecks: false,
      writeCases: false,
    });
  });
});

describe("resolveEvalCellSpec", () => {
  it("takes the exam from the pins and the cell from the roster row", () => {
    const claimed = job();
    const spec = resolveEvalCellSpec(claimed, cell("a"));
    expect(spec.cellId).toBe("a");
    expect(spec.suiteId).toBe("suite-1");
  });

  it("refuses a row whose model and client profile are unpinned", () => {
    const claimed = job();
    const entry: BenchmarkRosterEntry = {
      evidenceKey: "eval:a",
      kind: "eval_run",
      status: "expected",
      required: true,
      cellId: "a",
    };
    expect(() => resolveEvalCellSpec(claimed, entry)).toThrow(
      JobUnexecutableError,
    );
  });

  it("refuses a row when the claim pins no suite", () => {
    const claimed = job({ pins: { definitionHash: DEFINITION_HASH } });
    expect(() => resolveEvalCellSpec(claimed, cell("a"))).toThrow(
      /suiteId \(claim pins\)/,
    );
  });

  it("calls a cell read-only only when the run may not write at all", () => {
    expect(resolveEvalCellSpec(job(), cell("a")).writeCases).toBe(false);
    expect(
      resolveEvalCellSpec(
        job({ consent: { authenticatedChecks: false, writeCases: true } }),
        cell("a"),
      ).writeCases,
    ).toBe(true);
  });
});

describe("claim transport", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads a bare 404 as 'the feature is not enabled here'", async () => {
    // The backend halves land behind BENCHMARK_RUNS_ENABLED. Crash-looping
    // against a deployment that simply has not flipped the flag is the failure
    // this convention exists to prevent.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not found", { status: 404 }),
      ),
    );

    await expect(claimNextForTests(CLAIMED_BY)).resolves.toBe("disabled");
  });

  it("reads an ENTITY 404 as a real error, not a disabled feature", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "Not found" }), {
          status: 404,
        }),
      ),
    );

    await expect(claimNextForTests(CLAIMED_BY)).rejects.toThrow(
      /claim failed \(404\)/,
    );
  });

  it("refuses a 200 that carries no ok envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ claimed: null }), { status: 200 }),
      ),
    );

    await expect(claimNextForTests(CLAIMED_BY)).rejects.toThrow(
      /claim failed \(200\)/,
    );
  });

  it("never puts the claim body into the error it throws", async () => {
    // The claim answers with the execution grant and the runner bearer in it,
    // and this message reaches the logs, Sentry, and the abort reason the
    // backend stores. A credential that lands in any of those cannot be
    // recalled from them.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            claimed: { grant: "grant-secret", runnerBearer: "bearer-secret" },
          }),
          { status: 500 },
        ),
      ),
    );

    const error = await claimNextForTests(CLAIMED_BY).catch((e) => e);
    expect(String((error as Error).message)).toBe("claim failed (500)");
  });

  it("sends the service token and the caller id to the claim route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, claimed: null }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(claimNextForTests(CLAIMED_BY)).resolves.toBeNull();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://convex.test/internal/v1/bench/jobs/claim");
    expect(init.method).toBe("POST");
    expect(init.headers["x-inspector-service-token"]).toBe("service-token");
    expect(JSON.parse(init.body)).toEqual({ claimedBy: CLAIMED_BY });
  });

  it("returns a decoded job from a real claim, never the `claimed` flag", async () => {
    // THE FINDING THIS LOCKS: `claimNext` cast `body.claimed` — the literal
    // boolean `true` — into the job type, so `executeClaimedJob` received
    // `true` and every id, the grant, the bearer and the roster were
    // `undefined`.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            claimed: true,
            job: {
              jobId: "job-7",
              benchmarkRunId: "brun-7",
              organizationId: "org-7",
              projectId: "proj-7",
              serverId: "srv-7",
              leaseGeneration: 2,
            },
            pins: { definitionHash: "def-7", suiteId: "suite-7" },
            target: { serverUrl: TARGET_URL },
            consent: { authenticatedChecks: false, writeCases: false },
            roster: [
              {
                evidenceKey: "eval:a",
                kind: "eval_run",
                status: "expected",
                required: true,
                cellId: "a",
              },
            ],
            credentials: { grant: "grant-7", runnerBearer: "bearer-7" },
          }),
          { status: 200 },
        ),
      ),
    );

    const claimed = await claimNextForTests(CLAIMED_BY);

    expect(claimed).not.toBe(true);
    expect(typeof claimed).toBe("object");
    const decoded = claimed as ClaimedBenchmarkJob;
    expect(decoded.jobId).toBe("job-7");
    expect(decoded.grant).toBe("grant-7");
    expect(decoded.runnerBearer).toBe("bearer-7");
    expect(decoded.roster).toHaveLength(1);
  });

  it("never follows a redirect that would replay the service token", async () => {
    // THE FINDING THIS LOCKS: `fetch` follows redirects by default and replays
    // request headers to wherever it lands, so a 3xx would hand the service
    // token — which can claim, heartbeat and abort jobs — plus the execution
    // grant to another origin.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: "https://attacker.test/internal/v1/bench/jobs/claim" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(claimNextForTests(CLAIMED_BY)).rejects.toThrow(/redirected/);
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
  });

  it("refuses to send the service token over cleartext to a remote host", async () => {
    // Same policy `callBackend` applies in routes/web/bench.ts: HTTPS, or
    // loopback for local dev, and nothing else.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CONVEX_HTTP_URL", "http://convex.test");

    await expect(claimNextForTests(CLAIMED_BY)).rejects.toThrow(
      /non-HTTPS CONVEX_HTTP_URL/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still allows loopback over http, for local dev", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, claimed: false }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CONVEX_HTTP_URL", "http://127.0.0.1:3210");

    await expect(claimNextForTests(CLAIMED_BY)).resolves.toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:3210/internal/v1/bench/jobs/claim",
    );
  });

  it("refuses a non-http scheme rather than letting fetch report it as an outage", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("CONVEX_HTTP_URL", "ftp://localhost");

    await expect(claimNextForTests(CLAIMED_BY)).rejects.toThrow(
      /non-HTTPS CONVEX_HTTP_URL/,
    );
  });
});

describe("post-claim routes carry the execution grant", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function okFetch() {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, leaseOk: true }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  /** Every request the real deps make, keyed by path. */
  async function driveRealTransport(claimed: ClaimedBenchmarkJob) {
    const fetchMock = okFetch();
    // The default deps ARE the transport under test here — only the child
    // launch is stubbed, because that talks to an MCP server.
    await executeClaimedJob(claimed, CLAIMED_BY, {
      runEvalCell: async (args) => ({
        runId: `run-${args.cell.cellId}`,
        executed: true,
      }),
      heartbeat: async () => ({ leaseOk: true }),
      heartbeatIntervalMs: 20_000,
    });
    return fetchMock.mock.calls.map((call: any[]) => ({
      path: new URL(call[0] as string).pathname,
      grant: call[1].headers["x-mcpjam-benchmark-grant"] as string | undefined,
      body: JSON.parse(call[1].body as string),
    }));
  }

  it("sends the grant on attach and on execution-complete", async () => {
    // THE FINDING THIS LOCKS: the transport sent only the inspector service
    // token. The backend's `boundGrant()` reads the run, the job and the lease
    // generation out of `x-mcpjam-benchmark-grant` and answers 401 without it,
    // so every attach and every completion was refused.
    const claimed = job();
    claimed.roster = [cell("a")];

    const calls = await driveRealTransport(claimed);

    const attach = calls.find(
      (c) => c.path === "/internal/v1/bench/evidence/attach",
    );
    expect(attach?.grant).toBe("grant-token");
    const complete = calls.find(
      (c) => c.path === "/internal/v1/bench/runs/execution-complete",
    );
    expect(complete?.grant).toBe("grant-token");
  });

  it("attaches a conformance child as the conformance variant, with kind", async () => {
    // THE FINDING THIS LOCKS: the conformance payload omitted `kind`, so it
    // had no discriminator at all and `parseEvidenceAttachment` answered 400
    // — every persisted conformance child was rejected and the job stayed in
    // the unattached/retry path.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const claimed = job();
    claimed.roster = [
      {
        evidenceKey: "conformance",
        kind: "conformance_run",
        status: "expected",
        required: true,
        conformance: { suites: ["protocol"] },
      },
    ];

    await executeClaimedJob(claimed, CLAIMED_BY, {
      runConformanceChild: async () => ({ runId: "conf-1" }),
      heartbeat: async () => ({ leaseOk: true }),
      heartbeatIntervalMs: 20_000,
    });

    const attach = fetchMock.mock.calls
      .map((call: any[]) => ({
        path: new URL(call[0] as string).pathname,
        grant: call[1].headers["x-mcpjam-benchmark-grant"] as string,
        body: JSON.parse(call[1].body as string),
      }))
      .find((c) => c.path === "/internal/v1/bench/evidence/attach");

    expect(attach?.grant).toBe("grant-token");
    expect(attach?.body).toEqual({
      benchmarkRunId: "brun-1",
      kind: "conformance",
      conformanceRunId: "conf-1",
    });
  });

  it("attaches an eval child as the eval_cell variant the parser accepts", async () => {
    // THE FINDING THIS LOCKS: `/evidence/attach` parses a DISCRIMINATED
    // payload. Without `kind: "eval_cell"` it answers 400 `"kind" must be
    // conformance, readiness, eval_cell or auth_probe`; and the id field is
    // `suiteRunId`, not `testSuiteRunId`.
    const claimed = job();
    claimed.roster = [cell("a")];

    const calls = await driveRealTransport(claimed);
    const attach = calls.find(
      (c) => c.path === "/internal/v1/bench/evidence/attach",
    );

    expect(attach?.body).toEqual({
      benchmarkRunId: "brun-1",
      kind: "eval_cell",
      cellId: "a",
      suiteRunId: "run-a",
    });
  });
});

describe("heartbeat transport", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends the grant and its expiry, and reads the reissue off credentials", async () => {
    // THE FINDING THIS LOCKS: the reissued grant arrives at
    // `body.credentials.grant`, spread alongside the beat. The worker read
    // `body.result` / `body.grant`, so rotation never happened — and the
    // heartbeat carried no grant header at all, which `boundGrant()` answers
    // 401 to, so the very first beat failed.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          leaseOk: true,
          cancelRequested: false,
          budgetStatus: "active",
          runStatus: "running",
          credentials: { grant: "grant-2", grantExpiresAt: 1_800_000_000_000 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const beat = await sendHeartbeatForTests(job(), CLAIMED_BY);

    const call = fetchMock.mock.calls[0] as any[];
    expect(new URL(call[0] as string).pathname).toBe(
      "/internal/v1/bench/jobs/heartbeat",
    );
    expect(call[1].headers["x-mcpjam-benchmark-grant"]).toBe("grant-token");
    // What the backend compares against its reissue window. Absent reads as 0,
    // which asks for a fresh grant on every single beat.
    expect(JSON.parse(call[1].body as string).grantExpiresAt).toBe(
      4_000_000_000_000,
    );
    expect(beat.leaseOk).toBe(true);
    expect(beat.credentials?.grant).toBe("grant-2");
  });

  it("reads a 409 lease_lost as a lost lease, not a transport failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "lease_lost" }), {
          status: 409,
        }),
      ),
    );

    await expect(sendHeartbeatForTests(job(), CLAIMED_BY)).rejects.toThrow(
      LeaseLostError,
    );
  });
});

describe("startBenchWorker loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
    vi.stubEnv("CONVEX_URL", "https://convex.test");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("claims and executes one job at a time, then keeps polling", async () => {
    const claimed = job();
    const claim = vi
      .fn()
      .mockResolvedValueOnce(claimed)
      .mockResolvedValue(null);
    const execute = vi.fn().mockResolvedValue(undefined);

    const handle = startBenchWorker({ claim, execute });
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(20_000);
    void handle.stop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(claimed, expect.any(String));
    expect(claim.mock.calls.length).toBeGreaterThan(1);
  });

  it("backs off without executing when the backend reports the feature disabled", async () => {
    const claim = vi.fn().mockResolvedValue("disabled" as const);
    const execute = vi.fn();

    const handle = startBenchWorker({ claim, execute });
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(20_000);
    void handle.stop();
    await vi.advanceTimersByTimeAsync(70_000);

    expect(execute).not.toHaveBeenCalled();
  });

  it("survives claim errors with a backoff instead of crashing the loop", async () => {
    const claim = vi
      .fn()
      .mockRejectedValueOnce(new Error("backend down"))
      .mockResolvedValue(null);
    const execute = vi.fn();

    const handle = startBenchWorker({ claim, execute });
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(20_000);
    void handle.stop();
    await vi.advanceTimersByTimeAsync(70_000);

    expect(execute).not.toHaveBeenCalled();
    expect(claim.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not start without the Convex url the eval pipeline needs", async () => {
    // A deployment holding CONVEX_HTTP_URL but not CONVEX_URL would claim a
    // job, admit a budget against it, and fail every cell — the failure is
    // deeper than the claim, so it is checked before the loop starts.
    vi.stubEnv("CONVEX_URL", "");
    const claim = vi.fn();

    const handle = startBenchWorker({ claim });
    await vi.advanceTimersByTimeAsync(60_000);
    await handle.stop();

    expect(claim).not.toHaveBeenCalled();
  });
});
