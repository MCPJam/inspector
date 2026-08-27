import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertClaimExecutable,
  claimNextForTests,
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

function cell(
  cellId: string,
  options?: { writeCases?: boolean; status?: BenchmarkRosterEntry["status"] },
): BenchmarkRosterEntry {
  return {
    evidenceKey: `eval:${cellId}`,
    kind: "eval_run",
    status: options?.status ?? "expected",
    required: true,
    repetitions: 1,
    evalCell: {
      cellId,
      suiteId: "suite-1",
      environmentId: `env-${cellId}`,
      namedHostId: null,
      writeCases: options?.writeCases ?? false,
    },
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
    definitionHash: DEFINITION_HASH,
    pins: { definitionHash: DEFINITION_HASH, consentHash: "consent-1" },
    roster: [
      // A pillar this lane does not own; it must be left entirely alone.
      {
        evidenceKey: "conformance",
        kind: "conformance_run",
        status: "expected",
        required: true,
      },
      cell("a"),
      cell("b"),
    ],
    grant: "grant-token",
    runnerBearer: "runner-bearer",
    ...overrides,
  };
}

type Recorded = {
  launched: string[];
  attached: Array<{ evidenceKey: string; testSuiteRunId: string }>;
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
}): { deps: Partial<BenchExecutionDeps>; recorded: Recorded } {
  const recorded: Recorded = {
    launched: [],
    attached: [],
    completed: [],
    aborted: [],
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
      if (options?.attachThrows) throw options.attachThrows;
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
  it("refuses a job whose definition was republished after admission", () => {
    expect(() =>
      assertClaimExecutable(
        job({ pins: { definitionHash: "def-hash-2" } }),
      ),
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
      },
    ];
    expect(() => assertClaimExecutable(claimed)).toThrow(JobUnexecutableError);
  });

  it("refuses a claim carrying no grant", () => {
    expect(() => assertClaimExecutable(job({ grant: "" }))).toThrow(
      JobUnexecutableError,
    );
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

  it("runs write cells one at a time, and only after every read-only cell", async () => {
    const claimed = job();
    claimed.roster = [
      cell("w1", { writeCases: true }),
      cell("r1"),
      cell("w2", { writeCases: true }),
      cell("r2"),
    ];

    const order: string[] = [];
    let writeInFlight = 0;
    let maxWriteInFlight = 0;
    const { deps } = harness({
      runEvalCell: async (args) => {
        const isWrite = args.cell.writeCases === true;
        if (isWrite) {
          writeInFlight++;
          maxWriteInFlight = Math.max(maxWriteInFlight, writeInFlight);
        }
        order.push(args.cell.cellId);
        await Promise.resolve();
        if (isWrite) writeInFlight--;
        return { runId: `run-${args.cell.cellId}`, executed: true };
      },
    });

    await executeClaimedJob(claimed, CLAIMED_BY, deps);

    expect(order.slice(0, 2).sort()).toEqual(["r1", "r2"]);
    expect(order.slice(2)).toEqual(["w1", "w2"]);
    expect(maxWriteInFlight).toBe(1);
  });

  it("treats a cell with no declared side effects as a write cell", async () => {
    // Absent is not read-only. Two concurrent write cells create artifacts on
    // someone else's server at the same time, and a list-style case then sees
    // its sibling's.
    const claimed = job();
    const unknown = cell("u");
    delete unknown.evalCell!.writeCases;
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
      heartbeat: async () => ({ leaseOk: true, grant: "grant-token-2" }),
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

  it("aborts non-retryably when the claim can never be executed", async () => {
    const { deps, recorded } = harness();
    await executeClaimedJob(
      job({ pins: { definitionHash: "def-hash-2" } }),
      CLAIMED_BY,
      deps,
    );

    expect(recorded.launched).toEqual([]);
    expect(recorded.aborted).toHaveLength(1);
    expect(recorded.aborted[0].retryable).toBe(false);
    expect(recorded.aborted[0].reason).toContain("definition hash changed");
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
      "conformance",
    );
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
