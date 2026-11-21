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
  return describeError(normalized?.rawMessage || error || "", {
    phase: "connect",
  });
}

/**
 * The one fix a failed first connect offers as its primary button.
 *
 * Lives in the client, not the catalog: the button is a property of the
 * onboarding screen (it can start OAuth or focus a field there), and the same
 * slug elsewhere may have no such control to drive.
 */
export type ConnectFailureActionKind = "start_oauth" | "edit_input" | "reconnect";

/** Slug families a fresh OAuth sign-in addresses. */
export const START_OAUTH_PREFIXES: readonly string[] = ["auth/", "oauth/"];

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
  if (
    transport === "http" &&
    START_OAUTH_PREFIXES.some((prefix) => slug.startsWith(prefix))
  ) {
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
