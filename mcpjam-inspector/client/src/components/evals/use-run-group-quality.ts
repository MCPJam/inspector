/**
 * Cross-host group quality hook. Distinct from `useInsight` (which assumes the
 * insight lives on a single `EvalSuiteRun` document) — group quality lives in
 * its own `runGroupQuality` row keyed by (suiteId, runGroupId) and is gated on
 * EVERY sibling run being terminal.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { EvalSuiteRun, RunGroupQualityResult } from "./types";

type GroupStatus = "pending" | "completed" | "failed" | undefined;

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

export interface RunGroupQualityState {
  result: RunGroupQualityResult | undefined;
  status: GroupStatus;
  pending: boolean;
  failedGeneration: boolean;
  error: string | null;
  requested: boolean;
  /** True once the backend feature is confirmed missing — hide the surface. */
  unavailable: boolean;
  /** Every sibling run finished and there are ≥2 of them. */
  allRunsTerminal: boolean;
  /** Eligible to (re)generate right now. */
  canRequest: boolean;
  request: (force?: boolean) => void;
  cancel: () => void;
}

export function useRunGroupQuality(params: {
  suiteId: string | null | undefined;
  runGroupId: string | null | undefined;
  runs: EvalSuiteRun[];
  /** Defaults to true. Set false to require an explicit click (cost control). */
  autoRequest?: boolean;
}): RunGroupQualityState {
  const { suiteId, runGroupId, runs } = params;
  const autoRequest = params.autoRequest !== false;
  const enabled = !!suiteId && !!runGroupId;

  const statusData = useQuery(
    "runGroupQuality:getRunGroupQualityStatus" as any,
    enabled ? ({ suiteId, runGroupId } as any) : "skip",
  ) as
    | { status?: GroupStatus; quality?: RunGroupQualityResult; jobId?: unknown }
    | undefined;

  const requestMut = useMutation(
    "runGroupQuality:requestRunGroupQuality" as any,
  );
  const cancelMut = useMutation("runGroupQuality:cancelRunGroupQuality" as any);

  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const autoAttemptedRef = useRef(false);

  const status = statusData?.status;
  const result = statusData?.quality;

  const allRunsTerminal =
    runs.length >= 2 && runs.every((r) => TERMINAL_RUN_STATUSES.has(r.status));
  const canRequest =
    enabled && allRunsTerminal && status !== "pending" && !unavailable;

  const request = useCallback(
    (force?: boolean) => {
      if (!enabled || !allRunsTerminal || unavailable) return;
      setError(null);
      setRequested(true);
      requestMut({ suiteId, runGroupId, force } as any).catch((err: unknown) => {
        setRequested(false);
        const raw = err instanceof Error ? err.message : String(err);
        // Feature not deployed — permanent for the session, hide the surface.
        if (raw.includes("Could not find") || raw.includes("is not a function")) {
          setUnavailable(true);
        } else {
          setError(raw);
        }
      });
    },
    [enabled, allRunsTerminal, unavailable, requestMut, suiteId, runGroupId],
  );

  const cancel = useCallback(() => {
    if (!enabled) return;
    cancelMut({ suiteId, runGroupId } as any).catch(() => {});
  }, [enabled, cancelMut, suiteId, runGroupId]);

  // Reset transient state when the targeted group changes.
  const key = `${suiteId ?? ""}:${runGroupId ?? ""}`;
  const keyRef = useRef(key);
  useEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key;
      setError(null);
      setRequested(false);
      autoAttemptedRef.current = false;
    }
  }, [key]);

  // Clear the optimistic flag once a row demonstrably exists.
  useEffect(() => {
    if (status === "pending" || status === "completed" || status === "failed") {
      setRequested(false);
    }
  }, [status]);

  // Auto-request once every sibling run is terminal and no row exists yet.
  // `statusData === undefined` means the query is still loading; a loaded
  // "no row" state resolves to an object with `status: undefined`.
  useEffect(() => {
    if (!autoRequest || !enabled || unavailable || autoAttemptedRef.current) {
      return;
    }
    if (!allRunsTerminal) return;
    if (statusData === undefined) return;
    if (status !== undefined) return;
    autoAttemptedRef.current = true;
    request(false);
  }, [
    autoRequest,
    enabled,
    unavailable,
    allRunsTerminal,
    statusData,
    status,
    request,
  ]);

  return {
    result,
    status,
    pending: status === "pending",
    failedGeneration: status === "failed",
    error,
    requested,
    unavailable,
    allRunsTerminal,
    canRequest,
    request,
    cancel,
  };
}
