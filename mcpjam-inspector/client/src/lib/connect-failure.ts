import { describeError, type NormalizedError } from "@mcpjam/sdk/browser";

/**
 * The catalog entry for a failed connect, never the bare catch-all.
 *
 * A server-built block is the better account of the failure, so it wins when
 * it names a cause. When it does not, or when only text reached the client,
 * the connect phase files it under `connect/unclassified`, so the card and
 * `server_connect_outcome` both say which operation failed.
 */
export function describeConnectFailure(
  error: string | undefined,
  normalized?: NormalizedError,
): NormalizedError {
  if (normalized && normalized.slug !== "internal/unknown") return normalized;
  const described = describeError(normalized?.rawMessage || error || "", {
    phase: "connect",
  });
  // Keep the server block's requestId, stack and cause; only the slug and
  // the catalog copy change.
  return normalized ? { ...normalized, ...described } : described;
}

/**
 * The one fix a failed first connect offers as its primary button.
 *
 * Lives in the client, not the catalog: the button is a property of the
 * onboarding screen (it can start OAuth or focus a field there), and the same
 * slug elsewhere may have no such control to drive.
 */
export type ConnectFailureActionKind = "start_oauth" | "edit_input" | "reconnect";

/**
 * Failures a fresh OAuth sign-in fixes. Listed one by one: other auth slugs
 * (the MCPJam session, a proxy, an unreachable authorization server or
 * discovery endpoint, a redirect mismatch) fail the same way again. A 401
 * without a Bearer challenge is also left out: its catalog steps point to
 * discovery or an API key header, which a sign-in does not fix.
 */
export const START_OAUTH_SLUGS: readonly string[] = [
  "auth/http_401",
  "auth/http_403",
  "auth/insufficient_scope",
  "auth/oauth_refresh_failed",
  "auth/consent_required",
  "oauth/invalid_grant",
  "oauth/invalid_client",
  "oauth/non_compliant_challenge",
];

/** Failures that mean the URL or command itself is wrong. */
export const EDIT_INPUT_SLUGS: readonly string[] = [
  "transport/enotfound",
  "transport/econnrefused",
  "transport/tls_untrusted",
  "server/http_error",
  "transport/spawn_failed",
  "sdk/stateless_requires_http",
];

export function connectFailureActionKind(
  slug: string,
  transport: "http" | "stdio",
): ConnectFailureActionKind {
  // OAuth only exists for HTTP servers; a stdio server has nothing to sign in to.
  if (transport === "http" && START_OAUTH_SLUGS.includes(slug)) {
    return "start_oauth";
  }
  if (EDIT_INPUT_SLUGS.includes(slug)) return "edit_input";
  return "reconnect";
}

export function connectFailureActionLabel(
  kind: ConnectFailureActionKind,
  transport: "http" | "stdio",
): string {
  if (kind === "start_oauth") return "Start OAuth";
  if (kind === "edit_input") {
    return transport === "stdio" ? "Edit command" : "Edit URL";
  }
  return "Reconnect";
}
