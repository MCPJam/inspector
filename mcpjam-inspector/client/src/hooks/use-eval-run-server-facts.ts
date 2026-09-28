/**
 * Fetch hook for ONE run's server facts.
 *
 * The sibling of `use-eval-run-route-facts.ts`, and it keeps the parts that
 * are about correctness rather than paging: a monotonic request id so an
 * out-of-order response can never paint over a newer one, and an
 * `AbortController` per effect.
 *
 * ── NO TERMINAL-STATUS GATE, AND THAT IS THE POINT ───────────────────────────
 *
 * Route facts are materialized when a run terminalizes, so their hook has to
 * re-ask once the run is over. Server facts are COMPUTED ON READ from the
 * snapshot the run already stored, so they are available the moment the run
 * exists — a page opened mid-run gets a real answer rather than an `absent`
 * it would have to re-ask for.
 *
 * ── `absent` is still its own state ──────────────────────────────────────────
 *
 * Reached only when the run is not visible to this caller, since a run with no
 * snapshot answers `state: "unavailable"` INSIDE a valid document. Kept as a
 * state rather than an error for the same reason as the sibling: a red service
 * message is the wrong thing to show for "there is nothing here".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EvalRunServerFactsV1 } from "@mcpjam/sdk/contract";
import {
  fetchEvalRunServerFacts,
  isEvalServerFactsError,
  type ServerFactsFailureKind,
} from "@/lib/apis/eval-server-facts-api";

export interface ServerFactsErrorInfo {
  message: string;
  /**
   * WHICH failure, kept apart rather than collapsed into "error".
   *
   * `routeUnavailable` and `requestFailed` are SERVICE states, while
   * `invalidContract` is a bug report — the backend builder and the published
   * contract have drifted — and `notFound` is a fact about visibility.
   */
  kind: ServerFactsFailureKind;
  status?: number;
}

export type EvalRunServerFactsStatus =
  | "idle"
  | "loading"
  | "ready"
  | "absent"
  | "error";

export interface EvalRunServerFactsState {
  status: EvalRunServerFactsStatus;
  /** The run's document, or `null` in every state but `ready`. */
  document: EvalRunServerFactsV1 | null;
  error: ServerFactsErrorInfo | null;
  /** Re-runs the read. A no-op while inactive. */
  refetch: () => void;
}

function toErrorInfo(error: unknown): ServerFactsErrorInfo {
  if (isEvalServerFactsError(error)) {
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

export function useEvalRunServerFacts({
  projectId,
  runId,
  enabled = true,
}: {
  projectId: string | null | undefined;
  runId: string | null | undefined;
  enabled?: boolean;
}): EvalRunServerFactsState {
  const active = Boolean(enabled && projectId && runId);
  /**
   * What the state below is ABOUT. Read during render, not in the effect.
   *
   * Clearing the document in an effect is one render too late: on the render
   * where `runId` changes, the effect has not run yet, so `status` still says
   * `ready` and `document` still holds the PREVIOUS run's facts — and the
   * card renders them, briefly, under the new run's heading. A key compared
   * synchronously means a document is only ever shown for the selection it
   * was fetched for.
   */
  const requestKey = active ? `${projectId}\u0000${runId}\u0000` : null;

  const [document, setDocument] = useState<EvalRunServerFactsV1 | null>(null);
  const [documentKey, setDocumentKey] = useState<string | null>(null);
  const [status, setStatus] = useState<EvalRunServerFactsStatus>("idle");
  const [error, setError] = useState<ServerFactsErrorInfo | null>(null);
  const [attempt, setAttempt] = useState(0);

  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!active) {
      requestIdRef.current += 1;
      setStatus("idle");
      setDocument(null);
      setDocumentKey(null);
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
        const row = await fetchEvalRunServerFacts(
          { projectId: projectId as string, runId: runId as string },
          controller.signal,
        );
        if (requestId !== requestIdRef.current) return;
        setDocument(row);
        setDocumentKey(requestKey);
        setStatus("ready");
      } catch (err) {
        if (controller.signal.aborted) return;
        if (requestId !== requestIdRef.current) return;
        setDocument(null);
        // Every SETTLED outcome stamps the key, not just the happy one: an
        // absence and an error are answers about this selection too, and a
        // hook that left them unstamped would report `loading` forever.
        setDocumentKey(requestKey);
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
  }, [active, projectId, runId, attempt, requestKey]);

  const refetch = useCallback(() => {
    if (!active) return;
    setAttempt((n) => n + 1);
  }, [active]);

  // A settled state that belongs to a different selection is not this one's,
  // whatever the effect has managed to run so far.
  const stale = active && documentKey !== requestKey;
  const observed: EvalRunServerFactsStatus = !active
    ? status
    : stale || status === "idle"
      ? "loading"
      : status;

  return {
    status: observed,
    document: stale ? null : document,
    error: stale ? null : error,
    refetch,
  };
}
