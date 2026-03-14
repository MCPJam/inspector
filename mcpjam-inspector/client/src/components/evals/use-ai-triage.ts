import { useState, useCallback, useMemo, useEffect } from "react";
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
 * panel shows "AI triage unavailable" instead of crashing.
 */
export function useCommitTriage(
  failedRunIds: string[],
): {
  summary: string | null;
  loading: boolean;
  error: string | null;
  requestTriage: () => void;
} {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  // Reset state when the run IDs change (navigating to a different commit)
  const runKey = failedRunIds.join(",");
  useEffect(() => {
    setSummary(null);
    setError(null);
    setLoading(false);
    setUnavailable(false);
  }, [runKey]);

  let requestTriageMutation: ReturnType<typeof useMutation> | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    requestTriageMutation = useMutation("testSuites:requestTriage" as any);
  } catch {
    // Mutation not registered yet — backend not deployed
  }

  const requestTriage = useCallback(() => {
    if (failedRunIds.length === 0 || unavailable) return;
    if (!requestTriageMutation) {
      setUnavailable(true);
      return;
    }

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
          // In future, a reactive query subscription will update this
          setLoading(false);
          setError("Triage requested — results will appear when backend processing completes.");
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // Detect "function not found" errors from Convex
        if (message.includes("Could not find") || message.includes("not found")) {
          setUnavailable(true);
        } else {
          setError(message);
        }
        setLoading(false);
      });
  }, [failedRunIds, requestTriageMutation, unavailable]);

  return { summary, loading, error, requestTriage };
}
