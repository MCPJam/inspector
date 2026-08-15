/**
 * Catalog slug for "this connection pins an MCP protocol version the server
 * does not offer" — the SDK's `ProtocolVersionPinUnsupported`, resolved by
 * `describeError`.
 *
 * Lives in `shared/` because both sides of the wire key off it and they must
 * agree: the web route maps it to a 4xx so the response survives the edge, and
 * the client surfaces the "Change protocol version" affordance for it. A typo
 * on either side fails silently — the status quietly reverts to the 500
 * catch-all, or the affordance simply never appears — so there is one spelling
 * and both import it.
 */
export const PROTOCOL_VERSION_PIN_SLUG = "sdk/protocol_version_pin_unsupported";
