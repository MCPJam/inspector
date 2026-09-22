/**
 * The findings hook's two gates, which are two different facts.
 *
 * `useEvalRunDecisionDetail` collapses "the caller turned this off" and "there
 * is nothing to read yet" into one `disabled` status — it issues no request
 * either way, so one word is enough for it. It is not enough here: this hook
 * owns the difference, and forwarding the inner word reported a still-running
 * run as something the reader had switched off.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const { decisionFetchMock } = vi.hoisted(() => ({
  decisionFetchMock: vi.fn(),
}));
vi.mock("@/lib/apis/eval-run-decision-summary-api", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/apis/eval-run-decision-summary-api")
    >();
  return { ...actual, fetchEvalRunDecisionSummary: decisionFetchMock };
});

import { FINDINGS_FAILURE_COPY, useStageFindings } from "../use-stage-findings";
import { EvalRunDecisionSummaryError } from "@/lib/apis/eval-run-decision-summary-api";
import { evalDecisionSummaryStore } from "@/lib/evals/eval-decision-summary-store";
import { GOLDEN_STAGE_ANALYTICS } from "@/test/stage-analytics-fixtures";

function runRow(status: string) {
  return {
    _id: GOLDEN_STAGE_ANALYTICS.runId,
    status,
    result: "failed",
    completedAt: 1_700_000_010_000,
  };
}

function renderFindings(
  overrides: Partial<Parameters<typeof useStageFindings>[0]> = {},
) {
  return renderHook(() =>
    useStageFindings({
      projectId: "p1",
      analytics: GOLDEN_STAGE_ANALYTICS,
      run: runRow("completed"),
      enabled: true,
      canOpenTrial: true,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  decisionFetchMock.mockReset();
  decisionFetchMock.mockImplementation(() => new Promise(() => {}));
  evalDecisionSummaryStore.reset();
});

describe("useStageFindings gating", () => {
  it("reports a RUNNING run as runNotTerminal, not as disabled", () => {
    // The bug this pins: `active` folds `terminal` in, so the inner hook says
    // `disabled` for a running run, and forwarding that made `runNotTerminal`
    // unreachable from the real wiring — the union declared a state nothing
    // could produce.
    const { result } = renderFindings({ run: runRow("running") });
    expect(result.current.kind).toBe("runNotTerminal");
    expect(decisionFetchMock).not.toHaveBeenCalled();
  });

  it("reports the caller's own switch as disabled", () => {
    const { result } = renderFindings({ enabled: false });
    expect(result.current.kind).toBe("disabled");
    expect(decisionFetchMock).not.toHaveBeenCalled();
  });

  it("is disabled with no project id, which the browser never guesses", () => {
    const { result } = renderFindings({ projectId: null });
    expect(result.current.kind).toBe("disabled");
    expect(decisionFetchMock).not.toHaveBeenCalled();
  });

  it("is disabled with no run row to read a revision from", () => {
    const { result } = renderFindings({ run: null });
    expect(result.current.kind).toBe("disabled");
    expect(decisionFetchMock).not.toHaveBeenCalled();
  });

  it("reads for a terminal run with the flag on", () => {
    const { result } = renderFindings();
    expect(result.current.kind).toBe("loading");
    expect(decisionFetchMock).toHaveBeenCalled();
  });
});

describe("the read's failure copy", () => {
  // Every way the read can come back without diagnostics gets its OWN words.
  // The mapping is asserted against the exported map rather than restated here,
  // so a test cannot pass while the copy it claims to pin drifts away from it.
  const kinds = [
    "notFound",
    "routeUnavailable",
    "invalidContract",
    "requestFailed",
  ] as const;

  for (const kind of kinds) {
    it(`renders the ${kind} copy, and never as a finding about the server`, async () => {
      decisionFetchMock.mockRejectedValue(
        new EvalRunDecisionSummaryError(kind, `synthetic ${kind}`),
      );
      const { result } = renderFindings();

      await waitFor(() => expect(result.current.kind).toBe("unavailable"));
      const state = result.current;
      if (state.kind !== "unavailable") throw new Error("expected unavailable");

      expect(state.title).toBe(FINDINGS_FAILURE_COPY[kind].title);
      expect(state.detail).toBe(FINDINGS_FAILURE_COPY[kind].detail);
      // The stage rates above are unaffected by this read, so the copy must
      // never read as a measurement about the server under test.
      expect(`${state.title} ${state.detail}`).not.toMatch(
        /\b(no failures|0 failures|passed|healthy)\b/i,
      );
    });
  }

  it("gives each kind DIFFERENT words, so the four are told apart", () => {
    const titles = kinds.map((kind) => FINDINGS_FAILURE_COPY[kind].title);
    expect(new Set(titles).size).toBe(kinds.length);
  });
});
