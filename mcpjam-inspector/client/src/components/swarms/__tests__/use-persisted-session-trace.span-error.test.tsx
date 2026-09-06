import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Span-load failures, which are reported SEPARATELY from transcript failures.
 *
 * Sharing one `error` slot broke in both directions: the transcript effect
 * clears `error` on every re-run, so an unrelated refetch wiped a span
 * failure, and the span effect never cleared it, so one transient failure
 * outlived the successful retry after it. The consequence is specific — the
 * viewer reads zero spans as "none recorded" and synthesizes a timeline from
 * `estimatedDurationMs`, so a swallowed span error is a confident, entirely
 * estimated timeline. That is the BB-153 failure mode over again.
 */
const { mockHydrate, mockTraces, STABLE_THREAD } = vi.hoisted(() => ({
  mockHydrate: vi.fn(),
  mockTraces: { traces: [] as unknown[] },
  // Stable identity, because the transcript effect depends on the thread
  // OBJECT. The real Convex hook holds a reference across renders; a fresh
  // literal per render would re-run the effect forever and the loop would be
  // the mock's, not the hook's.
  STABLE_THREAD: { messagesBlobUrl: "https://storage.example.com/t.json" },
}));

vi.mock("@/hooks/useSharedChatThreads", () => ({
  useSharedChatThread: () => ({ thread: STABLE_THREAD }),
  useSharedChatWidgetSnapshots: () => ({ snapshots: [] }),
  useSharedChatTurnTraces: () => ({ traces: mockTraces.traces }),
  useSessionBrowserArtifacts: () => ({ artifacts: undefined }),
}));

vi.mock("@/components/evals/trace-viewer-adapter", () => ({
  snapshotsToTraceWidgetSnapshots: (s: unknown[]) => s,
}));

// Only the fetching helper is stubbed. `expectedTurnTraceSpanCount`,
// `turnTraceWallClockRange` and `SPAN_LOAD_FAILURE` are pure and stay real, so
// these assertions exercise the hook's wiring rather than a stub of it.
vi.mock("@/components/evals/turn-trace-spans", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/evals/turn-trace-spans")
  >()),
  hydrateTurnTraceSpans: (...args: unknown[]) => mockHydrate(...args),
}));

import { usePersistedSessionTrace } from "../use-persisted-session-trace";

type Seen = ReturnType<typeof usePersistedSessionTrace>;
let last: Seen | null = null;

function Probe({ threadId }: { threadId: string | null }) {
  last = usePersistedSessionTrace(threadId);
  return null;
}

/** One turn that RECORDED two spans — so "got none" is a load failure. */
const TRACES = [{ turnIndex: 0, spanCount: 2, blobUrl: "https://b/0.json" }];

beforeEach(() => {
  vi.clearAllMocks();
  last = null;
  mockTraces.traces = TRACES;
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [{ role: "assistant", content: [] }],
  }) as unknown as typeof fetch;
});

describe("usePersistedSessionTrace — span load failures", () => {
  it("reports a total span failure even though the transcript loaded", async () => {
    // The case a single `error` slot swallowed: `trace` is non-null because
    // the messages arrived, so a caller that only renders `error` in its
    // no-trace branch never showed this.
    mockHydrate.mockResolvedValue([]);
    render(<Probe threadId="t1" />);

    await waitFor(() => expect(last?.trace).not.toBeNull());
    expect(last?.spanError).toMatch(/could not load the recorded trace/i);
    // NOT reported as a transcript failure — the transcript is fine.
    expect(last?.error).toBeNull();
  });

  it("says nothing when the session simply recorded no spans", async () => {
    // `spanCount: 0` is a session that never had timing data. Warning here
    // would train people to ignore the warning that matters.
    mockTraces.traces = [
      { turnIndex: 0, spanCount: 0, blobUrl: "https://b/0.json" },
    ];
    mockHydrate.mockResolvedValue([]);
    render(<Probe threadId="t1" />);

    await waitFor(() => expect(last?.trace).not.toBeNull());
    expect(last?.spanError).toBeNull();
  });

  it("clears a previous failure once a later hydration succeeds", async () => {
    mockHydrate.mockRejectedValueOnce(new Error("blob 500"));
    const { rerender } = render(<Probe threadId="t1" />);
    await waitFor(() => expect(last?.spanError).not.toBeNull());

    // A new `turnTraces` identity re-runs the effect, which is what a Convex
    // refetch does. The retry succeeds and must speak for itself.
    mockHydrate.mockResolvedValue([{ id: "s1", name: "turn", startedAt: 0 }]);
    mockTraces.traces = [...TRACES];
    rerender(<Probe threadId="t1" />);

    await waitFor(() => expect(last?.spanError).toBeNull());
  });

  it("surfaces a thrown hydration, not just an empty result", async () => {
    mockHydrate.mockRejectedValue(new Error("network down"));
    render(<Probe threadId="t1" />);

    await waitFor(() =>
      expect(last?.spanError).toMatch(/could not load the recorded trace/i)
    );
  });
});

/**
 * The absolute clock the timeline prints beside its offsets.
 *
 * Re-anchored offsets say a prompt happened 40s in; only this says *when*.
 * `ShareUsageThreadDetail` has always had it and this pane never did, so the
 * two views of one session could say different amounts about the same spans.
 * It rides the ENVELOPE rather than a separate return field, so the
 * live-vs-persisted choice `journey-run-results` already makes carries it too.
 */
describe("usePersistedSessionTrace — wall-clock anchor", () => {
  it("anchors on the earliest start and the latest end, whatever the row order", async () => {
    mockTraces.traces = [
      { turnIndex: 1, startedAt: 1_008_000, endedAt: 1_012_000, spanCount: 0 },
      { turnIndex: 0, startedAt: 1_000_000, endedAt: 1_005_000, spanCount: 0 },
    ];
    mockHydrate.mockResolvedValue([]);
    render(<Probe threadId="t1" />);

    await waitFor(() => expect(last?.trace).not.toBeNull());
    expect(last?.trace?.traceStartedAtMs).toBe(1_000_000);
    expect(last?.trace?.traceEndedAtMs).toBe(1_012_000);
  });

  it("omits the anchor rather than claiming the Unix epoch", async () => {
    // A row with no usable timestamps must leave the fields ABSENT: `0` would
    // be printed as a real date in 1970.
    mockTraces.traces = [
      { turnIndex: 0, startedAt: Number.NaN, endedAt: Number.NaN },
    ];
    mockHydrate.mockResolvedValue([]);
    render(<Probe threadId="t1" />);

    await waitFor(() => expect(last?.trace).not.toBeNull());
    expect(last?.trace).not.toHaveProperty("traceStartedAtMs");
    expect(last?.trace).not.toHaveProperty("traceEndedAtMs");
  });
});
