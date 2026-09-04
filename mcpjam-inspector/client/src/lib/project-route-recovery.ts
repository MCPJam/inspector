import type { ProjectRouteState } from "./project-route-state";
import {
  isProjectIdShape,
  readProjectPathSegment,
  replaceProjectInPath,
} from "./project-route";

export interface ProjectSignInReturnRecoveryIntent {
  path: string;
  requestedProjectId: string;
}

export type ProjectSignInReturnRecoveryDecision =
  | { kind: "none" }
  | { kind: "clear" }
  | { kind: "home" }
  | { kind: "switch"; path: string; message: string };

/** Arm recovery only for a path selected by the completed sign-in flow. */
export function createProjectSignInReturnRecoveryIntent(
  path: string,
): ProjectSignInReturnRecoveryIntent | null {
  const requestedProjectId = readProjectPathSegment(path);
  return requestedProjectId ? { path, requestedProjectId } : null;
}

/**
 * Decide whether a sign-in return is stale using the authoritative membership
 * response. Timeouts, malformed ids, direct links and ordinary navigation do
 * not recover to another project.
 */
export function resolveProjectSignInReturnRecovery(args: {
  intent: ProjectSignInReturnRecoveryIntent | null;
  routeState: ProjectRouteState;
  membershipProjectIds: ReadonlySet<string> | undefined;
  fallbackProject: { id: string; name: string } | null;
}): ProjectSignInReturnRecoveryDecision {
  const { intent, routeState, membershipProjectIds, fallbackProject } = args;
  if (!intent) return { kind: "none" };
  if (routeState.status === "unscoped") return { kind: "clear" };

  const routeProjectId =
    routeState.status === "ready"
      ? routeState.projectId
      : routeState.requestedProjectId;
  if (routeProjectId !== intent.requestedProjectId) return { kind: "clear" };
  if (routeState.status === "resolving") return { kind: "none" };
  if (routeState.status === "ready") return { kind: "clear" };

  const isConfirmedMissingMembership =
    isProjectIdShape(intent.requestedProjectId) &&
    membershipProjectIds !== undefined &&
    !membershipProjectIds.has(intent.requestedProjectId);
  if (!isConfirmedMissingMembership) return { kind: "clear" };
  if (!fallbackProject) return { kind: "home" };

  return {
    kind: "switch",
    path: replaceProjectInPath(intent.path, fallbackProject.id),
    message: `Project not found. Switched to ${fallbackProject.name}.`,
  };
}
