/**
 * Fetch hook for ONE run's materialized stage analytics (UVH-IN6).
 *
 * The run-scoped sibling of `use-eval-suite-stage-analytics.ts`, and
 * deliberately much smaller: a run has exactly one document, so there is no
 * cursor array, no page accumulator and no dedupe. What it keeps is the part
 * that is about correctness rather than paging — a monotonic request id so an
 * out-of-order response can never paint over a newer one, and an
 * `AbortController` per effect.
 *
 * ── `notFound` is an ANSWER, not a failure ───────────────────────────────────
 *
 * The API returns the same 404 for "this run has no document" and "this run is
 * not visible to you", so that it cannot confirm the existence of runs in
 * projects the caller cannot see. Both mean UNMEASURED to a reader, so this
 * hook surfaces that as its own `absent` status rather than as an error: an
 * error state would put a red service message on every run that finished
 * before the materializer shipped, which is most of them.
 *
 * The other three failure kinds stay errors, and stay APART: `routeUnavailable`
 * is the dark-ship window, `requestFailed` is a service state, and
 * `invalidContract` is a bug report. Collapsing them into "couldn't load" loses
 * the only one a reader can act on.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EvalStageAnalyticsV1 } from "@mcpjam/sdk/contract";
import {
  fetchEvalRunStageAnalytics,
  isEvalStageAnalyticsError,
  type StageAnalyticsFailureKind,
} from "@/lib/apis/eval-stage-analytics-api";

export interface StageAnalyticsErrorInfo {
  message: string;
  /**
   * WHICH failure, kept apart rather than collapsed into "error".
   *
   * `routeUnavailable` and `requestFailed` are SERVICE states ("we could not
   * measure this"), while `invalidContract` is a bug report and `notFound` is
   * a fact about the run. None of them is an empty chart.
   *
   * Declared here since the suite-scoped reader was removed: this hook is the
   * only consumer left, and a type outliving the module it was defined in is
   * how an import survives the thing it belonged to.
   */
  kind: StageAnalyticsFailureKind;
  status?: number;
}

/**
 * `absent` is its own state, beside `ready` and `error`.
 *
 * Not folded into either: `ready` with a null document would make every caller
 * re-derive "is there anything here", and `error` would report an unmeasured
 * run as a malfunction.
 */
export type EvalRunStageAnalyticsStatus =
  | "idle"
  | "loading"
  | "ready"
  | "absent"
  | "error";

export interface EvalRunStageAnalyticsState {
  status: EvalRunStageAnalyticsStatus;
  /** The run's document, or `null` in every state but `ready`. */
  document: EvalStageAnalyticsV1 | null;
  error: StageAnalyticsErrorInfo | null;
  /** Re-runs the read. A no-op while inactive. */
  refetch: () => void;
}

