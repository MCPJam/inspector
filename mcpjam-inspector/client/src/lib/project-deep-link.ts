/**
 * Legacy `?project=<id>` deep links — READ ONLY.
 *
 * The project now lives in the path (`/p/<projectId>/...`, see
 * `project-route.ts`). This parameter is accepted so that links minted before
 * that migration — CLI run URLs, Slack messages, bookmarks — still open; it
 * is normalized away on arrival by `LegacyProjectRouteNormalizer` and is
 * never minted again by any first-party writer.
 *
 * What used to live here (the switch/organization/not-found decision table,
 * and a private copy of the project-id shape check) moved to
 * `project-route-state.ts` and `project-route.ts`: the same ordering now
 * resolves EVERY project route, not just the ones that arrived with a query
 * parameter, so keeping a second implementation for the legacy case would be
 * keeping a second answer to the same question.
 *
 * Delete this module once the normalizers are retired — one full release
 * after every first-party writer has stopped emitting the parameter.
 */
import { readLegacyProjectQuery } from "./project-route";

/**
 * Re-exported, not declared here.
 *
 * The parameter has TWO ends: the SDK's permalink builder writes it and this
 * module consumes it, so a literal in each place is one rename away from
 * silently minting links the app ignores. The dependency only runs one way —
 * app code imports the SDK, never the reverse — which is why the constant
 * lives in `@mcpjam/sdk/platform` and is re-exported here for the app's own
 * call sites. It names the same parameter `project-route.ts` reads off the
 * URL as `LEGACY_PROJECT_QUERY_PARAM`, which both modules' tests assert.
 */
import { PROJECT_DEEP_LINK_PARAM } from "@mcpjam/sdk/platform";

export { PROJECT_DEEP_LINK_PARAM };

/** The linked project id, or null when absent or malformed. */
export function readProjectDeepLinkParam(search: string): string | null {
  return readLegacyProjectQuery(search);
}

/**
 * True only for a USABLE param. A mangled or hand-typed value must not
 * suppress first-run onboarding while waiting for a project that will never
 * resolve.
 */
export function hasProjectDeepLinkParam(search: string): boolean {
  return readLegacyProjectQuery(search) !== null;
}
