/**
 * Lane A insights for one analyzed cohort: subscribe, auto-request on first
 * view, regenerate, cancel.
 *
 * TWO SURFACES, ONE LIFECYCLE. A swarm wave is keyed on
 * `(projectId, swarmRunGroupId)`; a User Testing window is keyed on
 * `(scenarioId, windowGroupId)`. Everything else — the optimistic `requested`
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
  SCENARIO_INSIGHTS_MUTATIONS,
  SCENARIO_INSIGHTS_QUERIES,
  type ScenarioWindowInsights,
  type ScenarioWindowInsightsDto,
} from "@/lib/scenario-insights-api";

/**
 * Which cohort's narration to read. The group id is REQUIRED on both arms: it
 * names frozen data, and a hook that guessed one could render a narration of a
 * different set of sessions than the caller is showing signals for.
 */
export type RunInsightsScope =
  | { kind: "swarm"; projectId: string; swarmRunGroupId: string }
  | { kind: "scenario"; scenarioId: string; groupId: string };

/** The narrated payload, in the shape both surfaces share. */
export type RunInsightsPayload = SwarmWaveInsights | ScenarioWindowInsights;

export type UseRunInsightsResult = {
  /** Undefined while loading; null when never requested for this cohort. */
  dto: SwarmWaveInsightsDto | ScenarioWindowInsightsDto | null | undefined;
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
  /** The caller may not generate. Suppresses AUTO-requests, nothing else. */
  authRefused?: boolean;
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
  // session; what is deployed cannot.
  //
  // It still has to stop the AUTO-request, and `canRequest` alone does not:
  // `usePromoteCapability` answers `true` for an anonymous hosted visitor, so
  // a guest browsing scenarios would fire one doomed mutation per cohort and
  // be told to ask a member each time. `authRefused` is the narrower latch —
  // it suppresses auto-requests only, and an explicit press clears it, so a
  // user who signs in mid-session gets a working button rather than a dead
  // surface.
  if (
    raw.includes("Insufficient workspace permissions") ||
    raw.includes("Not a member of this workspace")
  ) {
    return {
      unavailable: false,
      permanent: false,
      authRefused: true,
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
    raw.includes("scenario_not_found") ||
    raw.includes("Server Error");
  return { unavailable, permanent, message: raw };
}

/** Identity of the cohort being read — the key per-cohort state resets on. */
function cohortKeyOf(scope: RunInsightsScope | null): string {
  if (!scope) return "";
  return scope.kind === "swarm"
    ? `swarm:${scope.projectId}:${scope.swarmRunGroupId}`
    : `scenario:${scope.scenarioId}:${scope.groupId}`;
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
  /** Sticky across cohorts: who is asking does not change by navigating. */
  const authRefusedRef = useRef(false);
  const hasAutoAttemptedRef = useRef(false);
  /** Previous cohort, for the reset effect — NOT the current one. */
  const runKeyRef = useRef<string | null>(null);
  /**
   * The cohort on screen, updated DURING RENDER. `runKeyRef` is written by an
   * effect, so between a cohort change and that effect there is a window where
   * it still names the cohort the user just left — long enough for a rejection
   * to land and be mistaken for current.
   */
  const activeRunKeyRef = useRef<string>(cohortKeyOf(scope));
  activeRunKeyRef.current = cohortKeyOf(scope);
  /** Monotonic per request, so an older attempt cannot answer for a newer one. */
  const attemptRef = useRef(0);
  /**
   * Bumped by every explicit press. A press is the only event that can mean
   * "the viewer may not be who was refused" — navigating between cohorts, and
   * the auto-request that follows it, say nothing about identity.
   */
  const identityAssertionsRef = useRef(0);

  const isSwarm = scope?.kind === "swarm";
  const queryName = isSwarm
    ? SWARM_QUERIES.getWaveInsights
    : SCENARIO_INSIGHTS_QUERIES.getWindowInsights;
  const queryArgs = !scope
    ? "skip"
    : scope.kind === "swarm"
      ? { projectId: scope.projectId, swarmRunGroupId: scope.swarmRunGroupId }
      : { scenarioId: scope.scenarioId, windowGroupId: scope.groupId };

  const dto = useQuery(queryName as any, queryArgs as any) as
    | SwarmWaveInsightsDto
    | ScenarioWindowInsightsDto
    | null
    | undefined;

  const requestSwarm = useMutation(SWARM_MUTATIONS.requestWaveInsights as any);
  const cancelSwarm = useMutation(SWARM_MUTATIONS.cancelWaveInsights as any);
  const requestWindow = useMutation(
    SCENARIO_INSIGHTS_MUTATIONS.requestWindowInsights as any,
  );
  const cancelWindow = useMutation(
    SCENARIO_INSIGHTS_MUTATIONS.cancelWindowInsights as any,
  );

  /** Shared body. `auto` distinguishes the first-view attempt from a press. */
  const fire = useCallback(
    (force: boolean | undefined, auto: boolean) => {
      if (!scope || unavailable) return;
      // A press is a fresh assertion by the user: the identity that was
      // refused may not be the identity pressing now (they may have signed in
      // since). An auto-request carries no such assertion, so it stays latched.
      if (!auto) {
        authRefusedRef.current = false;
        identityAssertionsRef.current += 1;
      }
      const firedFor = cohortKeyOf(scope);
      const attempt = ++attemptRef.current;
      const assertedAt = identityAssertionsRef.current;
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
          : requestWindow({ scenarioId: scope.scenarioId, force } as any);
      promise.catch((err: unknown) => {
        const classified = classifyRunInsightError(err);
        // Superseded: a newer attempt is in flight, or the user has moved to
        // another cohort. Either way this answer is about something that is no
        // longer on screen.
        const stale =
          attemptRef.current !== attempt ||
          activeRunKeyRef.current !== firedFor;

        // "This deployment does not have the function" is true whenever it is
        // learned, from whichever cohort learned it — the one fact here that
        // outlives its request.
        if (classified.permanent) featureMissingRef.current = true;
        // The permission latch turns on WHO IS ASKING, so `stale` is the wrong
        // test for it in both directions. A refusal that lands after the user
        // moved to another cohort still holds — otherwise a guest browsing
        // scenarios out-runs it and fires a doomed request on every one — and
        // a refusal superseded by an explicit PRESS does not, because the press
        // is the one event that can mean the viewer signed in since.
        if (
          classified.authRefused &&
          identityAssertionsRef.current === assertedAt
        ) {
          authRefusedRef.current = true;
        }
        if (stale) return;

        setRequested(false);
        if (classified.unavailable) {
          setUnavailable(true);
        } else {
          setError(classified.message);
        }
      });
    },
    [scope, unavailable, requestSwarm, requestWindow],
  );

  const request = useCallback((force?: boolean) => fire(force, false), [fire]);

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
      scenarioId: scope.scenarioId,
      windowGroupId: scope.groupId,
    } as any);
  }, [scope, unavailable, cancelSwarm, cancelWindow]);

  // Reset per cohort. `unavailable` is re-assessed per cohort for
  // cohort-specific failures, but stays latched when the backend feature
  // itself is missing — otherwise navigating between cohorts re-fires a doomed
  // request each time.
  const runKey = cohortKeyOf(scope);
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
    // Already told this viewer they may not generate — asking again on every
    // cohort they open just re-shows the refusal.
    if (authRefusedRef.current) return;
    if (!terminal) return;
    if (dto === undefined) return; // still loading
    if (dto !== null) return; // already requested at some point
    if (hasAutoAttemptedRef.current) return;
    hasAutoAttemptedRef.current = true;
    fire(undefined, true);
  }, [autoRequest, scope, unavailable, terminal, dto, fire]);

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
