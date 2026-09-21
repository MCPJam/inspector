import { ERROR_MESSAGES } from "@/lib/error-messages";
/**
 * The controller's contract: one request per click, one controller per scope,
 * and an older backend that says so instead of failing silently.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useUnifiedFindings } from "../use-unified-findings";
import type {
  ActionableFinding,
  InsightsEnvelope,
} from "@/lib/insights-envelope-api";

const mutation = vi.hoisted(() => ({
  fn: vi.fn(async () => ({ jobId: "job-1" })),
}));
vi.mock("convex/react", () => ({
  useMutation: () => mutation.fn,
}));

/** The measured finding, as the backend's deterministic view projects it. */
const MEASURED: ActionableFinding = {
  id: "rf_aaaa000000000001",
  signalFingerprint: "sha256:fingerprint",
  title:
    '`search` refused the call for lack of authorization in 3 of 8 iterations: "Authentication failed (-32001)"',
  category: "environment",
  attribution: "unknown",
  actionTarget: "investigate",
  actionability: "investigate",
  severity: "medium",
  confidence: "low",
  observed:
    '`search` refused the call for lack of authorization in 3 of 8 iterations: "Authentication failed (-32001)"',
  recommendation:
    "The server required authorization the run did not have. Fix the credentials or OAuth setup for `search`'s server in this environment, then rerun.",
  acceptanceCriteria: [],
  affected: { count: 3, total: 8, unit: "iterations" },
  evidence: [
    {
      iterationId: "it_fail_1",
      kind: "tool_error",
      excerpt: "Tool: search Error: Authentication failed (-32001)",
      toolName: "search",
      errorCode: "-32001",
    },
  ],
};

/** The same finding once a pipeline row explained it. */
const EXPLAINED: ActionableFinding = {
  ...MEASURED,
  title: "Expired CRM credential",
  attribution: "environment",
  actionTarget: "environment",
  confidence: "medium",
  rootCause: "The pinned token expired mid-run.",
  recommendation:
    "Refresh the acme-crm credential in the run environment and re-run the suite.",
  acceptanceCriteria: ["search returns 200 for the same query"],
};

/** A settled run with a built snapshot and a current enrichment. */
const ENVELOPE: InsightsEnvelope = {
  schemaVersion: 1,
  scope: { kind: "eval_run", id: "run_1" },
  status: "completed",
  reasonCode: null,
  retryable: false,
  error: null,
  generatedAt: 1_757_800_000_000,
  updatedAt: 1_757_800_000_000,
  summary: "A previous analysis.",
  coverage: {
    unit: "iterations",
    analyzed: 8,
    total: 8,
    gradedCount: 8,
    truncated: false,
    lowConfidence: false,
  },
  findings: [],
  currentFindings: [EXPLAINED],
  observationState: "ready",
  observationCoverage: {
    unit: "iterations",
    analyzed: 8,
    total: 8,
    gradedCount: 0,
    exclusions: { cancelled: 0, chainMissing: 0 },
  },
  unifiedFindings: {
    capability: "unified_findings_v1",
    snapshot: {
      builtAt: 1_757_800_000_000,
      sourceRevision: "sha256:rev-1",
      minerVersion: 1,
      omittedGroups: 0,
      deterministicFindings: [MEASURED],
      provenance: [
        {
          candidateId: MEASURED.id,
          groupKind: "tool_failure",
          basis: "measured",
          classificationBasis: "error_text",
          mechanismBasis: "complete",
          affectedIterationIds: ["it_fail_1", "it_fail_2", "it_fail_3"],
          proseOrigin: {
            observed: "deterministic",
            title: "ai",
            rootCause: "ai",
            recommendation: "ai",
            acceptanceCriteria: "ai",
          },
        },
      ],
      enrichment: {
        status: "ready",
        generatedAt: 1_757_800_100_000,
        modelUsed: "z-ai/glm-5.3-flash",
        discovery: {
          reviewedIterations: 8,
          totalIterations: 8,
          reviewedFailedIterations: 3,
          totalFailedIterations: 3,
          missingTraces: 0,
          truncatedTraces: 0,
          omittedEvidence: 0,
        },
      },
    },
    job: {
      kind: "build",
      status: "completed",
      startedAt: 1_757_800_000_000,
      updatedAt: 1_757_800_000_000,
    },
    canBuild: true,
    canEnrich: true,
  },
  truncation: {
    truncated: false,
    omittedFindings: 0,
    omittedEvidence: 0,
    contractTruncated: false,
  },
};

