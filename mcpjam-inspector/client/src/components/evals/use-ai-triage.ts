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
 * This hook manages the mutation call, local error state, and auto-request when
 * the user opens a failed run that has not started triage yet.
 *
 * @param options.autoRequest - When false, only manual `requestTriage` runs (defaults to true).
 */
export function useAiTriage(
  run: EvalSuiteRun | null,
  failedCount?: number,
  options?: { autoRequest?: boolean },
) {
  const autoRequest = options?.autoRequest !== false;
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [requested, setRequested] = useState(false);
  const hasAutoAttemptedRef = useRef(false);
  const runIdRef = useRef<string | null>(null);

  const requestTriageMutation = useMutation("triage:requestTriage" as any);

  const failed = failedCount ?? run?.summary?.failed ?? 0;

  const canTriage =
    run != null &&
    run.status === "completed" &&
    failed > 0 &&
    run.triageStatus !== "pending" &&
    !unavailable;

  const requestTriage = useCallback(() => {
    if (!run || unavailable) return;
    if (requested) return;

    setError(null);
    setRequested(true);

    const force =
      run.triageStatus === "completed" || run.triageStatus === "failed";

    requestTriageMutation({ suiteRunId: run._id, force } as any).catch(
      (err: unknown) => {
        setRequested(false);
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
  }, [run, requested, unavailable, requestTriageMutation]);

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
    if (run?.triageStatus === "completed" || run?.triageStatus === "failed") {
      setRequested(false);
    }
  }, [run?.triageStatus, run?._id]);

  useEffect(() => {
    if (!autoRequest) return;
    if (!run || unavailable || hasAutoAttemptedRef.current) return;
    if (run.status !== "completed" || failed <= 0) return;
    if (
      run.triageStatus === "pending" ||
      run.triageStatus === "completed" ||
      run.triageStatus === "failed"
    ) {
      return;
    }

    hasAutoAttemptedRef.current = true;
    setError(null);
    setRequested(true);

    requestTriageMutation({ suiteRunId: run._id, force: false } as any).catch(
      (err: unknown) => {
        hasAutoAttemptedRef.current = false;
        setRequested(false);
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
      },
    );
  }, [
    run,
    failed,
    unavailable,
    requestTriageMutation,
    run?.triageStatus,
    run?._id,
    run?.status,
    autoRequest,
  ]);

  return { canTriage, error, unavailable, requested, requestTriage };
}

// ---------------------------------------------------------------------------
// Hook: triage for a commit (multiple runs) — used by commit-detail-view
// and overview-panel
// ---------------------------------------------------------------------------

export function useCommitTriage(failedRuns: EvalSuiteRun[]): {
  summary: string | null;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  requestTriage: () => void;
} {
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const hasAttemptedRef = useRef(false);
  const requestTriageMutation = useMutation("triage:requestTriage" as any);

  const primaryRun = failedRuns[0] ?? null;
  const summary = primaryRun?.triageSummary?.summary ?? null;
  const loading = failedRuns.some((r) => r.triageStatus === "pending");

  const runKey = failedRuns.map((r) => r._id).join(",");
  const prevRunKeyRef = useRef(runKey);
  useEffect(() => {
    if (prevRunKeyRef.current !== runKey) {
      prevRunKeyRef.current = runKey;
      setError(null);
      hasAttemptedRef.current = false;
    }
  }, [runKey]);

  const requestTriage = useCallback(() => {
    if (!primaryRun || unavailable || hasAttemptedRef.current) return;

    hasAttemptedRef.current = true;
    setError(null);

    const force =
      primaryRun.triageStatus === "completed" ||
      primaryRun.triageStatus === "failed";

    requestTriageMutation({ suiteRunId: primaryRun._id, force } as any).catch(
      (err: unknown) => {
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
      },
    );
  }, [primaryRun, requestTriageMutation, unavailable]);

  return { summary, loading, error, unavailable, requestTriage };
}
