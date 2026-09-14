/**
 * The controller's contract: one request per click, one controller per scope,
 * and an older backend that says so instead of failing silently.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { useUnifiedFindings } from "../use-unified-findings";
import type { InsightsEnvelope } from "@/lib/insights-envelope-api";

const mutation = vi.hoisted(() => ({
  fn: vi.fn(async () => ({ jobId: "job-1" })),
}));
vi.mock("convex/react", () => ({
  useMutation: () => mutation.fn,
}));

const ENVELOPE: InsightsEnvelope = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "wire-parity-envelope.json",
    ),
    "utf8",
  ),
) as InsightsEnvelope;

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
    expect(result.current.build.error).toContain("already being built");
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
  it("shows the deterministic findings by default", () => {
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: generation(),
      }),
    );
    expect(result.current.mode).toBe("deterministic");
    expect(result.current.findings).toBe(
      ENVELOPE.unifiedFindings!.snapshot!.deterministicFindings,
    );
  });

  it("switching to AI selects the current view through the shared selector", () => {
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: generation(),
      }),
    );
    act(() => result.current.setMode("ai"));
    expect(result.current.findings).toBe(ENVELOPE.currentFindings);
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
      "does not serve it",
    );
    expect(result.current.build.available).toBe(false);
    expect(mutation.fn).not.toHaveBeenCalled();
  });

  it("distinguishes a gate that is off from a backend that is missing", () => {
    const gateOff: InsightsEnvelope = {
      ...ENVELOPE,
      unifiedFindings: {
        ...ENVELOPE.unifiedFindings!,
        writesEnabled: false,
        canBuild: false,
        canEnrich: false,
      },
    };
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: gateOff,
        generation: generation(),
      }),
    );
    expect(result.current.backendUnavailableNote).toContain(
      "write gate is off",
    );
    // Reads still work: the snapshot that exists is still on screen.
    expect(result.current.findings.length).toBeGreaterThan(0);
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
    expect(result.current.build.error).toContain("could not be built");

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

  it("falls back to the deterministic view on the newly selected run", () => {
    const { result, rerender } = renderHook(
      (props: { suiteRunId: string }) =>
        useUnifiedFindings({
          suiteRunId: props.suiteRunId,
          envelope: ENVELOPE,
          generation: generation(),
        }),
      { initialProps: { suiteRunId: "run_A" } },
    );
    act(() => result.current.setMode("ai"));
    expect(result.current.mode).toBe("ai");
    rerender({ suiteRunId: "run_B" });
    expect(result.current.mode).toBe("deterministic");
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
    expect(result.current.backendUnavailableNote).toContain("insights-limit");
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
    expect(result.current.build.error).toContain("the live request failed");
  });
});
