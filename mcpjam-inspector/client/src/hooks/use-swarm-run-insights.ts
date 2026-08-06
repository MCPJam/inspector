/**
 * Lane A insights for one swarm run: subscribe, auto-request on first view,
 * regenerate, cancel.
 *
 * Adapted from the evals `useInsight` hook rather than shared with it — that
 * one is keyed on a `testSuiteRun` document and reads its lifecycle off run
 * fields, while a run is keyed on `(projectId, swarmRunGroupId)` and carries
 * its lifecycle on its own row. What IS carried over is the hard-won
 * behaviour: an optimistic `requested` flag so controls never stick, a sticky
 * "feature missing" latch so an undeployed backend hides the surface instead
 * of retrying forever, and error classification that distinguishes REJECTIONS
 * (rate limits, spend caps — the feature works, say so) from UNAVAILABILITY
 * (hide the band).
 *
 * The classifier deliberately does NOT copy the evals branch verbatim: it
 * matches `insights_daily_limit_reached`, a string the backend never emits.
 * The real rejection is `billing_limit_reached` / `Limit "insightsPerDay"`
 * from the entitlement helper, so that is what this matches.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";

import {
  SWARM_MUTATIONS,
  SWARM_QUERIES,
  type SwarmWaveDiscovery,
  type SwarmWaveInsights,
  type SwarmWaveInsightsDto,
} from "@/lib/swarm-api";

export type UseSwarmRunInsightsResult = {
  /** Undefined while loading; null when never requested for this run. */
  dto: SwarmWaveInsightsDto | null | undefined;
  insights: SwarmWaveInsights | null;
  /** Lane B findings, when the backend has them (absent on older deploys). */
  discovery: SwarmWaveDiscovery | null;
  status: "pending" | "completed" | "failed" | null;
  /** Pending on the server OR optimistically requested from this client. */
  busy: boolean;
  /** The backend does not expose the feature — render nothing. */
  unavailable: boolean;
  /** A rejection worth showing (spend cap, daily limit, generation failure). */
  error: string | null;
  request: (force?: boolean) => void;
  cancel: () => Promise<void>;
};

function classifyRunInsightError(err: unknown): {
  unavailable: boolean;
  permanent: boolean;
  message: string;
} {
  const raw = err instanceof Error ? err.message : String(err);

  // Entitlement rejection — the feature works, the org is capped. Must be
  // matched BEFORE the generic "Server Error" test, which Convex prefixes onto
  // every thrown mutation error and which otherwise hides the whole band.
  if (
    raw.includes("billing_limit_reached") ||
    raw.includes('Limit "insightsPerDay"')
  ) {
    return {
      unavailable: false,
      permanent: false,
      message:
        "Daily insights limit reached for this workspace. Try again tomorrow.",
    };
  }
  if (raw.includes("wave_not_terminal")) {
    return {
      unavailable: false,
      permanent: false,
      message: "This swarm run is still running.",
    };
  }
  if (raw.includes("wave_too_large")) {
    return {
      unavailable: false,
      permanent: false,
      message: "This swarm run is too large to analyze.",
    };
  }

  // The mutation isn't deployed. Permanent for this session — a Convex
  // function-lookup failure will not resolve between attempts.
  const permanent =
    raw.includes("Could not find") || raw.includes("is not a function");
  const unavailable =
    permanent || raw.includes("wave_not_found") || raw.includes("Server Error");
  return { unavailable, permanent, message: raw };
}

export function useSwarmRunInsights(
  projectId: string | null,
  swarmRunGroupId: string | null,
  options?: { autoRequest?: boolean; terminal?: boolean },
): UseSwarmRunInsightsResult {
  const autoRequest = options?.autoRequest !== false;
  const terminal = options?.terminal === true;
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [requested, setRequested] = useState(false);
  const featureMissingRef = useRef(false);
  const hasAutoAttemptedRef = useRef(false);
  const runKeyRef = useRef<string | null>(null);

  const queryable = Boolean(projectId && swarmRunGroupId);
  const dto = useQuery(
    SWARM_QUERIES.getWaveInsights as any,
    (queryable ? { projectId, swarmRunGroupId } : "skip") as any,
  ) as SwarmWaveInsightsDto | null | undefined;

  const requestMut = useMutation(SWARM_MUTATIONS.requestWaveInsights as any);
  const cancelMut = useMutation(SWARM_MUTATIONS.cancelWaveInsights as any);

  const request = useCallback(
    (force?: boolean) => {
      if (!projectId || !swarmRunGroupId || unavailable) return;
      setError(null);
      setRequested(true);
      requestMut({ projectId, swarmRunGroupId, force } as any).catch(
        (err: unknown) => {
          setRequested(false);
          const classified = classifyRunInsightError(err);
          if (classified.unavailable) {
            if (classified.permanent) featureMissingRef.current = true;
            setUnavailable(true);
          } else {
            setError(classified.message);
          }
        },
      );
    },
    [projectId, swarmRunGroupId, unavailable, requestMut],
  );

  const cancel = useCallback(async () => {
    if (!projectId || !swarmRunGroupId || unavailable) return;
    await cancelMut({ projectId, swarmRunGroupId } as any);
  }, [projectId, swarmRunGroupId, unavailable, cancelMut]);

  // Reset per run. `unavailable` is re-assessed per wave for run-specific
  // failures, but stays latched when the backend feature itself is missing —
  // otherwise navigating between runs re-fires a doomed request each time.
  const runKey = `${projectId ?? ""}:${swarmRunGroupId ?? ""}`;
  useEffect(() => {
    if (runKeyRef.current === runKey) return;
    runKeyRef.current = runKey;
    setError(null);
    setRequested(false);
    hasAutoAttemptedRef.current = false;
    if (!featureMissingRef.current) setUnavailable(false);
  }, [runKey]);

  // Clear the optimistic flag once the server has a terminal answer.
  useEffect(() => {
    if (!requested) return;
    if (dto && dto.status !== "pending") setRequested(false);
  }, [dto, requested]);

  // Auto-request once per run, on first view of a TERMINAL run that has no
  // row yet. A run still running has nothing complete to analyze, and the
  // backend would reject it anyway.
  useEffect(() => {
    if (!autoRequest || !queryable || unavailable) return;
    if (!terminal) return;
    if (dto === undefined) return; // still loading
    if (dto !== null) return; // already requested at some point
    if (hasAutoAttemptedRef.current) return;
    hasAutoAttemptedRef.current = true;
    request();
  }, [autoRequest, queryable, unavailable, terminal, dto, request]);

  const status = dto?.status ?? null;
  const busy = requested || status === "pending";
  const serverError = useMemo(() => {
    if (!dto || dto.status !== "failed") return null;
    if (dto.errorCode === "spend_cap_exceeded") {
      return "Spending cap reached — insights were not generated.";
    }
    if (dto.errorCode === "cancelled") return null;
    return dto.errorMessage || "Insights could not be generated.";
  }, [dto]);

  return {
    dto,
    insights: dto?.insights ?? null,
    discovery: dto?.discovery ?? null,
    status,
    busy,
    unavailable,
    error: error ?? serverError,
    request,
    cancel,
  };
}
