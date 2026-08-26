/**
 * Deciding what a project-scoped URL means, as pure data.
 *
 * `/p/<id>/servers` says which project this tab is looking at. Getting from
 * that string to "the app is showing project <id>" takes an ordered walk —
 * wait for auth, switch organization if the project lives in another one,
 * wait for the organization-filtered project list to catch up, switch the
 * active project — and every step of it used to live inside an effect in
 * App.tsx where it could only be tested by mounting the whole app.
 *
 * The rules that matter, and why:
 *
 *   - a project the viewer cannot see NEVER falls back to another project.
 *     Rendering project A's servers under project B's URL is worse than an
 *     error: the user acts on data they did not ask for.
 *   - "deleted", "never existed", and "not yours" are ONE state. Telling
 *     these apart from outside the membership would leak which project ids
 *     are real.
 *   - resolution is continuous, not once-per-mount. Back/Forward and an
 *     in-app A → B navigation both change the requested id without
 *     remounting anything.
 */
import { isProjectIdShape } from "./project-route";

export type ProjectRouteState =
  | { status: "unscoped" }
  | { status: "resolving"; requestedProjectId: string }
  | { status: "ready"; projectId: string }
  | { status: "inaccessible"; requestedProjectId: string };

/**
 * What the caller must DO to move resolution forward. Separate from the
 * state so the decision stays pure: the hook performs the effect, this
 * module only says which one is next.
 */
export type ProjectRouteEffect =
  | { kind: "none" }
  | { kind: "switch-organization"; organizationId: string }
  | { kind: "switch-project"; projectId: string };

export interface ProjectRouteResolution {
  state: ProjectRouteState;
  effect: ProjectRouteEffect;
}

export interface ProjectRouteResolutionInput {
  /** The project id in the pathname, or null when the route is unscoped. */
  requestedProjectId: string | null;
  isAuthLoading: boolean;
  isAuthenticated: boolean;
  isLoadingRemoteProjects: boolean;
  activeProjectId: string | null;
  /** Ids of projects visible under the ACTIVE organization. */
  activeOrgProjectIds: ReadonlySet<string>;
  /** ALL projects the viewer belongs to; undefined while still loading. */
  allProjects:
    | ReadonlyArray<{ _id: string; organizationId?: string }>
    | undefined;
  activeOrganizationId: string | undefined;
  /**
   * The resolving state is bounded: something upstream can stall (a query
   * that never settles, an organization switch that does not take), and an
   * unbounded spinner is indistinguishable from a hang. Once the budget is
   * spent the route reports the same generic inaccessible state.
   */
  hasExceededResolveBudget?: boolean;
}

export function resolveProjectRouteState(
  input: ProjectRouteResolutionInput
): ProjectRouteResolution {
  const {
    requestedProjectId,
    isAuthLoading,
    isAuthenticated,
    isLoadingRemoteProjects,
    activeProjectId,
    activeOrgProjectIds,
    allProjects,
    activeOrganizationId,
    hasExceededResolveBudget = false,
  } = input;

  if (requestedProjectId === null) {
    return { state: { status: "unscoped" }, effect: { kind: "none" } };
  }

  const resolving: ProjectRouteResolution = {
    state: { status: "resolving", requestedProjectId },
    effect: { kind: "none" },
  };
  const inaccessible: ProjectRouteResolution = {
    state: { status: "inaccessible", requestedProjectId },
    effect: { kind: "none" },
  };

  // A malformed id can never become accessible, so it does not wait for auth:
  // `/p/none/servers` and `/p/<typo>/servers` are answered immediately.
  if (!isProjectIdShape(requestedProjectId)) return inaccessible;

  // The URL already matches the app's state. Checked before any loading gate
  // so a refresh on the project you are already in renders without a spinner.
  if (activeProjectId === requestedProjectId) {
    return {
      state: { status: "ready", projectId: requestedProjectId },
      effect: { kind: "none" },
    };
  }

  if (hasExceededResolveBudget) return inaccessible;

  // 1. Auth first: membership is the only thing that can answer this URL, and
  //    it does not exist yet.
  if (isAuthLoading) return resolving;
  if (!isAuthenticated) return resolving;
  if (isLoadingRemoteProjects) return resolving;

  // 2. Visible under the active organization — switch straight to it.
  if (activeOrgProjectIds.has(requestedProjectId)) {
    return {
      state: { status: "resolving", requestedProjectId },
      effect: { kind: "switch-project", projectId: requestedProjectId },
    };
  }

  // 3. Not in this organization's list. The unfiltered membership decides
  //    whether that means "another organization" or "not yours".
  if (allProjects === undefined) return resolving;

  const match = allProjects.find(
    (project) => project._id === requestedProjectId
  );
  if (!match) return inaccessible;

  if (!match.organizationId) {
    // An organization-less project can never enter an organization-filtered
    // set, so waiting for one would hang forever. With no organization filter
    // active it lands in the unfiltered set on a later pass.
    return activeOrganizationId ? inaccessible : resolving;
  }

  if (match.organizationId !== activeOrganizationId) {
    return {
      state: { status: "resolving", requestedProjectId },
      effect: {
        kind: "switch-organization",
        organizationId: match.organizationId,
      },
    };
  }

  // 4. Right organization, filtered list has not caught up yet. Transient.
  return resolving;
}
