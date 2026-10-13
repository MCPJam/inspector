import {
  buildProjectPath,
  isProjectIdShape,
  readProjectPathSegment,
  replaceProjectInPath,
} from "./project-route";

export interface ProjectSignInReturnRecoveryIntent {
  path: string;
  requestedProjectId: string;
  fallback?: "preserve" | "home" | "none";
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
  if (intent.fallback === "none") return { kind: "open", path: intent.path };
  if (membershipProjectIds === undefined) return { kind: "wait" };
  if (membershipProjectIds.has(intent.requestedProjectId)) {
    return { kind: "open", path: intent.path };
  }
  const selectedProjectId =
    intent.fallback === "home" &&
    (!fallbackProjectId || !membershipProjectIds.has(fallbackProjectId))
      ? ([...membershipProjectIds].find(isProjectIdShape) ?? null)
      : fallbackProjectId;
  if (
    selectedProjectId &&
    isProjectIdShape(selectedProjectId) &&
    membershipProjectIds.has(selectedProjectId)
  ) {
    return {
      kind: "switch",
      path:
        intent.fallback === "home"
          ? buildProjectPath(selectedProjectId, "/home")
          : replaceProjectInPath(intent.path, selectedProjectId),
    };
  }
  return { kind: "home" };
}
