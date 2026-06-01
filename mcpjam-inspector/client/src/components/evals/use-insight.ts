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
  permanent: boolean;
  message: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  // "Feature missing" — the backend mutation isn't deployed at all. This is
  // permanent for the session: a Convex function-lookup failure won't change
  // between runs, so the panel should stay hidden without re-attempting.
  const permanent =
    message.includes("Could not find") ||
    message.includes("is not a function");
  const unavailable =
    permanent ||
    message.includes("not found") || // run-specific, e.g. "Suite run not found"
    message.includes("Server Error");
  return { unavailable, permanent, message };
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
  // True only when the backend feature itself is missing (mutation not
  // deployed). Unlike a run-specific/transient failure, this is permanent for
  // the hook's lifetime, so we keep `unavailable` sticky across run switches
  // rather than re-attempting (and flashing the panel) on every navigation.
  const featureMissingRef = useRef(false);
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
            if (classified.permanent) {
              featureMissingRef.current = true;
            }
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
      // Re-assess availability per run for run-specific/transient failures
      // (e.g. "Suite run not found") so one bad run doesn't hide the panel for
      // every later run — but keep it sticky when the backend feature is
      // genuinely missing, so an autoRequest consumer (serverQuality) doesn't
      // re-fire a failing request and flash the panel on every navigation.
      if (!featureMissingRef.current) {
        setUnavailable(false);
      }
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
