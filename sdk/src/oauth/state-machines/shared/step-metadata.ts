import type { OAuthFlowStep } from "../types.js";

export interface OAuthStepInfo {
  title: string;
  summary: string;
  teachableMoments?: string[];
  tips?: string[];
}

export const STEP_ORDER: OAuthFlowStep[] = [
  "idle",
  "request_without_token",
  "received_401_unauthorized",
  "discovery_start",
  "request_resource_metadata",
  "received_resource_metadata",
  "request_authorization_server_metadata",
  "received_authorization_server_metadata",
  "cimd_prepare",
  "cimd_fetch_request",
  "cimd_metadata_response",
  "request_client_registration",
  "received_client_credentials",
  "generate_pkce_parameters",
  "authorization_request",
  "received_authorization_code",
  "token_request",
  "received_access_token",
  "authenticated_mcp_request",
  "complete",
  "verify_list_tools",
  "verify_call_tool",
];

export const STEP_METADATA: Record<OAuthFlowStep, OAuthStepInfo> = {
  idle: {
    title: "Idle",
    summary: "The OAuth flow is ready to start.",
    teachableMoments: [
      "Review your server selection and OAuth configuration before starting.",
    ],
  },
  request_without_token: {
    title: "Initial MCP Request",
    summary:
      "The client sends an unauthenticated initialize request to discover whether OAuth is required.",
    teachableMoments: [
      "OAuth flows usually begin with a protected resource request that deliberately lacks credentials.",
      "The response determines which discovery path the client must follow.",
    ],
  },
  received_401_unauthorized: {
    title: "401 Unauthorized",
    summary:
      "The MCP server indicates OAuth is required and often provides discovery hints in WWW-Authenticate.",
    teachableMoments: [
      "Look for the resource metadata URL or realm in the header to understand where discovery begins.",
    ],
    tips: [
      "If you get 200 instead, the server may allow optional OAuth or anonymous access.",
    ],
  },
  discovery_start: {
    title: "Start Discovery",
    summary:
      "The client derives authorization server endpoints from the MCP server URL.",
    teachableMoments: [
      "Legacy servers rely on RFC8414 discovery directly from the MCP base URL.",
      "Understanding how fallback URLs are constructed helps debug missing metadata issues.",
    ],
  },
  request_resource_metadata: {
    title: "Request Resource Metadata",
    summary:
      "The client requests RFC9728 resource metadata to learn which authorization server to use.",
    teachableMoments: [
      "Protected resource metadata links the resource to one or more authorization servers.",
      "If this step fails, check the MCP server's well-known configuration and headers.",
    ],
  },
  received_resource_metadata: {
    title: "Resource Metadata Received",
    summary:
      "The response describes supported authorization servers, scopes, and bearer method details.",
    teachableMoments: [
      "Validate that the authorization server URL looks correct for the environment you're targeting.",
    ],
  },
  request_authorization_server_metadata: {
    title: "Fetch Authorization Server Metadata",
    summary:
      "The client queries the authorization server's well-known endpoint (RFC8414 or OIDC).",
    teachableMoments: [
      "Different protocol versions prioritize different discovery strategies (path insertion, appending, etc.).",
      "Failure here often points to misconfigured issuer URLs or CORS/proxy issues.",
    ],
  },
  received_authorization_server_metadata: {
    title: "Authorization Server Metadata Received",
    summary:
      "Inspector validates the authorization, token, and optional registration endpoints.",
    teachableMoments: [
      "Confirm PKCE methods include S256 for modern flows.",
      "Check the available scopes and grant types to ensure the server supports what you need.",
    ],
  },
  cimd_prepare: {
    title: "Prepare CIMD",
    summary:
      "Draft protocol: the client prepares to use a Client ID Metadata Document (CIMD).",
    teachableMoments: [
      "CIMD replaces static client IDs with an HTTPS URL that hosts client metadata.",
    ],
  },
  cimd_fetch_request: {
    title: "Authorization Server Fetches CIMD",
    summary:
      "The authorization server fetches the client's metadata document over HTTPS.",
    teachableMoments: [
      "Monitor this step to diagnose TLS or hosting issues with your metadata document.",
    ],
  },
  cimd_metadata_response: {
    title: "CIMD Validated",
    summary:
      "The client confirms the authorization server successfully read the client metadata document.",
    teachableMoments: [
      "Ensure redirect URIs declared in the document match the environment you're testing.",
    ],
  },
  request_client_registration: {
    title: "Dynamic Client Registration",
    summary:
      "The client submits metadata to register a public client with the authorization server.",
    teachableMoments: [
      "Dynamic registration is optional in draft flows but required in earlier specs unless you pre-register.",
      "Watch for HTTP 4xx responses that indicate validation failures.",
    ],
  },
  received_client_credentials: {
    title: "Client Credentials Ready",
    summary:
      "The client stores client_id (and optionally client_secret) for the remainder of the flow.",
    teachableMoments: [
      "Keep an eye on whether the server returned a secret; public clients should use PKCE instead.",
    ],
  },
  generate_pkce_parameters: {
    title: "Generate PKCE Parameters",
    summary:
      "The client creates a code verifier and challenge to protect the authorization code exchange.",
    teachableMoments: [
      "PKCE S256 is required in draft specs and strongly recommended everywhere else.",
    ],
  },
  authorization_request: {
    title: "Authorization Request Ready",
    summary:
      "The client composes the authorization URL and waits for the user to approve access.",
    teachableMoments: [
      "Inspect the URL to ensure scopes and redirect URI are what you expect.",
    ],
  },
  received_authorization_code: {
    title: "Authorization Code Received",
    summary:
      "The user completed consent and the client captured the returned authorization code.",
    teachableMoments: [
      "State mismatches here usually indicate multiple concurrent authorizations or stale popups.",
    ],
  },
  token_request: {
    title: "Exchange Authorization Code",
    summary:
      "The client calls the token endpoint with the authorization code and PKCE verifier.",
    teachableMoments: [
      "Token endpoint errors often reveal scope or client configuration problems.",
    ],
  },
  received_access_token: {
    title: "Tokens Received",
    summary:
      "The client stores access and refresh tokens for subsequent authenticated MCP requests.",
    teachableMoments: [
      "Check the token type and expiry to confirm the server honored offline access or refresh tokens.",
    ],
  },
  authenticated_mcp_request: {
    title: "Authenticated MCP Request",
    summary:
      "The client retries the MCP initialize call with the freshly issued access token.",
    teachableMoments: [
      "Use this step to validate that MCP servers accept OAuth tokens and return capabilities.",
    ],
  },
  complete: {
    title: "Flow Complete",
    summary:
      "The client verified the server with OAuth credentials and recorded the final response.",
    teachableMoments: [
      "Continue exploring with authenticated requests or reset to run the flow again.",
    ],
  },
  verify_list_tools: {
    title: "Verify: List Tools",
    summary:
      "Connect to the MCP server with the obtained token and list available tools.",
    teachableMoments: [
      "This step confirms the OAuth token is actually usable for MCP operations.",
    ],
  },
  verify_call_tool: {
    title: "Verify: Call Tool",
    summary:
      "Execute a tool on the MCP server to confirm end-to-end functionality.",
    teachableMoments: [
      "Calling a tool validates not just authentication but also authorization scopes.",
    ],
  },
};

export function getStepInfo(step: OAuthFlowStep): OAuthStepInfo {
  return (
    STEP_METADATA[step] ?? {
      title: step,
      summary: "No additional information available for this step.",
    }
  );
}

export function getStepIndex(step: OAuthFlowStep): number {
  const index = STEP_ORDER.indexOf(step);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}
