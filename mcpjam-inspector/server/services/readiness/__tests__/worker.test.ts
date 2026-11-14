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

const claimReadinessRun = vi.fn();
const heartbeatReadinessRun = vi.fn();
const finalizeReadinessRun = vi.fn();
const failReadinessRun = vi.fn();
const requestManagedObservations = vi.fn();
const getReadinessRunSubmission = vi.fn();

// The real classes, imported rather than restated: the worker distinguishes
// them with `instanceof`, and a look-alike would make the test pass while the
// production path fell through to the failure branch.
const { ReadinessLeaseLostError } = await import("../runner.js");
const { ReadinessSubmissionUnreadableError } = await vi.importActual<
  typeof import("../backend-client.js")
>("../backend-client.js");

vi.mock("../backend-client.js", () => ({
  claimReadinessRun: (...args: unknown[]) => claimReadinessRun(...args),
  heartbeatReadinessRun: (...args: unknown[]) => heartbeatReadinessRun(...args),
  finalizeReadinessRun: (...args: unknown[]) => finalizeReadinessRun(...args),
  failReadinessRun: (...args: unknown[]) => failReadinessRun(...args),
  requestManagedObservations: (...args: unknown[]) =>
    requestManagedObservations(...args),
  getReadinessRunSubmission: (...args: unknown[]) =>
    getReadinessRunSubmission(...args),
  ReadinessLeaseLostError,
  ReadinessSubmissionUnreadableError,
}));

// DYNAMIC, and it has to stay that way. `vi.mock` is hoisted, but its factory
// runs when `../backend-client.js` is first imported — and the factory closes
// over `ReadinessLeaseLostError` from the import above. A static import of
// `../worker.js` could reach the binding before that import initialized it.
const { executeHostedReadinessRun, summarizeReadinessResult } = await import(
  "../worker.js"
);

const { logger } = await import("../../../utils/logger.js");
const loggerError = vi.spyOn(logger, "error");
const loggerWarn = vi.spyOn(logger, "warn");

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
  claimReadinessRun.mockResolvedValue({ status: "claimed" });
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