function generation(overrides: Record<string, unknown> = {}) {
  return {
    pending: false,
    failedGeneration: false,
    error: null,
    unavailable: false,
    canRequest: true,
    requestInsight: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  mutation.fn.mockClear();
  mutation.fn.mockImplementation(async () => ({ jobId: "job-1" }));
});

describe("build", () => {
  it("asks once per click and never on mount", () => {
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: generation(),
      }),
    );
    expect(mutation.fn).not.toHaveBeenCalled();
    act(() => result.current.build.onRun());
    expect(mutation.fn).toHaveBeenCalledTimes(1);
  });

  it("coalesces a double-click into one request", async () => {
    let resolveRequest: (() => void) | undefined;
    mutation.fn.mockImplementation(
      () =>
        new Promise<{ jobId: string }>((resolve) => {
          resolveRequest = () => resolve({ jobId: "job-1" });
        }),
    );
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: generation(),
      }),
    );
    act(() => {
      result.current.build.onRun();
      result.current.build.onRun();
    });
    expect(mutation.fn).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveRequest?.();
    });
    // The blocked second click must not have stranded the live request's
    // cleanup. Asserting only the call count missed exactly that: the button
    // stayed disabled for the rest of the run's life.
    expect(result.current.build.pending).toBe(false);
    act(() => result.current.build.onRun());
    expect(mutation.fn).toHaveBeenCalledTimes(2);
  });

  it("rebuilds with force when a snapshot already exists", () => {
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: generation(),
      }),
    );
    act(() => result.current.build.onRun());
    expect(mutation.fn).toHaveBeenCalledWith({
      suiteRunId: "run_1",
      force: true,
    });
  });

  it("surfaces a refusal rather than swallowing it", async () => {
    mutation.fn.mockImplementation(async () => {
      throw new Error("Findings are already being built.");
    });
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: generation(),
      }),
    );
    await act(async () => {
      result.current.build.onRun();
    });
    expect(result.current.build.error).toContain(ERROR_MESSAGES.unknownError);
  });
});

describe("enrich", () => {
  it("borrows the page's controller and asks for the experimental mode", () => {
    const borrowed = generation();
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: borrowed,
      }),
    );
    act(() => result.current.enrich.onRun());
    expect(borrowed.requestInsight).toHaveBeenCalledTimes(1);
    expect(borrowed.requestInsight).toHaveBeenCalledWith(true, {
      mode: "findings",
    });
    // The build mutation is untouched: the two operations are separate.
    expect(mutation.fn).not.toHaveBeenCalled();
  });

  it("reports a generation failure without disturbing the build state", () => {
    // The request has to come from THIS section first. A controller that was
    // already failed on mount is reporting someone else's operation, which
    // the suite below covers separately.
    const { result, rerender } = renderHook(
      (props: { failed: boolean }) =>
        useUnifiedFindings({
          suiteRunId: "run_1",
          envelope: ENVELOPE,
          generation: generation({
            failedGeneration: props.failed,
            error: props.failed ? "provider returned 503" : null,
          }),
        }),
      { initialProps: { failed: false } },
    );
    act(() => result.current.enrich.onRun());
    rerender({ failed: true });
    expect(result.current.enrich.error).toContain("503");
    expect(result.current.build.error).toBeNull();
  });
});