function toErrorInfo(error: unknown): StageAnalyticsErrorInfo {
  if (isEvalStageAnalyticsError(error)) {
    return {
      message: error.message,
      kind: error.kind,
      ...(error.status !== undefined ? { status: error.status } : {}),
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    kind: "requestFailed",
  };
}

/**
 * The statuses after which a run's document will not appear later.
 *
 * `timed_out` belongs here and is easy to miss: the runner types its own
 * terminal transitions as `"cancelled" | "timed_out"`, so a run that ran out of
 * time is as over as one that was cancelled. Leaving it out meant a page opened
 * during such a run never re-asked and sat on the older rollup forever.
 *
 * A SUPERSET of `use-run-group-quality.ts`'s list, which omits it — worth
 * reconciling, but widening that one is outside this change and it is used for
 * a different question.
 */
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/**
 * How long to keep asking while the document says it is not settled yet.
 *
 * A document is materialized `provisional` when a judge fanout is still
 * pending, and REPLACED by a `final` one once that settles. The effect keys on
 * ids and the run's terminal status, neither of which changes at that moment —
 * so a page open across the transition kept showing provisional numbers until
 * someone reloaded it.
 *
 * This is the same rule the run-status re-ask already implements ("ask again
 * exactly when the answer can still change"), applied to the one remaining
 * transition it did not cover. Bounded and self-terminating rather than a
 * poll: it stops at `final`, and it stops when the attempts run out, so a
 * fanout that never settles costs a handful of reads and not one per interval
 * forever. Backs off so a slow judge is not hammered.
 */
const PROVISIONAL_REFRESH_DELAYS_MS = [3_000, 8_000, 20_000, 45_000] as const;

export function useEvalRunStageAnalytics({
  projectId,
  runId,
  runStatus,
  enabled = true,
}: {
  projectId: string | null | undefined;
  runId: string | null | undefined;
  /**
   * The run's current status, when the caller has it.
   *
   * Read for ONE reason: the document is materialized when the run
   * terminalizes, so a page opened mid-run asks too early, settles on
   * `absent`, and — because the effect keys only on ids — never asks again.
   * The run finishes, the document appears, and the page keeps showing the
   * older rollup until someone reloads it.
   *
   * Including the status in the effect's identity makes the transition into a
   * terminal state re-ask exactly once. Omitted by callers that do not track
   * it, which keeps the old single-shot behaviour rather than breaking them.
   */
  runStatus?: string | null;
  enabled?: boolean;
}): EvalRunStageAnalyticsState {
  const active = Boolean(enabled && projectId && runId);
  // Collapsed to a BOOLEAN, not carried through as the raw status: a run
  // moving `pending` → `running` changes nothing about whether its document
  // exists, and re-fetching on it would issue a request per status tick.
  const runIsOver = runStatus ? TERMINAL_RUN_STATUSES.has(runStatus) : true;

  const [document, setDocument] = useState<EvalStageAnalyticsV1 | null>(null);
  const [status, setStatus] = useState<EvalRunStageAnalyticsStatus>("idle");
  const [error, setError] = useState<StageAnalyticsErrorInfo | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Monotonic request id. Only the newest in-flight request may write state —
  // without it, a slow read for the PREVIOUS run could land after the current
  // run's and put one run's funnel under another's heading.
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!active) {
      requestIdRef.current += 1;
      setStatus("idle");
      setDocument(null);
      setError(null);
      return;
    }

    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    const controller = new AbortController();
    setStatus("loading");
    setError(null);
    // Cleared on the way IN, not on the way out: a stale document left on
    // screen while the next run loads is the same stale-answer bug the request
    // id exists to prevent, just with a slower fuse.
    setDocument(null);

    void (async () => {
      try {
        const row = await fetchEvalRunStageAnalytics(
          { projectId: projectId as string, runId: runId as string },
          controller.signal,
        );
        if (requestId !== requestIdRef.current) return;
        setDocument(row);
        setStatus("ready");
      } catch (err) {
        // An abort is the caller's own teardown, not a failure to report.
        if (controller.signal.aborted) return;
        if (requestId !== requestIdRef.current) return;
        setDocument(null);
        const info = toErrorInfo(err);
        if (info.kind === "notFound") {
          // UNMEASURED, not broken. See the module docblock.
          setError(null);
          setStatus("absent");
          return;
        }
        setError(info);
        setStatus("error");
      }
    })();

    return () => controller.abort();
  }, [active, projectId, runId, runIsOver, attempt]);

  const refetch = useCallback(() => {
    if (!active) return;
    setAttempt((n) => n + 1);
  }, [active]);

  // Re-ask while the document itself says a judge pass is still coming.
  //
  // Keyed on the document's state rather than on a timer that runs regardless:
  // when the read comes back `final` this effect has nothing to schedule and
  // the loop ends on its own. `provisionalAttempt` counts only these automatic
  // re-asks, so a manual `refetch` never consumes the budget.
  const [provisionalAttempt, setProvisionalAttempt] = useState(0);
  const provisional =
    status === "ready" && document?.materializationState === "provisional";

  useEffect(() => {
    if (!active || !provisional) {
      // Settled (or gone). Reset so a LATER provisional document — a
      // re-triggered judge pass reopens one — gets the full budget again
      // rather than inheriting a spent one.
      setProvisionalAttempt(0);
      return;
    }
    const delay = PROVISIONAL_REFRESH_DELAYS_MS[provisionalAttempt];
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      setProvisionalAttempt((n) => n + 1);
      setAttempt((n) => n + 1);
    }, delay);
    return () => clearTimeout(timer);
  }, [active, provisional, provisionalAttempt]);

  // `idle` means "never asked", and while ACTIVE that is only ever true for a
  // single render: `active` is computed here, but the effect that sets
  // `loading` runs after this render commits.
  //
  // Reporting the raw `idle` on that first frame let the run detail draw the
  // LEGACY funnel and then replace it with canonical numbers — the exact
  // incompatible-number flash the `loading` branch exists to prevent, and one
  // introduced by the fix that made an inactive `idle` render legacy at all.
  // Both are `idle` to this hook's state machine; only `active` tells them
  // apart, and only this hook knows it.
  //
  // Derived rather than seeded in `useState`, because `active` can flip after
  // mount (a project id arrives, the flag resolves) and an initial value would
  // answer for the first render only.
  const observed: EvalRunStageAnalyticsStatus =
    active && status === "idle" ? "loading" : status;

  return { status: observed, document, error, refetch };
}
