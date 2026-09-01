/**
 * The one place a stage-analytics document is joined to its run's diagnostics.
 *
 * ── Zero new routes, zero new flags, zero extra HTTP ─────────────────────────
 *
 * This calls `useEvalRunDecisionDetail` with the SAME target
 * `RunDecisionSummarySection` already uses on the run page. The shared LRU
 * store keys on (projectId, runId, limit, cursor), so the second caller is a
 * cache hit and no request is issued twice. That is the whole reason this reads
 * D9 directly rather than having the run page thread its already-fetched
 * diagnostics down: the suite page has no such caller, and a prop that only one
 * of the two surfaces can supply would have made this feature run-page-only.
 *
 * The read is off unless the caller says otherwise, and the caller's flag is
 * the existing `evaluate-enabled` one — nothing new to turn on.
 */
import { useMemo } from "react";
import { useEvalRunDecisionDetail } from "@/hooks/use-eval-run-decision-summary";
import {
  evalRunDecisionRevision,
  isTerminalEvalRunStatus,
  type EvalDecisionSummaryStore,
} from "@/lib/evals/eval-decision-summary-store";
import type { EvalRunDecisionSummaryError } from "@/lib/apis/eval-run-decision-summary-api";
import type { EvalStageAnalyticsV1 } from "@mcpjam/sdk/contract";
import {
  buildStageFindings,
  type StageFindingsState,
} from "./stage-findings-model";

/**
 * Human copy for each way the read can come back without diagnostics.
 *
 * The same discipline `FAILURE_COPY` uses on the decision card: name what could
 * not be read and say what that means for what is on screen. None of these is
 * a finding about the server, and none of them may read as one — the stage
 * rates above are unaffected and stay rendered.
 */
const FINDINGS_FAILURE_COPY: Record<
  EvalRunDecisionSummaryError["kind"],
  { title: string; detail: string }
> = {
  notFound: {
    title: "No per-trial diagnostics for this run",
    detail:
      "This project has no run with that id, or it is no longer visible here.",
  },
  routeUnavailable: {
    title: "Per-trial diagnostics are not available on this deployment",
    detail:
      "The API this app is talking to does not serve the run decision summary contract, so the trials behind these stage counts are not listed.",
  },
  invalidContract: {
    title: "The decision summary did not match its contract",
    detail:
      "The API answered with a payload this build cannot validate, so nothing from it is shown here. The stage counts above come from a different document and are unaffected.",
  },
  requestFailed: {
    title: "Couldn't load the trial evidence",
    detail:
      "The read did not complete, so the trials behind these stage counts are not listed here. It will be retried automatically.",
  },
};

export interface StageFindingsTarget {
  projectId: string | null | undefined;
  /** The analytics document whose stages the findings attach to. */
  analytics: EvalStageAnalyticsV1 | null;
  /** The run row this document belongs to, for its status and revision. */
  run: {
    _id: string;
    status: string;
    result?: string | null;
    completedAt?: number | null;
    verdictPolicyVersion?: unknown;
    verdictSummary?: unknown;
    goalCompletionStatus?: string | null;
  } | null;
  /** The existing `evaluate-enabled` flag, threaded by the caller. */
  enabled: boolean;
  /** Whether this surface can open a trial at all. Gates the row's button. */
  canOpenTrial: boolean;
  /** Test seam. Production always shares the singleton, and must. */
  store?: EvalDecisionSummaryStore;
}

export function useStageFindings({
  projectId,
  analytics,
  run,
  enabled,
  canOpenTrial,
  store,
}: StageFindingsTarget): StageFindingsState {
  // Terminal only. A pending or running row has no decision to read, and asking
  // anyway spends a request per poll to be told so — the same gate
  // `RunDecisionSummarySection` applies, so the two callers share cache entries
  // rather than racing each other into different ones.
  const terminal = isTerminalEvalRunStatus(run?.status);
  const active = Boolean(enabled && projectId && run && terminal);

  const detail = useEvalRunDecisionDetail({
    projectId: projectId ?? null,
    runId: run?._id ?? null,
    enabled: active,
    ...(run ? { revision: evalRunDecisionRevision(run) } : {}),
    ...(store ? { store } : {}),
  });

  return useMemo(
    () =>
      buildStageFindings({
        analytics,
        summary: detail.summary,
        diagnostics: detail.diagnostics,
        scannedIterations: detail.scannedIterations,
        serverComplete: detail.serverComplete,
        walkExhausted: detail.walkExhausted,
        status: enabled ? detail.status : "disabled",
        error: detail.error
          ? (FINDINGS_FAILURE_COPY[detail.error.kind] ?? null)
          : null,
        runTerminal: terminal,
        canViewTrace: canOpenTrial,
      }),
    [
      analytics,
      detail.summary,
      detail.diagnostics,
      detail.scannedIterations,
      detail.serverComplete,
      detail.walkExhausted,
      detail.status,
      detail.error,
      enabled,
      terminal,
      canOpenTrial,
    ],
  );
}
