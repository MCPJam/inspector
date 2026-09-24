/**
 * What authorization-server metadata discovery says when no well-known URL
 * produced a document.
 *
 * The machines try several RFC 8414 / OIDC well-known URLs in turn and record
 * every attempt, and the message reports all of them. The server under test is
 * debugged from this message, and "each URL answered 404" is exactly the
 * finding.
 */

/** One well-known URL tried, and what it produced. */
export type AuthorizationServerMetadataAttempt =
  { url: string; status: number } | { url: string; error: unknown };

const DISCOVERY_FAILURE_PREFIX =
  "Could not discover authorization server metadata.";

function describeAttempt(attempt: AuthorizationServerMetadataAttempt): string {
  if ("error" in attempt) {
    const reason =
      attempt.error instanceof Error
        ? attempt.error.message
        : String(attempt.error);
    return `${attempt.url} failed: ${reason}`;
  }
  // A 2xx lands here only when it carried no document to use.
  return attempt.status >= 200 && attempt.status < 300
    ? `${attempt.url} returned HTTP ${attempt.status} with no metadata document`
    : `${attempt.url} returned HTTP ${attempt.status}`;
}

export function describeAuthorizationServerDiscoveryFailure(
  attempts: readonly AuthorizationServerMetadataAttempt[]
): string {
  if (attempts.length === 0) {
    return `${DISCOVERY_FAILURE_PREFIX} No well-known URL was tried.`;
  }
  return `${DISCOVERY_FAILURE_PREFIX} ${attempts
    .map(describeAttempt)
    .join("; ")}.`;
}
