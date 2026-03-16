import { useState, useCallback, useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import type { EvalSuiteRun } from "./types";

// ---------------------------------------------------------------------------
// Hook: triage for a single suite run (used in RunDetailView)
// ---------------------------------------------------------------------------

/**
 * Hook to request and manage AI triage for a suite run.
 *
 * Triage results are reactive — they live on the `testSuiteRun` document
 * (`triageStatus` / `triageSummary`), so no polling or separate query is needed.
 * This hook only manages the mutation call and local error state.
 */
export function useAiTriage(run: EvalSuiteRun | null, failedCount?: number) {
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [requested, setRequested] = useState(false);

  const requestTriageMutation = useMutation("triage:requestTriage" as any);

  const failed = failedCount ?? run?.summary?.failed ?? 0;

  const canTriage =
    run != null &&
    run.status === "completed" &&
    failed > 0 &&
    run.triageStatus !== "pending" &&
    !unavailable;

  const requestTriage = useCallback(() => {
    if (!run || requested) return;

    setError(null);
    setRequested(true);

    const force =
      run.triageStatus === "completed" || run.triageStatus === "failed";

    requestTriageMutation({ suiteRunId: run._id, force } as any).catch(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (
          message.includes("Could not find") ||
          message.includes("not found") ||
          message.includes("is not a function") ||
          message.includes("Server Error")
        ) {
          setUnavailable(true);
        } else {
          setError(message);
        }
      },
    );
  }, [run, requested, requestTriageMutation]);

  return { canTriage, error, unavailable, requested, requestTriage };
}

// ---------------------------------------------------------------------------
// Hook: triage for a commit (multiple runs) — used by commit-detail-view
// and overview-panel
// ---------------------------------------------------------------------------

export function useCommitTriage(failedRunIds: string[]): {
  summary: string | null;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  requestTriage: () => void;
} {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const hasAttemptedRef = useRef(false);

  const requestTriageMutation = useMutation("triage:requestTriage" as any);

  // Reset state when the run IDs change
  const runKey = failedRunIds.join(",");
  const prevRunKeyRef = useRef(runKey);
  useEffect(() => {
    if (prevRunKeyRef.current !== runKey) {
      prevRunKeyRef.current = runKey;
      setSummary(null);
      setError(null);
      setLoading(false);
      hasAttemptedRef.current = false;
    }
  }, [runKey]);

  const requestTriage = useCallback(() => {
    if (failedRunIds.length === 0 || unavailable || hasAttemptedRef.current)
      return;

    hasAttemptedRef.current = true;
    setLoading(true);
    setError(null);

    const primaryRunId = failedRunIds[0];
    requestTriageMutation({ suiteRunId: primaryRunId } as any)
      .then((result: any) => {
        if (result?.summary) {
          setSummary(result.summary);
          setLoading(false);
        } else {
          setLoading(false);
          setSummary(
            "Triage requested — results will appear when backend processing completes.",
          );
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (
          message.includes("Could not find") ||
          message.includes("not found") ||
          message.includes("is not a function") ||
          message.includes("Server Error")
        ) {
          setUnavailable(true);
          setError(null);
        } else {
          setError(message);
        }
        setLoading(false);
      });
  }, [failedRunIds, requestTriageMutation, unavailable]);

  return { summary, loading, error, unavailable, requestTriage };
}
