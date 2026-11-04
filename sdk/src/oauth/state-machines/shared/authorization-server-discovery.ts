/**
 * What authorization-server metadata discovery says when no well-known URL
 * produced a document.
 *
 * The machines try several RFC 8414 / OIDC well-known URLs in turn and record
 * every attempt, and the message reports all of them. The server under test is
 * debugged from this message, and "each URL answered 404" is exactly the
 * finding.
 */

import type { OAuthHttpResponse } from "../types.js";

/** One well-known URL tried, and what it produced. */
export type AuthorizationServerMetadataAttempt =
  | {
      url: string;
      status: number;
      /**
       * A 2xx whose body was not a JSON object (an HTML login page, a bare
       * string), with the type the server declared for it, if any.
       */
      notJson?: { contentType?: string };
      /** A 3xx's `Location`. Discovery does not follow redirects. */
      location?: string;
    }
  | { url: string; error: unknown };

/** What one well-known URL's answer is good for. */
export type AuthorizationServerMetadataOutcome =
  // `any`, like the response body it is: the machines read its fields.
  | { kind: "document"; document: OAuthHttpResponse["body"] }
  | { kind: "attempt"; attempt: AuthorizationServerMetadataAttempt };

const DISCOVERY_FAILURE_PREFIX =
  "Could not discover authorization server metadata.";

/**
 * The guards the machine's executor runs around each request (factory.ts):
 * the SSRF check before it and the redaction check after it. Their refusal is
 * the step's real failure, not one more URL that "failed", and the next URL
 * would only hit the same guard. Matched by name because the redaction error
 * lives in factory.ts, which imports the machines.
 */
const REQUEST_GUARD_ERROR_NAMES = new Set([
  "OAuthOutboundUrlBlockedError",
  "OAuthRedactedCredentialError",
]);

export function isOAuthRequestGuardError(error: unknown): boolean {
  return error instanceof Error && REQUEST_GUARD_ERROR_NAMES.has(error.name);
}

function headerValue(
  headers: Record<string, string> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function isEmptyBody(body: unknown): boolean {
  if (body === null || body === undefined) return true;
  if (typeof body === "string") return body.trim() === "";
  return (
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).length === 0
  );
}

/**
 * Sorts one well-known URL's answer into a metadata document, or an attempt to
 * record before trying the next URL. Only a non-empty JSON object is a
 * document: a 200 HTML page or an empty 2xx says nothing about this server's
 * metadata, and a later URL may still have it.
 */
export function classifyAuthorizationServerMetadataResponse(
  url: string,
  response: Pick<OAuthHttpResponse, "status" | "headers" | "body">
): AuthorizationServerMetadataOutcome {
  const { status, body } = response;
  if (status >= 200 && status < 300) {
    if (isEmptyBody(body)) {
      return { kind: "attempt", attempt: { url, status } };
    }
    if (typeof body === "object" && !Array.isArray(body)) {
      return { kind: "document", document: body };
    }
    const contentType = headerValue(response.headers, "content-type")
      ?.split(";")[0]
      ?.trim();
    return {
      kind: "attempt",
      attempt: { url, status, notJson: contentType ? { contentType } : {} },
    };
  }
  if (status >= 300 && status < 400) {
    const location = headerValue(response.headers, "location");
    if (location) {
      return { kind: "attempt", attempt: { url, status, location } };
    }
  }
  return { kind: "attempt", attempt: { url, status } };
}

function describeAttempt(attempt: AuthorizationServerMetadataAttempt): string {
  if ("error" in attempt) {
    const reason =
      attempt.error instanceof Error
        ? attempt.error.message
        : String(attempt.error);
    return `${attempt.url} failed: ${reason}`;
  }
  const answered = `${attempt.url} returned HTTP ${attempt.status}`;
  if (attempt.location) {
    return `${answered} redirecting to ${attempt.location}, which discovery does not follow`;
  }
  if (attempt.notJson) {
    const what = attempt.notJson.contentType ?? "a body";
    return `${answered} with ${what} that is not a JSON metadata document`;
  }
  // A 2xx lands here only when it carried no document to use.
  return attempt.status >= 200 && attempt.status < 300
    ? `${answered} with no metadata document`
    : answered;
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
