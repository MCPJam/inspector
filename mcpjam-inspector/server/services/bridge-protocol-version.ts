import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/client";

/**
 * The protocol version a proxy answers `initialize` with: the one the client
 * asked for, when it is one the bridge speaks. MCPJam's own client negotiates
 * the upstream connection separately, and a 2025 client answered in the
 * upstream's 2026-07-28 does not recover: GitHub Copilot CLI 1.0.92 switches
 * to 2026 requests and never lists the server's tools.
 */
export function downstreamProtocolVersionOf(message: {
  method?: unknown;
  params?: unknown;
}): string | undefined {
  const requested = (message.params as { protocolVersion?: unknown } | undefined)
    ?.protocolVersion;
  return message.method === "initialize" &&
    typeof requested === "string" &&
    SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : undefined;
}