describe("view selection", () => {
  it("shows existing AI findings immediately on reload", () => {
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: generation(),
      }),
    );
    expect(result.current.mode).toBe("ai");
    expect(result.current.findings).toBe(ENVELOPE.currentFindings);
  });

  it("falls back to the deterministic view when the enrichment is stale", () => {
    const stale: InsightsEnvelope = {
      ...ENVELOPE,
      unifiedFindings: {
        ...ENVELOPE.unifiedFindings!,
        snapshot: {
          ...ENVELOPE.unifiedFindings!.snapshot!,
          enrichment: {
            ...ENVELOPE.unifiedFindings!.snapshot!.enrichment!,
            status: "stale",
          },
        },
      },
    };
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: stale,
        generation: generation(),
      }),
    );
    expect(result.current.mode).toBe("deterministic");
    expect(result.current.findings).toBe(
      stale.unifiedFindings!.snapshot!.deterministicFindings,
    );
  });
});

describe("an older backend", () => {
  it("says the pairing is incomplete instead of retrying", () => {
    const { unifiedFindings: _dropped, ...legacy } = ENVELOPE;
    void _dropped;
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: legacy as InsightsEnvelope,
        generation: generation(),
      }),
    );
    expect(result.current.backendUnavailableNote).toContain(
      "does not support findings yet",
    );
    expect(result.current.build.available).toBe(false);
    expect(mutation.fn).not.toHaveBeenCalled();
  });

  it("says nothing at all while the envelope is still loading", () => {
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: undefined,
        generation: generation(),
      }),
    );
    expect(result.current.backendUnavailableNote).toBeNull();
    expect(result.current.findings).toEqual([]);
  });
});

describe("enrichment is metered, so one click is one call", () => {
  it("coalesces a double-click into one request", () => {
    const controller = generation();
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: controller,
      }),
    );
    act(() => {
      result.current.enrich.onRun();
      result.current.enrich.onRun();
    });
    // `pending` is document-backed and still false here, which is exactly the
    // window a second click used to slip through — into a PROVIDER call.
    expect(controller.requestInsight).toHaveBeenCalledTimes(1);
  });

  it("reports pending optimistically, before the document says so", () => {
    const controller = generation();
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: controller,
      }),
    );
    expect(result.current.enrich.pending).toBe(false);
    act(() => result.current.enrich.onRun());
    expect(result.current.enrich.pending).toBe(true);
  });

  it("hands authority back once the document reports the job", () => {
    const { result, rerender } = renderHook(
      (props: { pending: boolean }) =>
        useUnifiedFindings({
          suiteRunId: "run_1",
          envelope: ENVELOPE,
          generation: generation({ pending: props.pending }),
        }),
      { initialProps: { pending: false } },
    );
    act(() => result.current.enrich.onRun());
    rerender({ pending: true });
    expect(result.current.enrich.pending).toBe(true);
    // The optimistic flag has cleared, so the document alone decides now.
    rerender({ pending: false });
    expect(result.current.enrich.pending).toBe(false);
  });

  it("does not stick disabled when the request fails without going pending", () => {
    const { result, rerender } = renderHook(
      (props: { error: string | null }) =>
        useUnifiedFindings({
          suiteRunId: "run_1",
          envelope: ENVELOPE,
          generation: generation({ error: props.error }),
        }),
      { initialProps: { error: null as string | null } },
    );
    act(() => result.current.enrich.onRun());
    expect(result.current.enrich.pending).toBe(true);
    rerender({ error: "the request was refused" });
    expect(result.current.enrich.pending).toBe(false);
  });
});

