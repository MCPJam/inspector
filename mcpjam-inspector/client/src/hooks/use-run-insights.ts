/**
 * Lane A insights for one analyzed cohort: subscribe, auto-request on first
 * view, regenerate, cancel.
 *
 * TWO SURFACES, ONE LIFECYCLE. A swarm wave is keyed on
 * `(projectId, swarmRunGroupId)`; a User Testing window is keyed on
 * `(chatboxId, windowGroupId)`. Everything else — the optimistic `requested`
 * flag, the sticky feature-missing latch, the error classifier, the
 * auto-request-once rule — is identical, so the scope branches only on which
 * query/mutation name to call and what args to pass. Same shape as
 * `useUsageInsights`.
 *
 * Adapted from the evals `useInsight` hook rather than shared with it: that one
 * is DOCUMENT-KEYED (it reads lifecycle fields off a `testSuiteRun` row with no
 * subscription of its own) and separately pinned, so merging it would mean
 * rewriting its call sites for a shape it does not have. What IS carried over
 * is the hard-won behaviour: an optimistic `requested` flag so controls never
 * stick, a sticky "feature missing" latch so an undeployed backend hides the
 * surface instead of retrying forever, and error classification that
 * distinguishes REJECTIONS (rate limits, spend caps — the feature works, say
 * so) from UNAVAILABILITY (hide the band).
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
import {
  CHATBOX_INSIGHTS_MUTATIONS,
  CHATBOX_INSIGHTS_QUERIES,
  type ChatboxWindowInsights,
  type ChatboxWindowInsightsDto,
} from "@/lib/chatbox-insights-api";

/**
 * Which cohort's narration to read. The group id is REQUIRED on both arms: it
 * names frozen data, and a hook that guessed one could render a narration of a
 * different set of sessions than the caller is showing signals for.
 */
export type RunInsightsScope =
  | { kind: "swarm"; projectId: string; swarmRunGroupId: string }
  | { kind: "chatbox"; chatboxId: string; groupId: string };

/** The narrated payload, in the shape both surfaces share. */
export type RunInsightsPayload = SwarmWaveInsights | ChatboxWindowInsights;

export type UseRunInsightsResult = {
  /** Undefined while loading; null when never requested for this cohort. */
  dto: SwarmWaveInsightsDto | ChatboxWindowInsightsDto | null | undefined;
  insights: RunInsightsPayload | null;
  /** Lane B findings — swarm only; User Testing has no discovery lane. */
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
  // Nothing has been analyzed yet, so there is no frozen window to narrate.
  // Not a failure of the feature — the surface is simply early.
  if (raw.includes("window_not_analyzed")) {
    return {
      unavailable: false,
      permanent: false,
      message: "Insights appear once sessions settle.",
    };
  }
  // Requesting spends, so it is member-gated while viewing is not. A guest
  // hitting it is a normal outcome on a guest-visible surface, not a broken
  // backend — and NOT `permanent`, which the caller latches to mean "this
  // deployment does not have the feature". Who is asking can change within a
  // session; what is deployed cannot. The caller already suppresses
  // auto-request for guests through `canRequest`, so nothing needs the latch.
  if (
    raw.includes("Insufficient workspace permissions") ||
    raw.includes("Not a member of this workspace")
  ) {
    return {
      unavailable: false,
      permanent: false,
      message: "Ask a workspace member to generate insights.",
    };
  }

  // The mutation isn't deployed. Permanent for this session — a Convex
  // function-lookup failure will not resolve between attempts.
  const permanent =
    raw.includes("Could not find") || raw.includes("is not a function");
  const unavailable =
    permanent ||
    raw.includes("wave_not_found") ||
    raw.includes("chatbox_not_found") ||
    raw.includes("Server Error");
  return { unavailable, permanent, message: raw };
}

