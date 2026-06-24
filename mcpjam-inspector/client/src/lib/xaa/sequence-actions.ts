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
      description: "The Agent asks the MCP Server which Authorization Server protects it.",
      from: "client",
      to: "mcpServer",
      details: flowState.serverUrl
        ? [{ label: "Target", value: safePath(flowState.resourceMetadataUrl) }]
        : undefined,
    },
    {
      id: "received_resource_metadata",
      label: "Resource metadata",
      description: "The MCP Server returns its resource identifier and Authorization Server.",
      from: "mcpServer",
      to: "client",
      details: flowState.resourceUrl
        ? [{ label: "resource", value: flowState.resourceUrl }]
        : undefined,
    },
    {
      id: "discover_authz_metadata",
      label: "Fetch auth server metadata",
      description: "The Agent looks up the Authorization Server's token endpoint.",
      from: "client",
      to: "authServer",
      details: flowState.authzServerIssuer
        ? [{ label: "Issuer", value: flowState.authzServerIssuer }]
        : undefined,
    },
    {
      id: "received_authz_metadata",
      label: "Auth server metadata",
      description: "The Authorization Server returns its issuer and token endpoint.",
      from: "authServer",
      to: "client",
      details: flowState.tokenEndpoint
        ? [{ label: "Token", value: safePath(flowState.tokenEndpoint) }]
        : undefined,
    },
    {
      id: "user_authentication",
      label: "Mock OIDC login",
      description: "The Agent signs the user in at the IdP (mocked by MCPJam).",
      from: "client",
      to: "testIdp",
      details: flowState.email
        ? [{ label: "User", value: flowState.email }]
        : undefined,
    },
    {
      id: "received_identity_assertion",
      label: "ID token issued",
      description: "The IdP returns the ID token — proof of who the user is.",
      from: "testIdp",
      to: "client",
      details: flowState.identityAssertion
        ? [{ label: "Type", value: "OIDC ID token" }]
        : undefined,
    },
    {
      id: "token_exchange_request",
      label: "Token exchange",
      description: "The Agent trades the ID token to the IdP for an ID-JAG.",
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
      description: "The IdP returns a signed ID-JAG — the cross-app grant.",
      from: "testIdp",
      to: "client",
      details: flowState.idJag
        ? [{ label: "Protocol", value: XAA_PROTOCOL }]
        : undefined,
    },
    {
      id: "inspect_id_jag",
      label: "Inspect assertion",
      description: "The Agent decodes the ID-JAG locally to check it before redeeming it.",
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
      description: "The Agent redeems the ID-JAG at the Authorization Server for an access token.",
      from: "client",
      to: "authServer",
      details: flowState.tokenEndpoint
        ? [{ label: "Endpoint", value: safePath(flowState.tokenEndpoint) }]
        : undefined,
    },
    {
      id: "received_access_token",
      label: "Access token",
      description: "The Authorization Server returns an access token for the MCP Server.",
      from: "authServer",
      to: "client",
      details: flowState.accessToken
        ? [{ label: "token_type", value: flowState.tokenType || "Bearer" }]
        : undefined,
    },
    {
      id: "authenticated_mcp_request",
      label: "Authenticated MCP request",
      description: "The Agent calls the MCP Server with the access token.",
      from: "client",
      to: "mcpServer",
      details: flowState.serverUrl
        ? [{ label: "Target", value: safePath(flowState.serverUrl) }]
        : undefined,
    },
    {
      id: "complete",
      label: "Authenticated response",
      description: "The MCP Server accepts the access token and responds.",
      from: "mcpServer",
      to: "client",
      details: flowState.accessToken
        ? [{ label: "Status", value: "Ready" }]
        : undefined,
    },
  ];
}
