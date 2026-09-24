/**
 * What authorization-server metadata discovery says when no well-known URL
 * produced a document.
 *
 * The machines try several RFC 8414 / OIDC well-known URLs in turn. They used
 * to remember only a "last error", which was set for a 5xx or a transport
 * failure but never for a 4xx — and a 4xx on every URL is the most common way
 * this fails. The user was then told `Last error: null`, which names neither
 * what was tried nor what came back (INSPECTOR-CLIENT-2EQ).
 *
 * So every attempt is recorded and all of them are reported: the server under
 * test is debugged from this message, and "each URL answered 404" is exactly
 * the finding.
 */

/** One well-known URL tried, and what it produced. */
export type AuthorizationServerMetadataAttempt =
  | { url: string; status: number }
  | { url: string; error: unknown };

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
  attempts: readonly AuthorizationServerMetadataAttempt[],
): string {
  if (attempts.length === 0) {
    return `${DISCOVERY_FAILURE_PREFIX} No well-known URL was tried.`;
  }
  return `${DISCOVERY_FAILURE_PREFIX} ${attempts.map(describeAttempt).join("; ")}.`;
}
