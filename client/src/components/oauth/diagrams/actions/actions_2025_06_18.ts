import type { OAuthFlowState } from "@/lib/oauth/state-machines/types";
import type { Action } from "../../shared";

export function buildActions_2025_06_18(
  flowState: OAuthFlowState,
  registrationStrategy: "dcr" | "preregistered",
): Action[] {
  return [
        {
          id: "request_without_token",
          label: "MCP request without token",
          description: "Client makes initial request without authorization",
          from: "client",
          to: "mcpServer",
          details: flowState.serverUrl
            ? [
                { label: "POST", value: flowState.serverUrl },
                { label: "method", value: "initialize" },
              ]
            : undefined,
        },
        {
          id: "received_401_unauthorized",
          label: "HTTP 401 Unauthorized with WWW-Authenticate header",
          description: "Server returns 401 with WWW-Authenticate header",
          from: "mcpServer",
          to: "client",
          details: flowState.resourceMetadataUrl
            ? [{ label: "Note", value: "Extract resource_metadata URL" }]
            : undefined,
        },
        {
          id: "request_resource_metadata",
          label: "Request Protected Resource Metadata",
          description: "Client requests metadata from well-known URI",
          from: "client",
          to: "mcpServer",
          details: flowState.resourceMetadataUrl
            ? [
                {
                  label: "GET",
                  value: new URL(flowState.resourceMetadataUrl).pathname,
                },
              ]
            : undefined,
        },
        {
          id: "received_resource_metadata",
          label: "Return metadata",
          description: "Server returns OAuth protected resource metadata",
          from: "mcpServer",
          to: "client",
          details: flowState.resourceMetadata?.authorization_servers
            ? [
                {
                  label: "Auth Server",
                  value: flowState.resourceMetadata.authorization_servers[0],
                },
              ]
            : undefined,
        },
        {
          id: "request_authorization_server_metadata",
          label: "GET Authorization server metadata endpoint",
          description:
            "Try RFC8414 path, then RFC8414 root (no OIDC support)",
          from: "client",
          to: "authServer",
          details: flowState.authorizationServerUrl
            ? [
                { label: "URL", value: flowState.authorizationServerUrl },
                { label: "Protocol", value: "2025-06-18" },
              ]
            : undefined,
        },
        {
          id: "received_authorization_server_metadata",
          label: "Authorization server metadata response",
          description: "Authorization Server returns metadata",
          from: "authServer",
          to: "client",
          details: flowState.authorizationServerMetadata
            ? [
                {
                  label: "Token",
                  value: new URL(
                    flowState.authorizationServerMetadata.token_endpoint,
                  ).pathname,
                },
                {
                  label: "Auth",
                  value: new URL(
                    flowState.authorizationServerMetadata.authorization_endpoint,
                  ).pathname,
                },
              ]
            : undefined,
        },
        // CIMD steps
        ...(registrationStrategy === "cimd"
          ? [
              {
                id: "cimd_prepare",
                label: "Client uses HTTPS URL as client_id",
                description:
                  "Client prepares to use URL-based client identification",
                from: "client",
                to: "client",
                details: flowState.clientId
                  ? [
                      {
                        label: "client_id (URL)",
                        value: flowState.clientId.includes("http")
                          ? flowState.clientId
                          : "https://www.mcpjam.com/.well-known/oauth/client-metadata.json",
                      },
                      {
                        label: "Method",
                        value: "Client ID Metadata Document (CIMD)",
                      },
                    ]
                  : [
                      {
                        label: "Note",
                        value: "HTTPS URL points to metadata document",
                      },
                    ],
              },
              {
                id: "cimd_fetch_request",
                label: "Fetch metadata from client_id URL",
                description:
                  "Authorization Server fetches client metadata from the URL",
                from: "authServer",
                to: "client",
                details: [
                  {
                    label: "Action",
                    value: "GET client_id URL",
                  },
                  {
                    label: "Note",
                    value:
                      "Server initiates metadata fetch during authorization",
                  },
                ],
              },
              {
                id: "cimd_metadata_response",
                label: "JSON metadata document",
                description:
                  "Client hosting returns metadata with redirect_uris and client info",
                from: "client",
                to: "authServer",
                details: [
                  {
                    label: "Content-Type",
                    value: "application/json",
                  },
                  {
                    label: "Contains",
                    value: "client_id, client_name, redirect_uris, etc.",
                  },
                ],
              },
              {
                id: "received_client_credentials",
                label: "Validate metadata and redirect_uris",
                description: "Authorization Server validates fetched metadata",
                from: "authServer",
                to: "authServer",
                details: [
                  {
                    label: "Validates",
                    value: "client_id matches URL, redirect_uris are valid",
                  },
                  {
                    label: "Security",
                    value: "SSRF protection, domain trust policies",
                  },
                ],
              },
            ]
          : registrationStrategy === "dcr"
            ? [
                {
                  id: "request_client_registration",
                  label: "POST /register (2025-11-25)",
                  description:
                    "Client registers dynamically with Authorization Server",
                  from: "client",
                  to: "authServer",
                  details: [
                    {
                      label: "Note",
                      value: "Dynamic client registration (DCR)",
                    },
                  ],
                },
                {
                  id: "received_client_credentials",
                  label: "Client Credentials",
                  description:
                    "Authorization Server returns client ID and credentials",
                  from: "authServer",
                  to: "client",
                  details: flowState.clientId
                    ? [
                        {
                          label: "client_id",
                          value: flowState.clientId.substring(0, 20) + "...",
                        },
                      ]
                    : undefined,
                },
              ]
            : [
                {
                  id: "received_client_credentials",
                  label: "Use Pre-registered Client (2025-11-25)",
                  description:
                    "Client uses pre-configured credentials (skipped DCR)",
                  from: "client",
                  to: "client",
                  details: flowState.clientId
                    ? [
                        {
                          label: "client_id",
                          value: flowState.clientId.substring(0, 20) + "...",
                        },
                        {
                          label: "Note",
                          value: "Pre-registered (no DCR needed)",
                        },
                      ]
                    : [
                        {
                          label: "Note",
                          value: "Pre-registered client credentials",
                        },
                      ],
                },
              ]),
        {
          id: "generate_pkce_parameters",
          label: "Generate PKCE parameters",
          description:
            "Client generates code verifier and challenge (REQUIRED), includes resource parameter",
          from: "client",
          to: "client",
          details: flowState.codeChallenge
            ? [
                {
                  label: "code_challenge",
                  value: flowState.codeChallenge.substring(0, 15) + "...",
                },
                {
                  label: "method",
                  value: flowState.codeChallengeMethod || "S256",
                },
                { label: "resource", value: flowState.serverUrl || "—" },
                { label: "Protocol", value: "2025-06-18" },
              ]
            : undefined,
        },
        {
          id: "authorization_request",
          label: "Open browser with authorization URL",
          description:
            "Client opens browser with authorization URL + code_challenge + resource",
          from: "client",
          to: "browser",
          details: flowState.authorizationUrl
            ? [
                {
                  label: "code_challenge",
                  value:
                    flowState.codeChallenge?.substring(0, 12) + "..." || "S256",
                },
                { label: "resource", value: flowState.serverUrl || "" },
              ]
            : undefined,
        },
        {
          id: "browser_to_auth_server",
          label: "Authorization request with resource parameter",
          description: "Browser navigates to authorization endpoint",
          from: "browser",
          to: "authServer",
          details: flowState.authorizationUrl
            ? [{ label: "Note", value: "User authorizes in browser" }]
            : undefined,
        },
        {
          id: "auth_redirect_to_browser",
          label: "Redirect to callback with authorization code",
          description:
            "Authorization Server redirects browser back to callback URL",
          from: "authServer",
          to: "browser",
          details: flowState.authorizationCode
            ? [
                {
                  label: "code",
                  value: flowState.authorizationCode.substring(0, 20) + "...",
                },
              ]
            : undefined,
        },
        {
          id: "received_authorization_code",
          label: "Authorization code callback",
          description:
            "Browser redirects back to client with authorization code",
          from: "browser",
          to: "client",
          details: flowState.authorizationCode
            ? [
                {
                  label: "code",
                  value: flowState.authorizationCode.substring(0, 20) + "...",
                },
              ]
            : undefined,
        },
        {
          id: "token_request",
          label: "Token request + code_verifier + resource",
          description: "Client exchanges authorization code for access token",
          from: "client",
          to: "authServer",
          details: flowState.codeVerifier
            ? [
                { label: "grant_type", value: "authorization_code" },
                { label: "resource", value: flowState.serverUrl || "" },
              ]
            : undefined,
        },
        {
          id: "received_access_token",
          label: "Access token (+ refresh token)",
          description: "Authorization Server returns access token",
          from: "authServer",
          to: "client",
          details: flowState.accessToken
            ? [
                { label: "token_type", value: flowState.tokenType || "Bearer" },
                {
                  label: "expires_in",
                  value: flowState.expiresIn?.toString() || "3600",
                },
              ]
            : undefined,
        },
        {
          id: "authenticated_mcp_request",
          label: "MCP request with access token",
          description: "Client makes authenticated request to MCP server",
          from: "client",
          to: "mcpServer",
          details: flowState.accessToken
            ? [
                { label: "POST", value: "tools/list" },
                {
                  label: "Authorization",
                  value:
                    "Bearer " + flowState.accessToken.substring(0, 15) + "...",
                },
              ]
            : undefined,
        },
        {
          id: "complete",
          label: "MCP response",
          description: "MCP Server returns successful response",
          from: "mcpServer",
          to: "client",
          details: flowState.accessToken
            ? [
                { label: "Status", value: "200 OK" },
                { label: "Content", value: "tools, resources, prompts" },
              ]
            : undefined,
        },
      ];
}
