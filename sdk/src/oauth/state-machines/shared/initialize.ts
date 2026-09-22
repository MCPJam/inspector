import type { OAuthAuthMode, OAuthProtocolVersion } from "../types.js";

export const MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION =
  "io.modelcontextprotocol/oauth-client-credentials";

// 2026-07-28 stateless `_meta` envelope keys. Every stateless request
// self-describes with these instead of a prior `initialize` handshake.
export const MCP_PROTOCOL_VERSION_META_KEY =
  "io.modelcontextprotocol/protocolVersion";
export const MCP_CLIENT_CAPABILITIES_META_KEY =
  "io.modelcontextprotocol/clientCapabilities";
export const MCP_CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";

export function resolveInitializeProtocolVersion(
  protocolVersion: OAuthProtocolVersion,
): string {
  switch (protocolVersion) {
    case "2025-11-25":
      return "2025-11-25";
    case "2026-07-28":
      // The 2026-07-28 wire is stateless — no `initialize` handshake. The OAuth
      // machine's probe/verify steps now issue a stateless `tools/list` via
      // buildStatelessVerifyRequestBody; this value is only the
      // `MCP-Protocol-Version` header literal for that request.
      return "2026-07-28";
    case "2025-06-18":
    case "2025-03-26":
      return "2024-11-05";
    default:
      return protocolVersion;
  }
}

export function buildInitializeCapabilities(
  authMode?: OAuthAuthMode,
): Record<string, unknown> {
  if (authMode !== "client_credentials") {
    return {};
  }

  return {
    extensions: {
      [MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION]: {},
    },
  };
}

export function buildInitializeRequestBody(input: {
  protocolVersion: string;
  authMode?: OAuthAuthMode;
  clientName: string;
  clientVersion: string;
  id: number;
}): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: input.protocolVersion,
      capabilities: buildInitializeCapabilities(input.authMode),
      clientInfo: {
        name: input.clientName,
        version: input.clientVersion,
      },
    },
    id: input.id,
  };
}

/**
 * Build a stateless 2026-07-28 request body for the OAuth flow's connectivity
 * probe and post-token verification. The stateless era has no `initialize`
 * handshake; every request self-describes through a `_meta` envelope carrying
 * the protocol version, client capabilities, and client identity. The OAuth
 * machine uses `tools/list` purely as a lightweight probe — unauthenticated it
 * elicits the `401` that starts discovery, and with a bearer token it confirms
 * the token works — so it never depends on the tool list itself.
 */
export function buildStatelessVerifyRequestBody(input: {
  protocolVersion: string;
  authMode?: OAuthAuthMode;
  clientName: string;
  clientVersion: string;
  id: number;
}): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "tools/list",
    params: {
      _meta: {
        [MCP_PROTOCOL_VERSION_META_KEY]: input.protocolVersion,
        [MCP_CLIENT_CAPABILITIES_META_KEY]: buildInitializeCapabilities(
          input.authMode,
        ),
        [MCP_CLIENT_INFO_META_KEY]: {
          name: input.clientName,
          version: input.clientVersion,
        },
      },
    },
    id: input.id,
  };
}
