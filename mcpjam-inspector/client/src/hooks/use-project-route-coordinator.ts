import { useEffect, useMemo, useRef, useState } from "react";
import { useCurrentPathname } from "@/lib/app-navigation";
import { readProjectPathSegment } from "@/lib/project-route";
import {
  resolveProjectRouteState,
  type ProjectRouteState,
} from "@/lib/project-route-state";
import {
  trackProjectRouteInaccessible,
  trackProjectRouteRecovered,
  trackProjectRouteResolved,
  trackProjectRouteScopeMismatch,
} from "@/lib/project-route-telemetry";

/** How long a scoped URL may sit resolving before it reports as unavailable. */
const RESOLVE_BUDGET_MS = 15_000;

/**
 * Too many switch attempts for one requested id means something upstream is
 * rejecting the switch. Stop asking and report it rather than spinning.
 */
const MAX_SWITCH_ATTEMPTS = 3;

export interface ProjectRouteCoordinatorInput {
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  isLoadingRemoteProjects: boolean;
  /** Projects visible under the ACTIVE organization, keyed by id. */
  projects: Record<string, unknown>;
  /** ALL projects the viewer belongs to; undefined while loading. */
  allProjects:
    ReadonlyArray<{ _id: string; organizationId?: string }> | undefined;
  activeProjectId: string | null;
  activeOrganizationId: string | undefined;
  setActiveOrganizationId: (organizationId: string | undefined) => void;
  switchProject: (projectId: string) => Promise<void>;
  /** A confirmed stale sign-in return is recovered by App before it paints. */
  suppressInaccessibleTelemetryFor?: string | null;
}

/**
 * The URL decides which project this tab is on.
 *
 * Replaces the old `?project=` deep-link effect, which ran ONCE PER MOUNT.
 * That was enough while the project lived in a consumable query parameter and
 * wrong the moment it lives in the path: Back/Forward and an in-app A → B
 * navigation both change the requested project without remounting anything.
 * This reconciles continuously — every render, against the live pathname.
 *
 * Two races it closes explicitly:
 *   - a slow switch to A resolving after the user has already navigated to B
 *     (the result is dropped: only the LATEST requested id may win);
 *   - the same switch being fired over and over while it is in flight.
 *
 * It never navigates. A project that cannot be resolved leaves the URL alone
 * and reports `inaccessible`; the boundary renders one generic message. An
 * automatic bounce to a default project is exactly the "quietly showed you
 * someone else's data" behavior being removed.
 */
