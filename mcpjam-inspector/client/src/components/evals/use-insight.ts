/**
 * Generic insight hook — shared lifecycle for any AI-generated insight
 * stored on an eval suite run (run insights, failure analysis, etc.).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import type { EvalSuiteRun } from "./types";

export type InsightStatus = "pending" | "completed" | "failed" | undefined;

export interface InsightConfig<TResult> {
  /** Read the insight status from the run document. */
  getStatus: (run: EvalSuiteRun) => InsightStatus;
  /** Read the insight result from the run document. */
  getResult: (run: EvalSuiteRun) => TResult | undefined;
  /** Convex mutation path for requesting generation, e.g. "runInsights:requestRunInsights". */
  requestMutation: string;
  /** Convex mutation path for cancelling generation, e.g. "runInsights:cancelRunInsights". */
  cancelMutation: string;
}

export interface InsightHookResult<TResult> {
  canRequest: boolean;
  error: string | null;
  unavailable: boolean;
  requested: boolean;
  pending: boolean;
  failedGeneration: boolean;
  result: TResult | undefined;
  summary: string | null;
  requestInsight: (
    force?: boolean,
    extraArgs?: Record<string, unknown>,
  ) => void;
  cancelInsight: () => void;
}

/** Result freshness marker shared by every insight payload. */
function resultGeneratedAt(result: unknown): number | undefined {
  return (result as { generatedAt?: number } | undefined)?.generatedAt;
}

function classifyInsightError(err: unknown): {
  unavailable: boolean;
  message: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  const unavailable =
    message.includes("Could not find") ||
    message.includes("not found") ||
    message.includes("is not a function") ||
    message.includes("Server Error");
  return { unavailable, message };
}

export function useInsight<TResult extends { summary?: string }>(
  run: EvalSuiteRun | null,
  config: InsightConfig<TResult>,
  options?: { autoRequest?: boolean },
): InsightHookResult<TResult> {
  const autoRequest = options?.autoRequest !== false;
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [requested, setRequested] = useState(false);
  const hasAutoAttemptedRef = useRef(false);
  const runIdRef = useRef<string | null>(null);
  // The result `generatedAt` captured at request time. Lets us clear the
  // optimistic `requested` flag the instant a NEW result lands — even when a
  // reactive update skips an observable `pending` frame — so the controls
  // never stay stuck disabled.
  const latestResultStampRef = useRef<number | undefined>(undefined);
  const requestedAtStampRef = useRef<number | undefined>(undefined);

  const requestMut = useMutation(config.requestMutation as any);
  const cancelMut = useMutation(config.cancelMutation as any);

  const status = run ? config.getStatus(run) : undefined;
  const result = run ? config.getResult(run) : undefined;
  latestResultStampRef.current = resultGeneratedAt(result);

  const canRequest =
    run != null &&
    run.status === "completed" &&
    status !== "pending" &&
    !unavailable;

  const requestInsight = useCallback(
    (force?: boolean, extraArgs?: Record<string, unknown>) => {
      if (!run || unavailable) {
        return;
      }
      setError(null);
      requestedAtStampRef.current = latestResultStampRef.current;
      setRequested(true);
      requestMut({ suiteRunId: run._id, force, ...extraArgs } as any).catch(
        (err: unknown) => {
          setRequested(false);
          const classified = classifyInsightError(err);
          if (classified.unavailable) {
            setUnavailable(true);
          } else {
            setError(classified.message);
          }
        },
      );
    },
    [run, unavailable, requestMut],
  );

  const cancelInsight = useCallback(async () => {
    if (!run || unavailable) {
      return;
    }
    await cancelMut({ suiteRunId: run._id } as any);
  }, [run, unavailable, cancelMut]);

  // Reset state when the run changes.
  const runKey = run?._id ?? "";
  useEffect(() => {
    if (runIdRef.current !== runKey) {
      runIdRef.current = runKey;
      setError(null);
      setRequested(false);
      // Availability is re-assessed per run: a run-specific or transient failure
      // (e.g. "Suite run not found", a transient "Server Error") must not keep
      // the panel hidden for every later run in the same mounted view.
      setUnavailable(false);
      hasAutoAttemptedRef.current = false;
      requestedAtStampRef.current = undefined;
    }
  }, [runKey]);

  // Clear the optimistic "requested" flag once the job has demonstrably
  // progressed — but NOT in the click→`pending` gap where a stale terminal
  // result still lingers (clearing there would re-enable a re-run/retry trigger
  // and allow a duplicate request). Progress is either:
  //   - status flips to `pending` (job started); or
  //   - a fresh result lands — its `generatedAt` advances past the value
  //     captured at request time.
  // Both completion AND failure write a fresh `generatedAt` (the failed
  // fallback in each *Action's catch stamps Date.now()), so a re-run that ends
  // in failure clears here too; the request mutation's catch covers a request
  // that errors before it ever starts.
  useEffect(() => {
    if (
      status === "pending" ||
      resultGeneratedAt(result) !== requestedAtStampRef.current
    ) {
      setRequested(false);
    }
  }, [status, result, run?._id]);

  // Auto-request on first view of a completed run with no insight.
  useEffect(() => {
    if (!autoRequest) {
      return;
    }
    if (!run || unavailable || hasAutoAttemptedRef.current) {
      return;
    }
    if (run.status !== "completed") {
      return;
    }
    if (status === "pending" || status === "completed" || status === "failed") {
      return;
    }

    hasAutoAttemptedRef.current = true;
    requestInsight(false);
  }, [autoRequest, run, status, run?.status, unavailable, requestInsight]);

  return {
    canRequest,
    error,
    unavailable,
    requested,
    requestInsight,
    cancelInsight,
    result,
    summary: (result as { summary?: string } | undefined)?.summary ?? null,
    pending: status === "pending",
    failedGeneration: status === "failed",
  };
}
