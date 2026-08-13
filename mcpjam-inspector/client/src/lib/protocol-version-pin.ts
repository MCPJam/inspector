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
): boolean {
  return normalized?.slug === PROTOCOL_VERSION_PIN_SLUG;
}
