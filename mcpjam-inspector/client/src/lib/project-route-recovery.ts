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
  | { kind: "wait" }
  | { kind: "open"; path: string }
  | { kind: "home" }
  | { kind: "switch"; path: string };

/** Arm recovery only for a project-scoped path selected by sign-in. */
export function createProjectSignInReturnRecoveryIntent(
  path: string,
): ProjectSignInReturnRecoveryIntent | null {
  const requestedProjectId = readProjectPathSegment(path);
  return requestedProjectId ? { path, requestedProjectId } : null;
}

/**
 * Resolve a project-scoped sign-in return before it is allowed to navigate.
 * Only the first authoritative membership response may declare the saved
 * project stale; malformed paths still open normally so the route boundary
 * can report them instead of silently changing their meaning.
 */
export function resolveProjectSignInReturnRecovery(args: {
  intent: ProjectSignInReturnRecoveryIntent | null;
  membershipProjectIds: ReadonlySet<string> | undefined;
  fallbackProjectId: string | null;
}): ProjectSignInReturnRecoveryDecision {
  const { intent, membershipProjectIds, fallbackProjectId } = args;
  if (!intent) return { kind: "none" };
  if (!isProjectIdShape(intent.requestedProjectId)) {
    return { kind: "open", path: intent.path };
  }
  if (membershipProjectIds === undefined) return { kind: "wait" };
  if (membershipProjectIds.has(intent.requestedProjectId)) {
    return { kind: "open", path: intent.path };
  }
  if (
    fallbackProjectId &&
    isProjectIdShape(fallbackProjectId) &&
    membershipProjectIds.has(fallbackProjectId)
  ) {
    return {
      kind: "switch",
      path: replaceProjectInPath(intent.path, fallbackProjectId),
    };
  }
  return { kind: "home" };
}
