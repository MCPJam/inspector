/**
 * The resource-metadata discovery failure that belongs to the server under
 * test, not to MCPJam.
 *
 * `discoverOAuthProtectedResourceMetadata` throws
 * {@link RESOURCE_METADATA_NOT_IMPLEMENTED} when the well-known document is
 * absent (a 404). RFC 9728 is how a resource names the
 * authorization servers allowed to issue tokens for it, and MCP has required
 * it from 2025-06-18 onward — so a server without one is nonconforming, and
 * saying so is the entire job of pointing a debugger at it.
 *
 * Constants rather than literals for the reason `required-metadata.ts` already
 * gives for its own: consumers match on the exact text, and a rephrasing on one
 * side would silently break the match. INSPECTOR-CLIENT-2F9 is what that costs
 * when the match does not exist at all — 18 events across 4 users, every one of
 * them a third party's missing metadata document filed as an MCPJam error.
 *
 * The message stays on screen either way. What this decides is only whether it
 * also becomes our alert.
 */

/** Thrown by protected-resource-metadata discovery when the document is absent. */
export const RESOURCE_METADATA_NOT_IMPLEMENTED =
  "Resource server does not implement OAuth 2.0 Protected Resource Metadata.";

/**
 * Thrown by protected-resource-metadata discovery when an attempt got no
 * response at all — it failed at the transport (network error, CORS
 * rejection). That includes a path-specific attempt that failed before the
 * root fallback returned 404: the 404 cannot speak for the path never reached.
 *
 * Kept apart from {@link RESOURCE_METADATA_NOT_IMPLEMENTED} on purpose: the
 * debugger's requests go through our own proxy, so "no response" is as likely
 * to be MCPJam's fetch path breaking as the server under test. Sharing the
 * sentinel would let that outage pass as a nonconforming server.
 */
export const RESOURCE_METADATA_NO_RESPONSE =
  "No response while loading OAuth protected resource metadata.";

const RESOURCE_METADATA_REQUEST_FAILURE_PREFIX =
  "Failed to request resource metadata";

/**
 * The flow-state message for a failed resource-metadata request.
 *
 * One helper rather than the same template in each era's machine, so the text
 * the machines produce and the text {@link isResourceMetadataNotImplemented}
 * recognises cannot drift apart.
 */
export function describeResourceMetadataRequestFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `${RESOURCE_METADATA_REQUEST_FAILURE_PREFIX}: ${reason}`;
}

/**
 * Whether a debugger step error is the server under test publishing no
 * protected-resource metadata.
 *
 * Deliberately narrow. The wrapped form covers every OTHER reason the request
 * can fail — an HTTP 500 from the resource, a network error, a malformed
 * document — and some of those can be MCPJam's own fault (our hosted fetch path
 * breaking would surface here too). Only the absent-document case is
 * unambiguously a property of the server being debugged, so only it is matched.
 */
export function isResourceMetadataNotImplemented(error: string): boolean {
  return (
    error === RESOURCE_METADATA_NOT_IMPLEMENTED ||
    error ===
      describeResourceMetadataRequestFailure(
        new Error(RESOURCE_METADATA_NOT_IMPLEMENTED),
      )
  );
}
