/**
 * `?project=<id>` deep-link support.
 *
 * Eval/suite/run URLs carry no project segment, so a shared link renders
 * whatever project the viewer's picker happens to be on — an empty state for
 * anyone parked elsewhere. Surfaces that mass-produce links (the Slack bot,
 * CLI run URLs) append `?project=<id>`; on load the app switches the active
 * project (and organization, when the link crosses orgs) to match, then
 * strips the param from the URL.
 */

/**
 * Re-exported, not declared here.
 *
 * The parameter has TWO ends: the SDK's permalink builder writes it and this
 * module consumes it, so a literal in each place is one rename away from
 * silently minting links the app ignores. The dependency only runs one way —
 * app code imports the SDK, never the reverse — which is why the constant
 * lives in `@mcpjam/sdk/platform` and is re-exported here for the app's own
 * call sites.
 */
import { PROJECT_DEEP_LINK_PARAM } from "@mcpjam/sdk/platform";

export { PROJECT_DEEP_LINK_PARAM };

// Convex ids are lowercase alphanumeric. The shape check keeps mangled or
// hand-typed params from suppressing first-run onboarding or firing switches.
const PROJECT_ID_SHAPE = /^[a-z0-9]{16,64}$/;

export function readProjectDeepLinkParam(search: string): string | null {
  const params = new URLSearchParams(
    search.startsWith("?") ? search : `?${search}`
  );
  const raw = params.get(PROJECT_DEEP_LINK_PARAM);
  return raw && PROJECT_ID_SHAPE.test(raw) ? raw : null;
}

export function hasProjectDeepLinkParam(search: string): boolean {
  return readProjectDeepLinkParam(search) !== null;
}

/** Strip the param in place, preserving path, other params, and hash. */
export function clearProjectDeepLinkFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(PROJECT_DEEP_LINK_PARAM)) return;
  url.searchParams.delete(PROJECT_DEEP_LINK_PARAM);
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}

export type ProjectDeepLinkAction =
  | { kind: "wait" }
  | { kind: "clear" }
  | { kind: "switch-project" }
  | { kind: "switch-organization"; organizationId: string }
  | { kind: "not-found" };

/**
 * Decide what the deep-link handler should do this render. Pure so the
 * ordering rules are unit-testable without mounting App:
 *  - already on the project → just clear the param;
 *  - project visible under the active org → switch to it;
 *  - project belongs to another org the user is in → switch orgs first
 *    (the filtered project list re-derives and a later render switches);
 *  - membership list still loading → wait;
 *  - otherwise → not a project this user can see.
 */
export function resolveProjectDeepLinkAction(args: {
  requestedProjectId: string;
  activeProjectId: string | null;
  /** Ids of projects visible under the ACTIVE organization. */
  activeOrgProjectIds: ReadonlySet<string>;
  /** ALL projects the user belongs to (unfiltered); undefined while loading. */
  allProjects:
    | ReadonlyArray<{ _id: string; organizationId?: string }>
    | undefined;
  activeOrganizationId: string | undefined;
}): ProjectDeepLinkAction {
  const {
    requestedProjectId,
    activeProjectId,
    activeOrgProjectIds,
    allProjects,
    activeOrganizationId,
  } = args;

  if (activeProjectId === requestedProjectId) return { kind: "clear" };
  if (activeOrgProjectIds.has(requestedProjectId)) {
    return { kind: "switch-project" };
  }
  if (allProjects === undefined) return { kind: "wait" };

  const match = allProjects.find((p) => p._id === requestedProjectId);
  if (!match) return { kind: "not-found" };
  if (!match.organizationId) {
    // An org-less project can never enter an org-filtered project set, so
    // waiting would hang forever and the param would never strip. With no
    // org filter active the unfiltered set includes it next render — wait.
    return activeOrganizationId ? { kind: "not-found" } : { kind: "wait" };
  }
  if (match.organizationId !== activeOrganizationId) {
    return { kind: "switch-organization", organizationId: match.organizationId };
  }
  // Right org but the filtered set hasn't caught up yet — transient.
  return { kind: "wait" };
}