export function useProjectRouteCoordinator(
  input: ProjectRouteCoordinatorInput,
): ProjectRouteState {
  const {
    isAuthenticated,
    isAuthLoading,
    isLoadingRemoteProjects,
    projects,
    allProjects,
    activeProjectId,
    activeOrganizationId,
    setActiveOrganizationId,
    switchProject,
    suppressInaccessibleTelemetryFor,
  } = input;

  const pathname = useCurrentPathname();
  const requestedProjectId = readProjectPathSegment(pathname);

  const [budgetExceededFor, setBudgetExceededFor] = useState<string | null>(
    null,
  );
  /**
   * Bumped when a switch REJECTS, so the effect below runs again.
   *
   * Without it a transient failure — the current project's servers refusing to
   * disconnect, say — was terminal: the effect is keyed by what to do, that
   * key does not change when the attempt fails, and the route sat spinning
   * until the resolve budget expired and reported a perfectly accessible
   * project as unavailable. The attempt cap does the bounding instead.
   */
  const [switchRetry, setSwitchRetry] = useState(0);

  const activeOrgProjectIds = useMemo(
    () => new Set(Object.keys(projects)),
    [projects],
  );

  const { state, effect } = resolveProjectRouteState({
    requestedProjectId,
    isAuthLoading,
    isAuthenticated,
    isLoadingRemoteProjects,
    activeProjectId,
    activeOrgProjectIds,
    allProjects,
    activeOrganizationId,
    hasExceededResolveBudget:
      requestedProjectId !== null && budgetExceededFor === requestedProjectId,
  });

  // The latest requested id, readable from async callbacks. A switch that
  // resolves after the user moved on must not write state for the page they
  // left.
  const latestRequestedRef = useRef<string | null>(requestedProjectId);
  latestRequestedRef.current = requestedProjectId;

  const switchInFlightRef = useRef<string | null>(null);
  const switchAttemptsRef = useRef<{ projectId: string; count: number } | null>(
    null,
  );
  const requestedAtRef = useRef<{ projectId: string; at: number } | null>(null);
  const reportedRef = useRef<{
    projectId: string;
    outcome: "ready" | "inaccessible";
  } | null>(null);

  // Reset the per-request bookkeeping whenever the URL asks for a different
  // project — including a return to an unscoped route.
  useEffect(() => {
    switchAttemptsRef.current = null;
    reportedRef.current = null;
    setBudgetExceededFor(null);
    setSwitchRetry(0);
    requestedAtRef.current = requestedProjectId
      ? { projectId: requestedProjectId, at: Date.now() }
      : null;
  }, [requestedProjectId]);

  // Bounded resolution: a spinner with no deadline is indistinguishable from
  // a hang, and something upstream really can stall.
  const resolvingProjectId =
    state.status === "resolving" ? state.requestedProjectId : null;
  useEffect(() => {
    if (!resolvingProjectId) return;
    const timer = window.setTimeout(() => {
      if (latestRequestedRef.current !== resolvingProjectId) return;
      setBudgetExceededFor(resolvingProjectId);
    }, RESOLVE_BUDGET_MS);
    return () => window.clearTimeout(timer);
  }, [resolvingProjectId]);

  // Perform whatever the pure resolver said comes next.
  //
  // Keyed by WHAT to do, not by the resolver's return value: that object is
  // rebuilt every render, and an effect that re-fired on identity alone would
  // burn through the attempt budget in three renders without a single thing
  // having changed.
  const effectKey =
    effect.kind === "none"
      ? "none"
      : effect.kind === "switch-organization"
        ? `org:${effect.organizationId}`
        : `project:${effect.projectId}:${switchRetry}`;
  // The effect body reads everything through refs and depends ONLY on the
  // key. `switchProject` in particular is a `useCallback` over the live server
  // map, so its identity changes constantly — as a dependency it would re-run
  // this effect (and burn the attempt budget) while nothing about the route
  // had changed at all.
  const effectRef = useRef(effect);
  effectRef.current = effect;
  const switchProjectRef = useRef(switchProject);
  switchProjectRef.current = switchProject;
  const setActiveOrganizationIdRef = useRef(setActiveOrganizationId);
  setActiveOrganizationIdRef.current = setActiveOrganizationId;
  useEffect(() => {
    const effect = effectRef.current;
    if (effect.kind === "none") return;
    if (effect.kind === "switch-organization") {
      // The organization-filtered project list re-derives; a later pass lands
      // on switch-project.
      setActiveOrganizationIdRef.current(effect.organizationId);
      return;
    }

    const { projectId } = effect;
    if (switchInFlightRef.current === projectId) return;

    const attempts = switchAttemptsRef.current;
    const nextCount =
      attempts && attempts.projectId === projectId ? attempts.count + 1 : 1;
    switchAttemptsRef.current = { projectId, count: nextCount };
    if (nextCount > MAX_SWITCH_ATTEMPTS) {
      if (nextCount === MAX_SWITCH_ATTEMPTS + 1) {
        trackProjectRouteScopeMismatch("repeated-switch");
      }
      setBudgetExceededFor(projectId);
      return;
    }

    switchInFlightRef.current = projectId;
    void switchProjectRef
      .current(projectId)
      .catch(() => {
        // Retry rather than swallow: a switch can fail for a transient reason,
        // and the effect key alone would never change to run it again. The
        // attempt cap above turns a persistent failure into the inaccessible
        // state instead of an endless spin. No toast — the boundary already
        // shows the outcome, and a second copy of it helps nobody.
        if (latestRequestedRef.current !== projectId) return;
        setSwitchRetry((attempt) => attempt + 1);
      })
      .finally(() => {
        if (switchInFlightRef.current === projectId) {
          switchInFlightRef.current = null;
        }
      });
  }, [effectKey]);

  // Telemetry: once per requested project, never carrying the id itself.
  useEffect(() => {
    if (state.status === "ready") {
      const reported = reportedRef.current;
      if (
        reported?.projectId === state.projectId &&
        reported.outcome === "ready"
      ) {
        return;
      }
      reportedRef.current = { projectId: state.projectId, outcome: "ready" };
      if (
        reported?.projectId === state.projectId &&
        reported.outcome === "inaccessible"
      ) {
        trackProjectRouteRecovered();
        return;
      }
      const started = requestedAtRef.current;
      trackProjectRouteResolved(
        started && started.projectId === state.projectId
          ? Date.now() - started.at
          : 0,
      );
      return;
    }
    if (state.status === "inaccessible") {
      if (
        state.reason === "not-a-member" &&
        suppressInaccessibleTelemetryFor === state.requestedProjectId
      ) {
        return;
      }
      if (
        reportedRef.current?.projectId === state.requestedProjectId &&
        reportedRef.current.outcome === "inaccessible"
      ) {
        return;
      }
      reportedRef.current = {
        projectId: state.requestedProjectId,
        outcome: "inaccessible",
      };
      trackProjectRouteInaccessible(state.reason);
    }
  }, [state, suppressInaccessibleTelemetryFor]);

  return state;
}