describe("state is scoped to ONE run", () => {
  it("drops a build error when the reader selects another run", async () => {
    mutation.fn.mockImplementation(async () => {
      throw new Error("run A could not be built");
    });
    const { result, rerender } = renderHook(
      (props: { suiteRunId: string }) =>
        useUnifiedFindings({
          suiteRunId: props.suiteRunId,
          envelope: ENVELOPE,
          generation: generation(),
        }),
      { initialProps: { suiteRunId: "run_A" } },
    );
    await act(async () => {
      result.current.build.onRun();
    });
    expect(result.current.build.error).toContain(ERROR_MESSAGES.unknownError);

    rerender({ suiteRunId: "run_B" });
    expect(result.current.build.error).toBeNull();
  });

  it("never writes a late rejection onto the run the reader moved to", async () => {
    let rejectRequest: ((error: Error) => void) | undefined;
    mutation.fn.mockImplementation(
      () =>
        new Promise<{ jobId: string }>((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    const { result, rerender } = renderHook(
      (props: { suiteRunId: string }) =>
        useUnifiedFindings({
          suiteRunId: props.suiteRunId,
          envelope: ENVELOPE,
          generation: generation(),
        }),
      { initialProps: { suiteRunId: "run_A" } },
    );
    act(() => result.current.build.onRun());
    rerender({ suiteRunId: "run_B" });
    await act(async () => {
      rejectRequest?.(new Error("run A could not be built"));
    });
    expect(result.current.build.error).toBeNull();
  });

  it("follows the newly selected run's own view", () => {
    const unexplained: InsightsEnvelope = {
      ...ENVELOPE,
      currentFindings: [MEASURED],
      unifiedFindings: {
        ...ENVELOPE.unifiedFindings!,
        snapshot: { ...ENVELOPE.unifiedFindings!.snapshot!, enrichment: null },
      },
    };
    const { result, rerender } = renderHook(
      (props: { suiteRunId: string; envelope: InsightsEnvelope }) =>
        useUnifiedFindings({
          suiteRunId: props.suiteRunId,
          envelope: props.envelope,
          generation: generation(),
        }),
      { initialProps: { suiteRunId: "run_A", envelope: ENVELOPE } },
    );
    expect(result.current.mode).toBe("ai");
    rerender({ suiteRunId: "run_B", envelope: unexplained });
    expect(result.current.mode).toBe("deterministic");
    expect(result.current.findings).toEqual([MEASURED]);
  });
});

describe("the borrowed controller's state is not this section's to claim", () => {
  it("stays silent about a legacy analysis failure nobody asked it for", () => {
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        // A run whose LEGACY serverQuality failed long before this section
        // existed. The controller is shared, so it reports that failure.
        generation: generation({
          failedGeneration: true,
          error: "the legacy analysis failed",
        }),
      }),
    );
    expect(result.current.enrich.error).toBeNull();
  });

  it("reports the failure once this section actually asked", () => {
    const { result, rerender } = renderHook(
      (props: { failed: boolean }) =>
        useUnifiedFindings({
          suiteRunId: "run_1",
          envelope: ENVELOPE,
          generation: generation({
            failedGeneration: props.failed,
            error: props.failed ? "the explanation failed" : null,
          }),
        }),
      { initialProps: { failed: false } },
    );
    act(() => result.current.enrich.onRun());
    rerender({ failed: true });
    expect(result.current.enrich.error).toBe("the explanation failed");
  });

  it("explains a dead button instead of leaving the reader guessing", () => {
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        // What a daily-insights-limit rejection actually looks like through
        // `classifyInsightError`: unavailable, with no message.
        generation: generation({ unavailable: true, error: null }),
      }),
    );
    expect(result.current.enrich.available).toBe(false);
    expect(result.current.backendUnavailableNote).toContain(
      "daily insights limit",
    );
  });

  it("says nothing extra when the controller is healthy", () => {
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: generation(),
      }),
    );
    expect(result.current.backendUnavailableNote).toBeNull();
  });
});

describe("a stale build callback cannot reach a live request", () => {
  it("ignores the first run A request after A → B → A", async () => {
    const settlers: Array<(error: Error) => void> = [];
    mutation.fn.mockImplementation(
      () =>
        new Promise<{ jobId: string }>((_resolve, reject) => {
          settlers.push(reject);
        }),
    );
    const { result, rerender } = renderHook(
      (props: { suiteRunId: string }) =>
        useUnifiedFindings({
          suiteRunId: props.suiteRunId,
          envelope: ENVELOPE,
          generation: generation(),
        }),
      { initialProps: { suiteRunId: "run_A" } },
    );

    // First request on A, then away to B, then back to A and request again.
    act(() => result.current.build.onRun());
    rerender({ suiteRunId: "run_B" });
    rerender({ suiteRunId: "run_A" });
    act(() => result.current.build.onRun());
    expect(result.current.build.pending).toBe(true);

    // The FIRST request now fails. Its run id still matches — this is the ABA
    // case a run-id check alone cannot see — so only the token rejects it.
    await act(async () => {
      settlers[0]?.(new Error("the first request failed"));
    });
    expect(result.current.build.error).toBeNull();
    expect(result.current.build.pending).toBe(true);

    // The live request still owns the state.
    await act(async () => {
      settlers[1]?.(new Error("the live request failed"));
    });
    expect(result.current.build.error).toContain(ERROR_MESSAGES.unknownError);
  });
});