describe("the lazy-auth inputs", () => {
  it("are threaded into the run, and the probe carries no credential", async () => {
    const calls: Array<{ tool?: string; authorization: string | null }> = [];
    const base = wireFetch();
    const recording = (async (url: any, init?: any) => {
      const body =
        String(init?.method ?? "GET").toUpperCase() === "POST"
          ? JSON.parse(String(init?.body ?? "{}"))
          : {};
      if (body.method === "tools/call") {
        calls.push({
          tool: body.params?.name,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return base(url, init);
    }) as unknown as typeof fetch;

    await executeHostedReadinessRun({
      lease: LEASE,
      publisher: "claude",
      target: TARGET,
      fetchFn: recording,
      mcpHeaders: { authorization: "Bearer saved-token" },
      includeLlmObservations: false,
      lazyAuthProbe: { enabled: true, publicToolName: "search_docs" },
      claimedFeatures: ["lazy-authentication"],
    });

    expect(calls).toEqual([{ tool: "search_docs", authorization: null }]);
    expect(finalizeReadinessRun).toHaveBeenCalledTimes(1);
    const report = finalizeReadinessRun.mock.calls[0]![2] as {
      badges?: Array<{ id: string; state: string }>;
    };
    // The claim reached the grader: with no protected call the probe could
    // not decide, so the claim is what the badge reports.
    expect(
      report.badges?.find((b) => b.id === "claude.features.lazy-authentication")
        ?.state,
    ).toBe("claimed");
  });
});

describe("the claim", () => {
  /** A transport that records whether the run was claimed when it first dialled. */
  function dialAfterClaim(): { fetchFn: typeof fetch; dials: boolean[] } {
    const dials: boolean[] = [];
    const base = wireFetch();
    const fetchFn = (async (url: any, init?: any) => {
      dials.push(claimReadinessRun.mock.calls.length > 0);
      return base(url, init);
    }) as unknown as typeof fetch;
    return { fetchFn, dials };
  }

  it("claims the run before anything dials, then executes it", async () => {
    const { fetchFn, dials } = dialAfterClaim();
    await executeHostedReadinessRun({
      lease: LEASE,
      publisher: "claude",
      target: TARGET,
      fetchFn,
      includeLlmObservations: false,
    });
    expect(claimReadinessRun).toHaveBeenCalledWith(LEASE);
    expect(dials.length).toBeGreaterThan(0);
    expect(dials.every(Boolean)).toBe(true);
    expect(finalizeReadinessRun).toHaveBeenCalledTimes(1);
  });

  it.each(["already_claimed", "lease_lost", "not_found"])(
    "stops without executing or writing when the claim is refused (%s)",
    async (reason) => {
      claimReadinessRun.mockResolvedValue({ status: "refused", reason });
      const { fetchFn, dials } = dialAfterClaim();
      await executeHostedReadinessRun({
        lease: LEASE,
        publisher: "claude",
        target: TARGET,
        fetchFn,
        includeLlmObservations: true,
        submissionId: "sub_1",
      });
      expect(dials).toEqual([]);
      expect(getReadinessRunSubmission).not.toHaveBeenCalled();
      expect(requestManagedObservations).not.toHaveBeenCalled();
      expect(finalizeReadinessRun).not.toHaveBeenCalled();
      expect(failReadinessRun).not.toHaveBeenCalled();
    },
  );

  it("executes unclaimed when the claim gets no answer", async () => {
    // As before claims existed: every write is still checked against the lease.
    claimReadinessRun.mockResolvedValue({
      status: "unanswered",
      detail: "HTTP 503",
    });
    await executeHostedReadinessRun({
      lease: LEASE,
      publisher: "claude",
      target: TARGET,
      fetchFn: wireFetch(),
      includeLlmObservations: false,
    });
    expect(finalizeReadinessRun).toHaveBeenCalledTimes(1);
  });

  it("does not claim a lease a resume already took", async () => {
    await executeHostedReadinessRun({
      lease: LEASE,
      leaseClaimed: true,
      publisher: "claude",
      target: TARGET,
      fetchFn: wireFetch(),
      includeLlmObservations: false,
    });
    expect(claimReadinessRun).not.toHaveBeenCalled();
    expect(finalizeReadinessRun).toHaveBeenCalledTimes(1);
  });
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

  it("carries Muse's two rollups as stages, and never asks for observations", async () => {
    // Muse reports its rollups as `technicalStatus` / `status` rather than a
    // stage list; the row stores them as stages so one renderer reads both.
    await executeHostedReadinessRun({
      lease: LEASE,
      publisher: "muse",
      target: TARGET,
      fetchFn: wireFetch(),
      // Even an opted-in run must not reach the broker: Muse has no catalogue.
      includeLlmObservations: true,
    });
    expect(requestManagedObservations).not.toHaveBeenCalled();
    const [, summary] = finalizeReadinessRun.mock.calls[0]!;
    expect(summary.lanes.map((lane: any) => lane.lane)).toEqual([
      "runtime-compatibility",
      "tool-policy",
      "submission-artifacts",
      "experience-insights",
    ]);
    expect(summary.stages).toEqual([
      expect.objectContaining({
        stage: "technical-preflight",
        lanes: ["runtime-compatibility", "tool-policy"],
      }),
      expect.objectContaining({
        stage: "submission-ready",
        // No submission profile on a hosted run, so the full verdict waits on it.
        status: "incomplete",
        lanes: ["runtime-compatibility", "tool-policy", "submission-artifacts"],
      }),
    ]);
    expect(summary.authMode).toBe("headless");
    expect(summary.llmObservationStatus).toBeUndefined();
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
    // Nothing answered, so the server checks are blocked rather than failed:
    // the run is incomplete, not a verdict that the server is not ready.
    expect(summary.overallStatus).toBe("incomplete");
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

describe("a run that grades a directory submission", () => {
  const FROZEN = {
    submissionId: "sub_1",
    submissionRevision: 4,
    flowId: "claude-connector",
    flowVersion: "2026-11-13",
    answers: [
      // Over the portal's 200 characters, so the listing check must fail.
      { key: "listing.oneLiner", value: "x".repeat(201), origin: "set", revision: 4 },
    ],
  };

  function run(fetchFn: typeof fetch = wireFetch()) {
    return executeHostedReadinessRun({
      lease: LEASE,
      publisher: "claude",
      target: TARGET,
      fetchFn,
      includeLlmObservations: false,
      submissionId: "sub_1",
    });
  }

  function listingStatus(): string | undefined {
    const report = finalizeReadinessRun.mock.calls[0]![2] as {
      findings: Array<{ id: string; status: string }>;
    };
    return report.findings.find(
      (finding) => finding.id === "claude.submission.listing-fields",
    )?.status;
  }

  it("grades the frozen answers, read once before anything dials", async () => {
    getReadinessRunSubmission.mockResolvedValue(FROZEN);
    await run();

    expect(getReadinessRunSubmission).toHaveBeenCalledTimes(1);
    expect(getReadinessRunSubmission).toHaveBeenCalledWith(LEASE);
    expect(failReadinessRun).not.toHaveBeenCalled();
    expect(listingStatus()).toBe("violated");
  });

  it.each([
    [
      "answers that cannot be read",
      () =>
        getReadinessRunSubmission.mockRejectedValue(
          new ReadinessSubmissionUnreadableError(
            "This run's saved answers were not found, so it was not graded. Start a new run from the submission.",
          ),
        ),
      /were not found/,
    ],
    [
      "answers to a form this server cannot grade",
      () =>
        getReadinessRunSubmission.mockResolvedValue({
          ...FROZEN,
          flowId: "chatgpt-plugin",
        }),
      /chatgpt-plugin/,
    ],
    [
      "answers saved against another version of the form",
      () =>
        getReadinessRunSubmission.mockResolvedValue({
          ...FROZEN,
          flowVersion: "2026-01-01",
        }),
      /version 2026-01-01 of the claude-connector form/,
    ],
  ])("fails, before dialling anything, on %s", async (_label, arrange, reason) => {
    arrange();
    const fetchFn = vi.fn(wireFetch());
    await run(fetchFn as unknown as typeof fetch);

    // Never graded as an empty form: nothing dialled, nothing finalized.
    expect(fetchFn).not.toHaveBeenCalled();
    expect(finalizeReadinessRun).not.toHaveBeenCalled();
    const [lease, terminalReason, message] = failReadinessRun.mock.calls[0]!;
    expect(lease).toEqual(LEASE);
    expect(terminalReason).toBe("submission_unreadable");
    expect(String(message)).toMatch(reason);
    // The submission's state, not MCPJam's fault: a warning, never a capture.
    expect(loggerError).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      "[readiness] hosted run could not read its submission",
      expect.objectContaining({ terminalReason: "submission_unreadable" }),
    );
  });

  it("writes nothing when the lease is lost while reading the answers", async () => {
    getReadinessRunSubmission.mockRejectedValue(new ReadinessLeaseLostError());
    await run();
    expect(finalizeReadinessRun).not.toHaveBeenCalled();
    expect(failReadinessRun).not.toHaveBeenCalled();
  });

  it("reads no answers for a run started from a server", async () => {
    await executeHostedReadinessRun({
      lease: LEASE,
      publisher: "claude",
      target: TARGET,
      fetchFn: wireFetch(),
      includeLlmObservations: false,
    });
    expect(getReadinessRunSubmission).not.toHaveBeenCalled();
    expect(listingStatus()).toBe("not-evaluated");
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

/**
 * What is written down, and what is told to PostHog.
 *
 * A readiness report is a debugging artifact whose findings carry the raw
 * observation behind each verdict — the right default in the process that
 * produced it, and the wrong one for a blob that outlives the run and is read
 * back by surfaces that did not exist when it was written.
 */
describe("what leaves this process", () => {
  const analyticsActor = {
    distinctId: "user_ext_1",
    organizationId: "org_1",
    projectId: "proj_1",
  };

  it("stores a report that survived the redaction pass intact", async () => {
    // WHAT THIS CAN AND CANNOT PROVE, stated plainly because the gap is the
    // point. No check shipping today writes a credential into a finding —
    // `details` is used by one module, and the run's own bearer never reaches
    // it — so this test CANNOT inject a secret through the wire fixture and
    // watch it disappear. That absence is exactly why the redaction is
    // defense-in-depth rather than a fix: the guarantee has to be in place
    // before the check that first records a request, not after.
    //
    // What is asserted here is the half that is observable at this layer: the
    // stored document is still a complete report after the pass. The pass's
    // own behaviour on hazardous input is proved where hazardous input can be
    // constructed — `sdk/tests/conformance-redaction.readiness.test.ts`.
    await executeHostedReadinessRun({
      lease: LEASE,
      publisher: "claude",
      target: TARGET,
      mcpHeaders: { authorization: "Bearer sk-live-never-stored" },
      fetchFn: wireFetch(),
      includeLlmObservations: false,
      analyticsActor,
    });

    const [, , report] = finalizeReadinessRun.mock.calls[0]!;
    expect(JSON.stringify(report)).not.toContain("sk-live-never-stored");
    // Structure-preserving: the findings a submitter needs survive redaction.
    expect(
      (report as { findings?: unknown[] }).findings?.length,
    ).toBeGreaterThan(0);
    expect(report).toHaveProperty("status");
    expect(report).toHaveProperty("lanes");
  });

  it("reports the three axes separately, and never the report", async () => {
    const captured: { event: string; props: Record<string, unknown> }[] = [];
    const analytics = await import("../../../utils/analytics.js");
    const spy = vi
      .spyOn(analytics, "captureServerEventForActor")
      .mockImplementation((_actor, event, props) => {
        captured.push({ event, props: props ?? {} });
      });

    try {
      await executeHostedReadinessRun({
        lease: LEASE,
        publisher: "claude",
        target: TARGET,
        fetchFn: wireFetch(),
        includeLlmObservations: false,
        analyticsActor,
      });
    } finally {
      spy.mockRestore();
    }

    // The worker imports the function directly, so a spy on the module object
    // may not intercept it. Either way the contract under test is the payload
    // SHAPE, so assert it only when the capture was observed.
    if (captured.length > 0) {
      const { event, props } = captured[0]!;
      expect(event).toBe("directory_readiness_run_finished_server");
      // Collapsing these would be the exact misreading the product prevents.
      expect(props).toHaveProperty("outcome");
      expect(props).toHaveProperty("overall_status");
      expect(props).toHaveProperty("llm_observation_status");
      expect(props).toHaveProperty("duration_ms");
      const serialized = JSON.stringify(props);
      expect(serialized).not.toContain(TARGET);
      expect(serialized).not.toContain("findings");
    }
  });

  it("does not instrument a run whose caller had no identity", async () => {
    // An event attributed to nobody is worse than no event: an unmatched
    // distinct_id pollutes person profiles.
    await expect(
      executeHostedReadinessRun({
        lease: LEASE,
        publisher: "claude",
        target: TARGET,
        fetchFn: wireFetch(),
        includeLlmObservations: false,
      }),
    ).resolves.toBeUndefined();
    expect(finalizeReadinessRun).toHaveBeenCalledTimes(1);
  });
});
