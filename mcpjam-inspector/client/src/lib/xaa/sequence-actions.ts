import type { Action } from "@/components/oauth/shared/types";
import type { XAAFlowState } from "./types";
import { NEGATIVE_TEST_MODE_DETAILS } from "@/shared/xaa.js";

const XAA_PROTOCOL = "RFC 8693 + RFC 7523";

function safePath(url?: string): string | undefined {
  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export function buildXAAActions(flowState: XAAFlowState): Action[] {
  return [
    {
      id: "discover_resource_metadata",
      label: "Fetch resource metadata",
      description: "Client discovers RFC 9728 metadata from the MCP server.",
      from: "client",
      to: "mcpServer",
      details: flowState.serverUrl
        ? [{ label: "Target", value: safePath(flowState.resourceMetadataUrl) }]
        : undefined,
    },
    {
      id: "received_resource_metadata",
      label: "Resource metadata",
      description: "MCP server returns the resource identifier and auth server issuer.",
      from: "mcpServer",
      to: "client",
      details: flowState.resourceUrl
        ? [{ label: "resource", value: flowState.resourceUrl }]
        : undefined,
    },
    {
      id: "discover_authz_metadata",
      label: "Fetch auth server metadata",
      description: "Client discovers the authorization server token endpoint.",
      from: "client",
      to: "authServer",
      details: flowState.authzServerIssuer
        ? [{ label: "Issuer", value: flowState.authzServerIssuer }]
        : undefined,
    },
    {
      id: "received_authz_metadata",
      label: "Auth server metadata",
      description: "Authorization server returns issuer and token endpoint metadata.",
      from: "authServer",
      to: "client",
      details: flowState.tokenEndpoint
        ? [{ label: "Token", value: safePath(flowState.tokenEndpoint) }]
        : undefined,
    },
    {
      id: "user_authentication",
      label: "Mock OIDC login",
      description: "MCPJam synthetic issuer creates a mock enterprise ID token.",
      from: "client",
      to: "testIdp",
      details: flowState.email
        ? [{ label: "User", value: flowState.email }]
        : undefined,
    },
    {
      id: "received_identity_assertion",
      label: "ID token issued",
      description: "Synthetic issuer returns the mock identity assertion.",
      from: "testIdp",
      to: "client",
      details: flowState.identityAssertion
        ? [{ label: "Type", value: "OIDC ID token" }]
        : undefined,
    },
    {
      id: "token_exchange_request",
      label: "Token exchange",
      description: "Client exchanges the ID token for an ID-JAG with a selected test mode.",
      from: "client",
      to: "testIdp",
      details: [
        {
          label: "Mode",
          value: NEGATIVE_TEST_MODE_DETAILS[flowState.negativeTestMode].label,
        },
      ],
    },
    {
      id: "received_id_jag",
      label: "ID-JAG issued",
      description: "Synthetic issuer returns a signed ID-JAG JWT.",
      from: "testIdp",
      to: "client",
      details: flowState.idJag
        ? [{ label: "Protocol", value: XAA_PROTOCOL }]
        : undefined,
    },
    {
      id: "inspect_id_jag",
      label: "Inspect assertion",
      description: "Client decodes the ID-JAG locally before submitting it downstream.",
      from: "client",
      to: "client",
      details: flowState.idJagDecoded?.issues.length
        ? [
            {
              label: "Issues",
              value: String(flowState.idJagDecoded.issues.length),
            },
          ]
        : [{ label: "Issues", value: "None" }],
    },
    {
      id: "jwt_bearer_request",
      label: "JWT bearer grant",
      description: "Client submits the ID-JAG to the target authorization server.",
      from: "client",
      to: "authServer",
      details: flowState.tokenEndpoint
        ? [{ label: "Endpoint", value: safePath(flowState.tokenEndpoint) }]
        : undefined,
    },
    {
      id: "received_access_token",
      label: "Access token",
      description: "Authorization server returns an access token for the MCP resource.",
      from: "authServer",
      to: "client",
      details: flowState.accessToken
        ? [{ label: "token_type", value: flowState.tokenType || "Bearer" }]
        : undefined,
    },
    {
      id: "authenticated_mcp_request",
      label: "Authenticated MCP request",
      description: "Client retries an MCP initialize request with the issued access token.",
      from: "client",
      to: "mcpServer",
      details: flowState.serverUrl
        ? [{ label: "Target", value: safePath(flowState.serverUrl) }]
        : undefined,
    },
    {
      id: "complete",
      label: "Authenticated response",
      description: "MCP server accepts the access token and responds to the request.",
      from: "mcpServer",
      to: "client",
      details: flowState.accessToken
        ? [{ label: "Status", value: "Ready" }]
        : undefined,
    },
  ];
}