it("opens the completed AI analysis and clears the request guard even if pending was missed", () => {
  const controller = generation();
  const before = structuredClone(ENVELOPE);
  before.unifiedFindings!.snapshot!.enrichment = null;
  const { result, rerender } = renderHook(
    ({ envelope }) =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope,
        generation: controller,
      }),
    { initialProps: { envelope: before } },
  );
  act(() => result.current.enrich.onRun());
  const completed = structuredClone(before);
  completed.unifiedFindings!.snapshot!.enrichment = {
    ...ENVELOPE.unifiedFindings!.snapshot!.enrichment!,
    status: "ready",
    generatedAt: 99,
  };
  rerender({ envelope: completed });
  expect(result.current.mode).toBe("ai");
  expect(result.current.enrich.pending).toBe(false);
  act(() => result.current.enrich.onRun());
  expect(controller.requestInsight).toHaveBeenCalledTimes(2);
});

describe("one Analyze findings action", () => {
  function unbuilt() {
    const envelope = structuredClone(ENVELOPE);
    envelope.unifiedFindings!.snapshot = null;
    envelope.unifiedFindings!.canBuild = true;
    envelope.unifiedFindings!.canEnrich = false;
    envelope.unifiedFindings!.job = null;
    return envelope;
  }
  it("prepares evidence and invokes AI once after the subscribed build completes", async () => {
    const borrowed = generation();
    const { result, rerender } = renderHook(
      ({ envelope }) =>
        useUnifiedFindings({
          suiteRunId: "run_1",
          envelope,
          generation: borrowed,
        }),
      { initialProps: { envelope: unbuilt() } },
    );
    expect(result.current.analyze.available).toBe(true);
    expect(borrowed.requestInsight).not.toHaveBeenCalled();
    await act(async () => {
      result.current.analyze.onRun();
      result.current.analyze.onRun();
    });
    expect(mutation.fn).toHaveBeenCalledTimes(1);
    expect(result.current.analyze.pending).toBe(true);
    expect(borrowed.requestInsight).not.toHaveBeenCalled();
    const completed = structuredClone(ENVELOPE);
    completed.unifiedFindings!.snapshot!.enrichment = null;
    completed.unifiedFindings!.canEnrich = true;
    completed.unifiedFindings!.job = null;
    rerender({ envelope: completed });
    rerender({ envelope: structuredClone(completed) });
    expect(borrowed.requestInsight).toHaveBeenCalledTimes(1);
    expect(borrowed.requestInsight).toHaveBeenCalledWith(true, {
      mode: "findings",
    });
  });
  it("never invokes AI after a build refusal", async () => {
    mutation.fn.mockRejectedValueOnce(new Error("Evidence unavailable"));
    const borrowed = generation();
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: unbuilt(),
        generation: borrowed,
      }),
    );
    await act(async () => result.current.analyze.onRun());
    expect(result.current.analyze.error).toContain(ERROR_MESSAGES.unknownError);
    expect(result.current.analyze.pending).toBe(false);
    expect(borrowed.requestInsight).not.toHaveBeenCalled();
  });
  it("cancels queued analysis on a run switch", async () => {
    const borrowed = generation();
    const { result, rerender } = renderHook(
      ({ id, envelope }) =>
        useUnifiedFindings({ suiteRunId: id, envelope, generation: borrowed }),
      { initialProps: { id: "a", envelope: unbuilt() } },
    );
    await act(async () => result.current.analyze.onRun());
    rerender({ id: "b", envelope: structuredClone(ENVELOPE) });
    expect(borrowed.requestInsight).not.toHaveBeenCalled();
    expect(result.current.analyze.pending).toBe(false);
  });
  it("waits for a new snapshot when replacing stale analysis", async () => {
    const envelope = structuredClone(ENVELOPE);
    envelope.unifiedFindings!.snapshot!.enrichment!.status = "stale";
    const borrowed = generation();
    const { result, rerender } = renderHook(
      ({ envelope }) =>
        useUnifiedFindings({
          suiteRunId: "run_1",
          envelope,
          generation: borrowed,
        }),
      { initialProps: { envelope } },
    );
    await act(async () => result.current.analyze.onRun());
    rerender({ envelope: structuredClone(envelope) });
    expect(borrowed.requestInsight).not.toHaveBeenCalled();
    const ready = structuredClone(envelope);
    ready.unifiedFindings!.snapshot!.builtAt += 1;
    ready.unifiedFindings!.snapshot!.enrichment = null;
    ready.unifiedFindings!.canEnrich = true;
    ready.unifiedFindings!.job = null;
    rerender({ envelope: ready });
    expect(borrowed.requestInsight).toHaveBeenCalledTimes(1);
  });
  it("reuses a ready snapshot and coalesces duplicate analysis clicks", () => {
    const borrowed = generation();
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: borrowed,
      }),
    );
    act(() => {
      result.current.analyze.onRun();
      result.current.analyze.onRun();
    });
    expect(mutation.fn).not.toHaveBeenCalled();
    expect(borrowed.requestInsight).toHaveBeenCalledTimes(1);
  });
});

