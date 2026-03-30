import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import type { EvalSuiteRun } from "./types";

export const RUN_INSIGHTS_PENDING_STALE_MS = 120_000;

function classifyRunInsightsError(err: unknown): {
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

/**
 * Request and track diff-based run insights (`runInsights` on `testSuiteRun`).
 * Reactive fields: `runInsights`, `runInsightsStatus` on the run document.
 */
export function useRunInsights(
  run: EvalSuiteRun | null,
  options?: { autoRequest?: boolean },
) {
  const autoRequest = options?.autoRequest !== false;
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [requested, setRequested] = useState(false);
  const hasAutoAttemptedRef = useRef(false);
  const runIdRef = useRef<string | null>(null);

  const requestMutation = useMutation("runInsights:requestRunInsights" as any);
  const cancelMutation = useMutation("runInsights:cancelRunInsights" as any);

  const canRequest =
    run != null &&
    run.status === "completed" &&
    run.runInsightsStatus !== "pending" &&
    !unavailable;

  const requestRunInsights = useCallback(
    (force?: boolean) => {
      if (!run || unavailable) {
        return;
      }
      setError(null);
      setRequested(true);
      requestMutation({ suiteRunId: run._id, force } as any).catch(
        (err: unknown) => {
          setRequested(false);
          const classified = classifyRunInsightsError(err);
          if (classified.unavailable) {
            setUnavailable(true);
          } else {
            setError(classified.message);
          }
        },
      );
    },
    [run, unavailable, requestMutation],
  );

  const cancelRunInsights = useCallback(async () => {
    if (!run || unavailable) {
      return;
    }
    await cancelMutation({ suiteRunId: run._id } as any);
  }, [run, unavailable, cancelMutation]);

  const runKey = run?._id ?? "";
  useEffect(() => {
    if (runIdRef.current !== runKey) {
      runIdRef.current = runKey;
      setError(null);
      setRequested(false);
      hasAutoAttemptedRef.current = false;
    }
  }, [runKey]);

  useEffect(() => {
    if (
      run?.runInsightsStatus === "completed" ||
      run?.runInsightsStatus === "failed"
    ) {
      setRequested(false);
    }
  }, [run?.runInsightsStatus, run?._id]);

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
    if (run.runInsightsStatus === "pending") {
      return;
    }
    if (run.runInsightsStatus === "completed") {
      return;
    }
    if (run.runInsightsStatus === "failed") {
      return;
    }

    hasAutoAttemptedRef.current = true;
    requestRunInsights(false);
  }, [
    autoRequest,
    run,
    run?.runInsightsStatus,
    run?.status,
    unavailable,
    requestRunInsights,
  ]);

  return {
    canRequest,
    error,
    unavailable,
    requested,
    requestRunInsights,
    cancelRunInsights,
    summary: run?.runInsights?.summary ?? null,
    pending: run?.runInsightsStatus === "pending",
    failedGeneration: run?.runInsightsStatus === "failed",
  };
}