export function useRunInsights(
  scope: RunInsightsScope | null,
  options?: { autoRequest?: boolean; terminal?: boolean },
): UseRunInsightsResult {
  const autoRequest = options?.autoRequest !== false;
  const terminal = options?.terminal === true;
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [requested, setRequested] = useState(false);
  const featureMissingRef = useRef(false);
  const hasAutoAttemptedRef = useRef(false);
  const runKeyRef = useRef<string | null>(null);

  const isSwarm = scope?.kind === "swarm";
  const queryName = isSwarm
    ? SWARM_QUERIES.getWaveInsights
    : CHATBOX_INSIGHTS_QUERIES.getWindowInsights;
  const queryArgs = !scope
    ? "skip"
    : scope.kind === "swarm"
      ? { projectId: scope.projectId, swarmRunGroupId: scope.swarmRunGroupId }
      : { chatboxId: scope.chatboxId, windowGroupId: scope.groupId };

  const dto = useQuery(queryName as any, queryArgs as any) as
    | SwarmWaveInsightsDto
    | ChatboxWindowInsightsDto
    | null
    | undefined;

  const requestSwarm = useMutation(SWARM_MUTATIONS.requestWaveInsights as any);
  const cancelSwarm = useMutation(SWARM_MUTATIONS.cancelWaveInsights as any);
  const requestWindow = useMutation(
    CHATBOX_INSIGHTS_MUTATIONS.requestWindowInsights as any,
  );
  const cancelWindow = useMutation(
    CHATBOX_INSIGHTS_MUTATIONS.cancelWindowInsights as any,
  );

  const request = useCallback(
    (force?: boolean) => {
      if (!scope || unavailable) return;
      setError(null);
      setRequested(true);
      // The window request takes no group id: the backend anchors it to the
      // latest snapshot itself, so a client cannot ask for narration of a
      // window that no longer is the latest one.
      const promise =
        scope.kind === "swarm"
          ? requestSwarm({
              projectId: scope.projectId,
              swarmRunGroupId: scope.swarmRunGroupId,
              force,
            } as any)
          : requestWindow({ chatboxId: scope.chatboxId, force } as any);
      promise.catch((err: unknown) => {
        setRequested(false);
        const classified = classifyRunInsightError(err);
        if (classified.unavailable) {
          if (classified.permanent) featureMissingRef.current = true;
          setUnavailable(true);
        } else {
          if (classified.permanent) featureMissingRef.current = true;
          setError(classified.message);
        }
      });
    },
    [scope, unavailable, requestSwarm, requestWindow],
  );

  const cancel = useCallback(async () => {
    if (!scope || unavailable) return;
    if (scope.kind === "swarm") {
      await cancelSwarm({
        projectId: scope.projectId,
        swarmRunGroupId: scope.swarmRunGroupId,
      } as any);
      return;
    }
    await cancelWindow({
      chatboxId: scope.chatboxId,
      windowGroupId: scope.groupId,
    } as any);
  }, [scope, unavailable, cancelSwarm, cancelWindow]);

  // Reset per cohort. `unavailable` is re-assessed per cohort for
  // cohort-specific failures, but stays latched when the backend feature
  // itself is missing — otherwise navigating between cohorts re-fires a doomed
  // request each time.
  const runKey = !scope
    ? ""
    : scope.kind === "swarm"
      ? `swarm:${scope.projectId}:${scope.swarmRunGroupId}`
      : `chatbox:${scope.chatboxId}:${scope.groupId}`;
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

  // Auto-request once per cohort, on first view of a TERMINAL cohort that has
  // no row yet. A swarm run still running has nothing complete to analyze;
  // a window is terminal by construction (its snapshot is frozen).
  useEffect(() => {
    if (!autoRequest || !scope || unavailable) return;
    if (featureMissingRef.current) return;
    if (!terminal) return;
    if (dto === undefined) return; // still loading
    if (dto !== null) return; // already requested at some point
    if (hasAutoAttemptedRef.current) return;
    hasAutoAttemptedRef.current = true;
    request();
  }, [autoRequest, scope, unavailable, terminal, dto, request]);

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
    discovery:
      dto && "discovery" in dto ? ((dto.discovery ?? null) as
        | SwarmWaveDiscovery
        | null) : null,
    status,
    busy,
    unavailable,
    error: error ?? serverError,
    request,
    cancel,
  };
}
