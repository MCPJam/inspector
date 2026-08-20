/**
 * Claude readiness worker — the loop, and what one claimed run puts on the
 * wire.
 *
 * The wire IS the contract here: the backend stores whatever summary this
 * posts and renders it, so a field that stops being sent becomes a run with no
 * verdict rather than a failure anyone notices.
 *
 * Three properties are worth the test rather than the reading:
 *
 *   1. A FAILED RUN IS REPORTED. Left unreported, the row sits `running` until
 *      the lease expires and recovery re-dials a third party's server for a
 *      run that already said why it cannot work.
 *   2. A RESULT WHOSE LEASE MOVED IS DISCARDED. The backend would reject it on
 *      the job id anyway; not posting keeps a blob from being stored for a row
 *      that will never read it.
 *   3. THE GRADE IS NOT POSTED AS THE SUMMARY. The summary is small and
 *      indexed; the report is opaque. Collapsing them would make adding a
 *      check a backend migration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runClaudeReadiness = vi.fn();
vi.mock("@mcpjam/sdk", () => ({
  runClaudeReadiness: (...args: unknown[]) => runClaudeReadiness(...args),
}));

const createStreamingPinnedFetch = vi.fn(() => globalThis.fetch);
vi.mock("../../utils/pinned-fetch.js", () => ({
  createStreamingPinnedFetch: (...args: unknown[]) =>
    createStreamingPinnedFetch(...(args as [])),
}));

// Imported after the mocks above are registered, so the worker picks them up.
const { executeClaimedRun, startClaudeReadinessWorker } = await import(
  "../claude-readiness-worker"
);

const CLAIM = {
  runId: "run-1",
  jobId: "job-1",
  serverUrl: "https://mcp.example.com/mcp",
  attemptCount: 1,
};

function readinessResult(status: "ready" | "not-ready" | "incomplete") {
  return {
    status,
    summary: "graded",
    policySnapshotDate: "2026-08-19",
    engineVersion: "1",
    context: {
      target: CLAIM.serverUrl,
      authMode: "headless",
      capabilities: ["dns", "raw-origin"],
    },
    lanes: [
      {
        lane: "runtime-compatibility",
        status,
        summary: "…",
        coverage: {
          evaluated: 4,
          notEvaluated: 1,
          notApplicable: 2,
          missingInputs: ["intrusive"],
        },
      },
    ],
    findings: [{ id: "claude.endpoint.https", status: "satisfied" }],
    badges: [],
  };
}

function mockServiceFetch(
  respond: (path: string) => unknown = () => ({ ok: true, applied: true }),
) {
  const calls: Array<{ path: string; body: any }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: JSON.parse(init.body) });
      return { status: 200, json: async () => respond(path) } as Response;
    }),
  );
  return calls;
}

describe("executeClaimedRun", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    // NOT covered by `restoreAllMocks`: a `stubGlobal` fetch survives it and
    // leaks into the loop tests below.
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    runClaudeReadiness.mockReset();
    createStreamingPinnedFetch.mockClear();
  });

  it("grades with the PINNED transport, not the global fetch", async () => {
    // Every URL a readiness run dials after the first is chosen by the target:
    // the redirect chain, the `resource_metadata` pointer, the authorization
    // server. On a hosted node that is the SSRF surface the guard exists for.
    runClaudeReadiness.mockResolvedValue(readinessResult("ready"));
    mockServiceFetch();

    await executeClaimedRun(CLAIM);

    expect(createStreamingPinnedFetch).toHaveBeenCalledWith(
      expect.objectContaining({ hosted: true }),
    );
    const config = runClaudeReadiness.mock.calls[0]![0] as {
      serverUrl: string;
      fetchFn: unknown;
      capabilities: string[];
    };
    expect(config.serverUrl).toBe(CLAIM.serverUrl);
    expect(config.fetchFn).toBe(createStreamingPinnedFetch.mock.results[0]!.value);
    // The hosted node has no browser and no interactive authorization, and
    // says so rather than letting those checks look unevaluated for no reason.
    expect(config.capabilities).toEqual(["dns", "raw-origin"]);
  });

  it("posts the indexed summary beside the opaque report", async () => {
    runClaudeReadiness.mockResolvedValue(readinessResult("not-ready"));
    const calls = mockServiceFetch();

    await executeClaimedRun(CLAIM);

    const ingest = calls.find(
      (call) => call.path === "/internal/v1/claude-readiness/runs",
    );
    expect(ingest).toBeDefined();
    expect(ingest!.body).toMatchObject({
      runId: "run-1",
      jobId: "job-1",
      overallStatus: "not-ready",
      authMode: "headless",
      policySnapshotDate: "2026-08-19",
      engineVersion: "1",
    });
    // Coverage travels flattened, because the row indexes it and a UI renders
    // it without opening the blob.
    expect(ingest!.body.lanes[0]).toEqual({
      lane: "runtime-compatibility",
      status: "not-ready",
      evaluated: 4,
      notEvaluated: 1,
      notApplicable: 2,
      missingInputs: ["intrusive"],
    });
    // And the whole graded result rides as the report.
    expect(ingest!.body.report.findings).toHaveLength(1);
  });

  it("reports a failed run instead of leaving the row to the lease sweep", async () => {
    runClaudeReadiness.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const calls = mockServiceFetch();

    await executeClaimedRun(CLAIM);

    const failure = calls.find((call) => call.body?.outcome === "failed");
    expect(failure).toBeDefined();
    expect(failure!.body).toMatchObject({
      runId: "run-1",
      jobId: "job-1",
      terminalReason: "runner_error",
    });
    expect(failure!.body.errorMessage).toMatch(/ECONNREFUSED/);
  });

  it("never throws, so one bad run cannot stop the loop", async () => {
    runClaudeReadiness.mockRejectedValue(new Error("boom"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("backend unreachable");
      }),
    );
    await expect(executeClaimedRun(CLAIM)).resolves.toBeUndefined();
  });
});

describe("startClaudeReadinessWorker loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function flushLoop(times = 6) {
    return (async () => {
      for (let i = 0; i < times; i++) {
        await vi.advanceTimersByTimeAsync(20_000);
      }
    })();
  }

  it("stays inert without the service-token env — the only gate there is", async () => {
    // No flag guards this worker, so a deployment that is not an
    // infrastructure peer must self-gate here or every local dev inspector
    // would start polling somebody's backend.
    vi.unstubAllEnvs();
    const claim = vi.fn();

    const handle = startClaudeReadinessWorker({ claim });
    await flushLoop();
    await handle.stop();

    expect(claim).not.toHaveBeenCalled();
  });

  it("claims, executes, and keeps polling", async () => {
    const claim = vi
      .fn()
      .mockResolvedValueOnce({ kind: "claimed", claim: CLAIM })
      .mockResolvedValue({ kind: "empty" });
    const execute = vi.fn().mockResolvedValue(undefined);

    const handle = startClaudeReadinessWorker({ claim, execute });
    await flushLoop();
    await handle.stop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(CLAIM);
    expect(claim.mock.calls.length).toBeGreaterThan(1);
  });

  it("backs off hard when the claim route is not deployed", async () => {
    // A 404 means the backend does not serve the route yet. Polling it every
    // ten seconds would be a busy loop against a deployment that is fine.
    const claim = vi.fn().mockResolvedValue({ kind: "disabled" });
    const execute = vi.fn();

    const handle = startClaudeReadinessWorker({ claim, execute });
    await flushLoop(3);
    await handle.stop();
    await vi.advanceTimersByTimeAsync(70_000);

    expect(claim.mock.calls.length).toBeLessThan(3);
    expect(execute).not.toHaveBeenCalled();
  });

  it("survives claim errors with a backoff instead of crashing the loop", async () => {
    const claim = vi
      .fn()
      .mockRejectedValueOnce(new Error("backend down"))
      .mockResolvedValue({ kind: "empty" });
    const execute = vi.fn();

    const handle = startClaudeReadinessWorker({ claim, execute });
    await flushLoop(10);
    await handle.stop();
    await vi.advanceTimersByTimeAsync(70_000);

    expect(claim.mock.calls.length).toBeGreaterThan(1);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("a run whose lease moved", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    runClaudeReadiness.mockReset();
    createStreamingPinnedFetch.mockClear();
  });

  /** A heartbeat that reports the lease gone, and everything else as normal. */
  function mockLeaseLostFetch() {
    const calls: Array<{ path: string; body: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        const path = new URL(url).pathname;
        calls.push({ path, body: JSON.parse(init.body) });
        return {
          status: 200,
          json: async () =>
            path.endsWith("/heartbeat")
              ? { ok: true, alive: false }
              : { ok: true, applied: true },
        } as Response;
      }),
    );
    return calls;
  }

  it("aborts the run rather than letting it keep dialling", async () => {
    vi.useFakeTimers();
    try {
      mockLeaseLostFetch();
      let observed: AbortSignal | undefined;
      runClaudeReadiness.mockImplementation(async (config: any) => {
        observed = config.signal;
        // Never resolves on its own: the abort is what has to end this.
        await new Promise((_resolve, reject) => {
          config.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        });
      });

      const run = executeClaimedRun(CLAIM);
      // Past the first heartbeat, which answers `alive: false`.
      await vi.advanceTimersByTimeAsync(61_000);
      await run;

      expect(observed?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never files a cancellation as a connector failure", async () => {
    vi.useFakeTimers();
    try {
      const calls = mockLeaseLostFetch();
      runClaudeReadiness.mockImplementation(async (config: any) => {
        await new Promise((_resolve, reject) => {
          config.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        });
      });

      const run = executeClaimedRun(CLAIM);
      await vi.advanceTimersByTimeAsync(61_000);
      await run;

      // `runner_error` here would say the connector broke, when in fact
      // somebody pressed cancel.
      expect(calls.some((call) => call.body?.outcome === "failed")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a result that finished into a moved lease", async () => {
    vi.useFakeTimers();
    try {
      const calls = mockLeaseLostFetch();
      runClaudeReadiness.mockImplementation(async () => {
        // Outlives the first heartbeat, then succeeds anyway.
        await new Promise((resolve) => setTimeout(resolve, 90_000));
        return readinessResult("ready");
      });

      const run = executeClaimedRun(CLAIM);
      await vi.advanceTimersByTimeAsync(120_000);
      await run;

      // Storing a report for a row that will never read it is a blob nothing
      // frees; the backend would reject the write on the job id regardless.
      expect(
        calls.some(
          (call) =>
            call.path === "/internal/v1/claude-readiness/runs" &&
            call.body?.report !== undefined,
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
