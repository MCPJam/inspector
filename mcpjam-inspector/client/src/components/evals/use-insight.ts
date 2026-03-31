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
  requestInsight: (force?: boolean) => void;
  cancelInsight: () => void;
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

  const requestMut = useMutation(config.requestMutation as any);
  const cancelMut = useMutation(config.cancelMutation as any);

  const status = run ? config.getStatus(run) : undefined;
  const result = run ? config.getResult(run) : undefined;

  const canRequest =
    run != null &&
    run.status === "completed" &&
    status !== "pending" &&
    !unavailable;

  const requestInsight = useCallback(
    (force?: boolean) => {
      if (!run || unavailable) {
        return;
      }
      setError(null);
      setRequested(true);
      requestMut({ suiteRunId: run._id, force } as any).catch(
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
      hasAutoAttemptedRef.current = false;
    }
  }, [runKey]);

  // Clear optimistic "requested" flag once the server status catches up.
  useEffect(() => {
    if (status === "completed" || status === "failed") {
      setRequested(false);
    }
  }, [status, run?._id]);

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