describe("automatic analysis failures", () => {
  it.each([
    ["failed", "enrich", "evidence_changed", false, null, true],
    ["failed", "enrich", "cancelled", false, null, true],
    ["pending", "enrich", "evidence_changed", false, null, false],
    ["failed", "build", "evidence_changed", false, null, false],
    ["failed", "enrich", "evidence_changed", true, null, false],
    ["failed", "enrich", "evidence_changed", false, 200, false],
  ] as const)(
    "handles %s %s %s pending=%s enrichment=%s",
    (status, kind, errorCode, pending, generatedAt, visible) => {
      const envelope = structuredClone(ENVELOPE);
      envelope.unifiedFindings!.job = {
        jobId: "auto",
        kind,
        status,
        errorCode,
        startedAt: 100,
        updatedAt: 100,
      };
      envelope.unifiedFindings!.snapshot!.enrichment =
        generatedAt === null
          ? null
          : { ...ENVELOPE.unifiedFindings!.snapshot!.enrichment!, generatedAt };
      const { result } = renderHook(() =>
        useUnifiedFindings({
          suiteRunId: "run_1",
          envelope,
          generation: generation({ pending }),
        }),
      );
      expect(result.current.analysisFailure !== null).toBe(visible);
      if (visible) {
        expect(result.current.analyze.error).toBeNull();
        expect(result.current.analysisFailure?.errorCode).toBe(
          errorCode === "cancelled" ? undefined : errorCode,
        );
      }
    },
  );

  it("says nothing about a green run whose analysis found nothing", () => {
    // An all-pass run is now analyzed like any other: every iteration gets a
    // report, and the reasoning half legitimately proposes no mechanism. That
    // is a COMPLETED job with an empty findings list — never "AI analysis did
    // not complete", which would read as a failure of a job that succeeded.
    const envelope = structuredClone(ENVELOPE);
    envelope.currentFindings = [];
    envelope.unifiedFindings!.snapshot!.deterministicFindings = [];
    envelope.unifiedFindings!.snapshot!.provenance = [];
    envelope.unifiedFindings!.snapshot!.enrichment = {
      ...ENVELOPE.unifiedFindings!.snapshot!.enrichment!,
      discovery: {
        reviewedIterations: 8,
        totalIterations: 8,
        reviewedFailedIterations: 0,
        totalFailedIterations: 0,
        missingTraces: 0,
        truncatedTraces: 0,
        omittedEvidence: 0,
      },
    };
    envelope.unifiedFindings!.job = {
      jobId: "auto",
      kind: "enrich",
      status: "completed",
      startedAt: 100,
      updatedAt: 100,
    };
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope,
        generation: generation(),
      }),
    );
    expect(result.current.analysisFailure).toBeNull();
    expect(result.current.analyze.error).toBeNull();
    expect(result.current.findings).toEqual([]);
  });
});
