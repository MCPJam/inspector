/**
 * The detached hosted worker: how a leased run ends.
 *
 * The backend already owns the durable half — claim, lease, recovery,
 * retention — and its guarantees are tested there. What is tested here is the
 * consumer's side of the same protocol, and specifically the four exits, since
 * three of them are failure paths that a reader only ever sees when something
 * has gone wrong:
 *
 *   1. A GOOD RUN FINALIZES with the summary the row is indexed on.
 *   2. A LOST LEASE WRITES NOTHING. The row was already decided by whoever
 *      took the lease away, and writing would either be rejected on the
 *      job-id guard or overwrite the verdict that replaced this one.
 *   3. A THROWN RUN FAILS THE ROW rather than stranding it `running` until the
 *      recovery cron reclaims a ten-minute concurrency slot spent on nothing.
 *   4. A RUN THAT DID NOT OPT IN HAS NO REQUESTER AT ALL, so it cannot spend.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const heartbeatReadinessRun = vi.fn();
const finalizeReadinessRun = vi.fn();
const failReadinessRun = vi.fn();
const requestManagedObservations = vi.fn();

// The real class, imported rather than restated: the worker distinguishes it
// with `instanceof`, and a look-alike would make the test pass while the
// production path fell through to the failure branch.
const { ReadinessLeaseLostError } = await import("../runner.js");

vi.mock("../backend-client.js", () => ({
  heartbeatReadinessRun: (...args: unknown[]) => heartbeatReadinessRun(...args),
  finalizeReadinessRun: (...args: unknown[]) => finalizeReadinessRun(...args),
  failReadinessRun: (...args: unknown[]) => failReadinessRun(...args),
  requestManagedObservations: (...args: unknown[]) =>
    requestManagedObservations(...args),
  ReadinessLeaseLostError,
}));

// DYNAMIC, and it has to stay that way. `vi.mock` is hoisted, but its factory
// runs when `../backend-client.js` is first imported — and the factory closes
// over `ReadinessLeaseLostError` from the import above. A static import of
// `../worker.js` could reach the binding before that import initialized it.
const { executeHostedReadinessRun, summarizeReadinessResult } = await import(
  "../worker.js"
);

const LEASE = { runId: "run_1", jobId: "job_1" };
const TARGET = "https://connector.example.com/mcp";

const INITIALIZE = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  serverInfo: { name: "demo", version: "1" },
};

const TOOL = {
  name: "search_docs",
  title: "Search docs",
  description: "Search the documentation corpus for a phrase.",
  inputSchema: { type: "object", properties: {} },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
};

function wireFetch(): typeof fetch {
  const table: Record<string, unknown> = {
    initialize: INITIALIZE,
    "tools/list": { tools: [TOOL] },
    "resources/list": { resources: [] },
  };
  return (async (_url: any, init?: any) => {
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method === "HEAD") return new Response(null, { status: 200 });
    if (method === "GET") return new Response("", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    const answer = table[String(body.method)];
    if (answer === undefined) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "unknown method" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result: answer }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  heartbeatReadinessRun.mockResolvedValue({ alive: true });
  finalizeReadinessRun.mockResolvedValue({ applied: true });
  failReadinessRun.mockResolvedValue({ applied: true });
  requestManagedObservations.mockResolvedValue({
    status: "billing-blocked",
    reason: "billing_limit_reached",
    detail: "no credits",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("a run that completes", () => {
  it("finalizes with the summary the row is indexed on", async () => {
    await executeHostedReadinessRun({
      lease: LEASE,
      publisher: "claude",
      target: TARGET,
      fetchFn: wireFetch(),
      includeLlmObservations: false,
      sdkVersion: "6.2.0",
    });

    expect(failReadinessRun).not.toHaveBeenCalled();
    expect(finalizeReadinessRun).toHaveBeenCalledTimes(1);
    const [lease, summary, report] = finalizeReadinessRun.mock.calls[0]!;
    expect(lease).toEqual(LEASE);
    expect(summary).toMatchObject({
      authMode: "headless",
      sdkVersion: "6.2.0",
      llmObservationStatus: "not-requested",
    });
    expect(summary.lanes.length).toBeGreaterThan(0);
    expect(summary.lanes[0]).toHaveProperty("missingInputs");
    // The report is the SDK result, handed over whole and stored opaquely.
    expect(
      (report as { findings?: unknown[] }).findings?.length,
    ).toBeGreaterThan(0);
  });

  it("omits the stage inventory for a publisher that has one rollup", async () => {
    // Sending an empty array would make the row claim a stage inventory Claude
    // does not have; its single rollup is already `overallStatus`.
    await executeHostedReadinessRun({
      lease: LEASE,
      publisher: "claude",
      target: TARGET,
      fetchFn: wireFetch(),
      includeLlmObservations: false,
    });
    const [, summary] = finalizeReadinessRun.mock.calls[0]!;
    expect(summary.stages).toBeUndefined();
  });

  it("carries both OpenAI stages onto the summary", async () => {
    await executeHostedReadinessRun({
      lease: LEASE,
      publisher: "openai",
      submissionMode: "mcp-only",
      target: TARGET,
      fetchFn: wireFetch(),
      includeLlmObservations: false,
    });
    const [, summary] = finalizeReadinessRun.mock.calls[0]!;
    expect(summary.stages).toHaveLength(2);
    expect(summary.stages?.map((stage: any) => stage.stage)).toEqual([
      "technical-preflight",
      "submission-ready",
    ]);
  });
});

describe("the observation opt-in", () => {
  it("passes no requester at all when the requester did not opt in", async () => {
    await executeHostedReadinessRun({
      lease: LEASE,
      publisher: "claude",
      target: TARGET,
      fetchFn: wireFetch(),
      includeLlmObservations: false,
    });
    // Not "does not ask" — cannot ask. There is nothing to call.
    expect(requestManagedObservations).not.toHaveBeenCalled();
  });

  it("still completes the run when the broker refuses for credit", async () => {
    await executeHostedReadinessRun({
      lease: LEASE,
      publisher: "claude",
      target: TARGET,
      fetchFn: wireFetch(),
      includeLlmObservations: true,
    });

    expect(requestManagedObservations).toHaveBeenCalledTimes(1);
    expect(failReadinessRun).not.toHaveBeenCalled();
    const [, summary] = finalizeReadinessRun.mock.calls[0]!;
    expect(summary.llmObservationStatus).toBe("billing-blocked");
    expect(summary.llmObservationReason).toBe("billing_limit_reached");
    // The deterministic verdict is unaffected: a payment problem belongs to
    // the account, not to the server under grading.
    expect(summary.overallStatus).toBeDefined();
  });

  it("hands the broker a prompt built from what the run actually saw", async () => {
    await executeHostedReadinessRun({
      lease: LEASE,
      publisher: "claude",
      target: TARGET,
      fetchFn: wireFetch(),
      includeLlmObservations: true,
    });
    const [lease, evidence] = requestManagedObservations.mock.calls[0]!;
    expect(lease).toEqual(LEASE);
    expect(String(evidence)).toContain("search_docs");
  });
});

describe("the failure exits", () => {
  it("writes nothing when the lease has moved on", async () => {
    requestManagedObservations.mockRejectedValue(new ReadinessLeaseLostError());
    await executeHostedReadinessRun({
      lease: LEASE,
      publisher: "claude",
      target: TARGET,
      fetchFn: wireFetch(),
      includeLlmObservations: true,
    });
    expect(finalizeReadinessRun).not.toHaveBeenCalled();
    expect(failReadinessRun).not.toHaveBeenCalled();
  });

  it("COMPLETES a run against a dead target rather than failing it", async () => {
    // A transport failure is a FINDING, not a crash: the gatherers absorb it
    // and the run reports a runtime blocker. That is the whole point of the
    // gather/grade split, and it is why "the gatherer threw" is not a path a
    // dead server can reach — a failed row would tell the submitter the run
    // broke, when what broke is their server.
    const exploding = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await executeHostedReadinessRun({
      lease: LEASE,
      publisher: "claude",
      target: TARGET,
      fetchFn: exploding,
      includeLlmObservations: false,
    });

    expect(failReadinessRun).not.toHaveBeenCalled();
    expect(finalizeReadinessRun).toHaveBeenCalledTimes(1);
    const [, summary] = finalizeReadinessRun.mock.calls[0]!;
    expect(summary.overallStatus).toBe("not-ready");
  });

  it("fails the row when an OpenAI run declares no submission mode", async () => {
    await executeHostedReadinessRun({
      lease: LEASE,
      publisher: "openai",
      target: TARGET,
      fetchFn: wireFetch(),
      includeLlmObservations: false,
    });

    expect(finalizeReadinessRun).not.toHaveBeenCalled();
    const [, terminalReason, message] = failReadinessRun.mock.calls[0]!;
    expect(terminalReason).toBe("runner_error");
    expect(String(message)).toMatch(/submission mode/i);
  });

  it("never throws out of the worker", async () => {
    finalizeReadinessRun.mockRejectedValue(new Error("ingest is down"));
    await expect(
      executeHostedReadinessRun({
        lease: LEASE,
        publisher: "claude",
        target: TARGET,
        fetchFn: wireFetch(),
        includeLlmObservations: false,
      }),
    ).resolves.toBeUndefined();
    // The finalize failed, so the run is recorded as failed rather than left
    // to the recovery cron.
    expect(failReadinessRun).toHaveBeenCalledTimes(1);
  });

  it("never throws even when the FAILURE write also fails", async () => {
    // Both writes go to the same backend. If ingest is down, the fallback is
    // down too — and a worker that threw out of its own fallback would strand
    // the run while passing the case above.
    finalizeReadinessRun.mockRejectedValue(new Error("ingest is down"));
    failReadinessRun.mockRejectedValue(new Error("ingest is down"));
    await expect(
      executeHostedReadinessRun({
        lease: LEASE,
        publisher: "claude",
        target: TARGET,
        fetchFn: wireFetch(),
        includeLlmObservations: false,
      }),
    ).resolves.toBeUndefined();
    // Swallowing the throw is only half of it. The worker must still have
    // ATTEMPTED the fallback write, or this test would pass identically
    // against a worker that caught the finalize failure and gave up — which
    // is the exact bug the case above is meant to be paired with.
    expect(failReadinessRun).toHaveBeenCalledTimes(1);
  });
});

describe("summarizeReadinessResult", () => {
  it("projects coverage per lane rather than summing it", () => {
    // A lane with zero violations and zero evaluated checks is not a pass, and
    // the only way to keep those apart is to publish the denominator.
    const summary = summarizeReadinessResult({
      status: "incomplete",
      summary: "",
      context: {
        target: TARGET,
        authMode: "headless",
        capabilities: ["dns"],
        evidenceSources: [],
      },
      lanes: [
        {
          lane: "directory-policy",
          status: "incomplete",
          summary: "",
          coverage: {
            lane: "directory-policy",
            evaluated: 0,
            notEvaluated: 3,
            notApplicable: 1,
            missingInputs: ["toolListing"],
          },
        },
      ],
      findings: [],
      badges: [],
      policySnapshotDate: "2026-08-19",
      engineVersion: "1",
      startedAt: "2026-08-20T00:00:00.000Z",
      durationMs: 10,
    } as never);

    expect(summary.lanes[0]).toEqual({
      lane: "directory-policy",
      status: "incomplete",
      evaluated: 0,
      notEvaluated: 3,
      notApplicable: 1,
      missingInputs: ["toolListing"],
    });
  });
});
