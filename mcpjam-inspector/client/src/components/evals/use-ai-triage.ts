import { useState, useCallback, useEffect, useRef } from "react";
import { useMutation } from "convex/react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TriageResult {
  _id: string;
  suiteRunId: string;
  summary: string;
  status: "pending" | "generating" | "completed" | "failed";
  error?: string;
  generatedAt?: number;
}

// ---------------------------------------------------------------------------
// Hook: triage for a commit (multiple runs)
// ---------------------------------------------------------------------------

/**
 * Hook to request AI triage for failed runs via the Convex backend.
 *
 * Calls `testSuites:requestTriage` mutation for each failed run.
 * The backend generates the summary asynchronously (action → AI SDK → save).
 *
 * Until the backend mutation is deployed, requests fail gracefully and the
 * panel stays hidden instead of flashing briefly.
 */
export function useCommitTriage(
  failedRunIds: string[],
): {
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

  // Always call useMutation (React hooks rules) — if the function doesn't
  // exist on the backend, the call itself will fail, which we handle below.
  const requestTriageMutation = useMutation("testSuites:requestTriage" as any);

  // Reset state when the run IDs actually change (navigating to a different commit)
  const runKey = failedRunIds.join(",");
  const prevRunKeyRef = useRef(runKey);
  useEffect(() => {
    if (prevRunKeyRef.current !== runKey) {
      prevRunKeyRef.current = runKey;
      setSummary(null);
      setError(null);
      setLoading(false);
      hasAttemptedRef.current = false;
      // Keep unavailable sticky — if the mutation doesn't exist, it won't
      // magically appear when switching commits
    }
  }, [runKey]);

  const requestTriage = useCallback(() => {
    if (failedRunIds.length === 0 || unavailable || hasAttemptedRef.current) return;

    hasAttemptedRef.current = true;
    setLoading(true);
    setError(null);

    // Request triage for the primary (first) failed run
    const primaryRunId = failedRunIds[0];
    requestTriageMutation({ suiteRunId: primaryRunId } as any)
      .then((result: any) => {
        // If the mutation returns a summary directly, use it
        if (result?.summary) {
          setSummary(result.summary);
          setLoading(false);
        } else {
          // Backend will generate async — for now show as pending
          setLoading(false);
          setSummary("Triage requested — results will appear when backend processing completes.");
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // Detect backend errors that mean triage isn't available — mark permanently unavailable
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
