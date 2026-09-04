/**
 * Fetch hook for ONE run's materialized route facts.
 *
 * The run-scoped sibling of `use-eval-run-stage-analytics.ts`, and
 * deliberately smaller: a run has exactly one document, so there is no
 * cursor array, no page accumulator and no dedupe. What it keeps is the part
 * that is about correctness rather than paging — a monotonic request id so an
 * out-of-order response can never paint over a newer one, and an
 * `AbortController` per effect.
 *
 * Route facts are materialized `final` only. There is no provisional
 * refresh loop here: a document that is not there yet is `absent`, and the
 * evaluate run page falls back to the client producer.
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
import type { EvalRunRouteFacts } from "@mcpjam/sdk/contract";
import {
  fetchEvalRunRouteFacts,
  isEvalRouteFactsError,
  type RouteFactsFailureKind,
} from "@/lib/apis/eval-route-facts-api";

export interface RouteFactsErrorInfo {
  message: string;
  /**
   * WHICH failure, kept apart rather than collapsed into "error".
   *
   * `routeUnavailable` and `requestFailed` are SERVICE states ("we could not
   * measure this"), while `invalidContract` is a bug report and `notFound` is
   * a fact about the run.
   */
  kind: RouteFactsFailureKind;
  status?: number;
}

/**
 * `absent` is its own state, beside `ready` and `error`.
 *
 * Not folded into either: `ready` with a null document would make every caller
 * re-derive "is there anything here", and `error` would report an unmeasured
 * run as a malfunction.
 */
export type EvalRunRouteFactsStatus =
  | "idle"
  | "loading"
  | "ready"
  | "absent"
  | "error";

export interface EvalRunRouteFactsState {
  status: EvalRunRouteFactsStatus;
  /** The run's document, or `null` in every state but `ready`. */
  document: EvalRunRouteFacts | null;
  error: RouteFactsErrorInfo | null;
  /** Re-runs the read. A no-op while inactive. */
  refetch: () => void;
}

function toErrorInfo(error: unknown): RouteFactsErrorInfo {
  if (isEvalRouteFactsError(error)) {
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
 * Including the status in the effect's identity makes the transition into a
 * terminal state re-ask exactly once. Omitted by callers that do not track
 * it, which keeps the old single-shot behaviour rather than breaking them.
 */
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export function useEvalRunRouteFacts({
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
   */
  runStatus?: string | null;
  enabled?: boolean;
}): EvalRunRouteFactsState {
  const active = Boolean(enabled && projectId && runId);
  const runIsOver = runStatus ? TERMINAL_RUN_STATUSES.has(runStatus) : true;

  const [document, setDocument] = useState<EvalRunRouteFacts | null>(null);
  const [status, setStatus] = useState<EvalRunRouteFactsStatus>("idle");
  const [error, setError] = useState<RouteFactsErrorInfo | null>(null);
  const [attempt, setAttempt] = useState(0);

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
    setDocument(null);

    void (async () => {
      try {
        const row = await fetchEvalRunRouteFacts(
          { projectId: projectId as string, runId: runId as string },
          controller.signal,
        );
        if (requestId !== requestIdRef.current) return;
        setDocument(row);
        setStatus("ready");
      } catch (err) {
        if (controller.signal.aborted) return;
        if (requestId !== requestIdRef.current) return;
        setDocument(null);
        const info = toErrorInfo(err);
        if (info.kind === "notFound") {
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

  const observed: EvalRunRouteFactsStatus =
    active && status === "idle" ? "loading" : status;

  return { status: observed, document, error, refetch };
}
