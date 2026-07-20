import type { OAuthAuthMode, OAuthProtocolVersion } from "../types.js";

export const MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION =
  "io.modelcontextprotocol/oauth-client-credentials";

export function resolveInitializeProtocolVersion(
  protocolVersion: OAuthProtocolVersion,
): string {
  switch (protocolVersion) {
    case "2025-11-25":
      return "2025-11-25";
    case "2026-07-28":
      // The 2026-07-28 wire is stateless (no initialize handshake); the OAuth
      // flow's token-verification request still carries this version header.
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
