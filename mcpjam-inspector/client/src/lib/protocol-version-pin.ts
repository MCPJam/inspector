import type { NormalizedError } from "@mcpjam/sdk/browser";

/**
 * Catalog slug for "this connection pins an MCP protocol version the server
 * does not offer" — the SDK's `ProtocolVersionPinUnsupported`.
 *
 * Named here rather than inlined at each surface because two of them key off
 * it, and a typo'd slug fails silently: the affordance simply never appears,
 * with nothing to notice in review.
 */
export const PROTOCOL_VERSION_PIN_SLUG = "sdk/protocol_version_pin_unsupported";

/**
 * Is this failure a version pin the user can fix in one dropdown?
 *
 * Reads the normalized block rather than the raw message, which the connection
 * surfaces always have: `CONNECT_FAILURE` either carries the block the backend
 * attached, or the reducer derives one with `describeError` from the message —
 * and the describer resolves this slug from the clause the SDK authors. So the
 * gate holds on both paths, and chat's own message-matching (which has no
 * normalized block to read, the AI SDK having collapsed the response into a
 * string) stays the exception rather than the rule.
 */
export function isProtocolVersionPinFailure(
  normalized: NormalizedError | undefined,
  message?: string,
): boolean {
  if (normalized?.slug === PROTOCOL_VERSION_PIN_SLUG) return true;
  // Fall back to the sentence itself. The slug is the better signal, but it is
  // only as good as the describer that produced it — a bundled copy of the SDK
  // one version behind (a dev client holding a pre-bundled dep, a deployed
  // client ahead of its server) resolves this failure to a generic transport
  // slug and the affordance silently disappears. The clause is authored by
  // MCPJam and cannot be echoed by a server, so matching it costs nothing and
  // keeps the button working across that skew.
  return typeof message === "string" && PROTOCOL_VERSION_PIN_MARKER.test(message);
}

/** The clause `ProtocolVersionPinUnsupported` authors into its own message. */
const PROTOCOL_VERSION_PIN_MARKER = /which this client is pinned to/i;
