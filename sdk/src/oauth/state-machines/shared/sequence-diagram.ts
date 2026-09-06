/**
 * One builder for the OAuth sequence diagram, parameterized by era.
 *
 * This is pure presentation. Nothing here touches the wire — the actions it
 * returns are rendered as arrows in the debugger's sequence diagram — which is
 * why it is the one part of the era machines worth collapsing. It was ~1,700
 * lines of near-identical array literals across four files: maximum maintenance
 * cost, zero protocol risk. The wire step tables are the opposite trade and stay
 * separate.
 *
 * The eras genuinely differ in five places, and each is a field on
 * {@link SequenceDiagramEraSpec} rather than a conditional buried in the body:
 *
 *   1. 2025-03-26 has no protected-resource-metadata preamble at all — it
 *      discovers the authorization server from the MCP server's own origin.
 *   2. The authorization-server-metadata step describes a different discovery
 *      strategy per era.
 *   3. CIMD exists only from 2025-11-25.
 *   4. PKCE is "recommended" wording before 2025-11-25 and "REQUIRED" after.
 *   5. 2026-07-28 adds three things: a DCR-deprecation note, the issuer the
 *      client credentials are bound to, and the SEP-2350 scope union.
 *
 * `sequence-actions-goldens.test.ts` pins the rendered output for every era ×
 * strategy × populated/empty state, so this consolidation is verifiable rather
 * than asserted.
 */

import type { OAuthFlowState } from "../types.js";
import type { DiagramAction, DiagramDetail } from "./types.js";

export type SequenceRegistrationStrategy = "cimd" | "dcr" | "preregistered";

export interface SequenceDiagramEraSpec {
  /** Rendered in "Protocol" details and in the era-stamped step labels. */
  protocolVersion: string;
  /**
   * Whether the ladder opens with the unauthenticated probe, the 401, and the
   * RFC 9728 metadata exchange. 2025-03-26 has no PRM step.
   */
  includesProtectedResourceMetadata: boolean;
  /** MCP method shown on the unauthenticated probe. */
  initialMcpMethod: string;
  /** How this era finds the authorization-server metadata document. */
  authorizationServerMetadata: { label: string; description: string };
  /** PKCE step wording: the requirement level changed between eras. */
  pkce: { label: string; description: string };
  /** The resource indicator as this era previews it. */
  resourceValue: (flowState: OAuthFlowState) => string | undefined;
  /** Extra detail rows appended where the era adds them. */
  dcrNotes?: DiagramDetail[];
  clientCredentialsExtras?: (flowState: OAuthFlowState) => DiagramDetail[];
  authorizationRequestExtras?: (flowState: OAuthFlowState) => DiagramDetail[];
}

function truncate(value: string, length: number): string {
  return `${value.substring(0, length)}...`;
}

/**
 * Render a server-advertised URL as its path, or say so when it is not a URL.
 *
 * Every value this runs on is copied verbatim out of a document the server
 * under test wrote — the `resource_metadata` challenge parameter, the
 * authorization-server metadata endpoints — and none of them is validated as
 * absolute before it lands in flow state. `new URL()` throws on a relative
 * value, and this builder runs inside the diagram's `useMemo`, so an unguarded
 * parse takes the whole panel down at exactly the moment its ladder is the
 * thing worth reading.
 *
 * The raw value alone would not be enough. A relative `/.well-known/...`
 * renders byte-identical to the path of a correct absolute URL, so the
 * misconfiguration would look like a normal step; the suffix is what makes the
 * two distinguishable on screen.
 */
function pathnameOrRawValue(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return new URL(value).pathname;
    } catch {
      return `${value} (not an absolute URL)`;
    }
  }

  let displayedValue: string;
  try {
    displayedValue =
      typeof value === "string" ||
      (typeof value === "object" && value !== null)
        ? JSON.stringify(value) ?? String(value)
        : String(value);
  } catch {
    displayedValue = "[unserializable value]";
  }
  return `${displayedValue} (not an absolute URL)`;
}

function resourceDetailValue(
  flowState: OAuthFlowState,
  era: SequenceDiagramEraSpec,
  fallback: string,
): string {
  if (flowState.resourceIndicatorSuppressed) {
    return "omitted (emulation)";
  }
  return era.resourceValue(flowState) || fallback;
}

function protectedResourceMetadataActions(
  flowState: OAuthFlowState,
  era: SequenceDiagramEraSpec,
): DiagramAction[] {
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
            { label: "method", value: era.initialMcpMethod },
          ]
        : undefined,
    },
    {
      id: "received_401_unauthorized",
      label: "HTTP 401 Unauthorized with WWW-Authenticate header",
      description: "Server returns 401 with WWW-Authenticate header",
      from: "mcpServer",
      to: "client",
      details: flowState.resourceMetadataUrl !== undefined
        ? [{ label: "Note", value: "Extract resource_metadata URL" }]
        : undefined,
    },
    {
      id: "request_resource_metadata",
      label: "Request Protected Resource Metadata",
      description: "Client requests metadata from well-known URI",
      from: "client",
      to: "mcpServer",
      details: flowState.resourceMetadataUrl !== undefined
        ? [
            {
              label: "GET",
              value: pathnameOrRawValue(flowState.resourceMetadataUrl),
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
  ];
}

function cimdActions(flowState: OAuthFlowState): DiagramAction[] {
  return [
    {
      id: "cimd_prepare",
      label: "Client uses HTTPS URL as client_id",
      description: "Client prepares to use URL-based client identification",
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
            { label: "Method", value: "Client ID Metadata Document (CIMD)" },
          ]
        : [{ label: "Note", value: "HTTPS URL points to metadata document" }],
    },
    {
      id: "cimd_fetch_request",
      label: "Fetch metadata from client_id URL",
      description: "Authorization Server fetches client metadata from the URL",
      from: "authServer",
      to: "client",
      details: [
        { label: "Action", value: "GET client_id URL" },
        {
          label: "Note",
          value: "Server initiates metadata fetch during authorization",
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
        { label: "Content-Type", value: "application/json" },
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
        { label: "Security", value: "SSRF protection, domain trust policies" },
      ],
    },
  ];
}

function registrationActions(
  flowState: OAuthFlowState,
  era: SequenceDiagramEraSpec,
  registrationStrategy: SequenceRegistrationStrategy,
): DiagramAction[] {
  if (registrationStrategy === "cimd") {
    return cimdActions(flowState);
  }

  const extras = era.clientCredentialsExtras?.(flowState) ?? [];

  if (registrationStrategy === "dcr") {
    return [
      {
        id: "request_client_registration",
        label: `POST /register (${era.protocolVersion})`,
        description: "Client registers dynamically with Authorization Server",
        from: "client",
        to: "authServer",
        details: [
          { label: "Note", value: "Dynamic client registration (DCR)" },
          ...(era.dcrNotes ?? []),
        ],
      },
      {
        id: "received_client_credentials",
        label: "Client Credentials",
        description: "Authorization Server returns client ID and credentials",
        from: "authServer",
        to: "client",
        details: flowState.clientId
          ? [
              { label: "client_id", value: truncate(flowState.clientId, 20) },
              ...extras,
            ]
          : undefined,
      },
    ];
  }

  return [
    {
      id: "received_client_credentials",
      label: `Use Pre-registered Client (${era.protocolVersion})`,
      description: "Client uses pre-configured credentials (skipped DCR)",
      from: "client",
      to: "client",
      details: flowState.clientId
        ? [
            { label: "client_id", value: truncate(flowState.clientId, 20) },
            { label: "Note", value: "Pre-registered (no DCR needed)" },
            ...extras,
          ]
        : [{ label: "Note", value: "Pre-registered client credentials" }],
    },
  ];
}

/**
 * Render the full OAuth ladder for one era and registration strategy.
 */
export function buildOAuthSequenceDiagramActions(
  flowState: OAuthFlowState,
  registrationStrategy: SequenceRegistrationStrategy,
  era: SequenceDiagramEraSpec,
): DiagramAction[] {
  return [
    ...(era.includesProtectedResourceMetadata
      ? protectedResourceMetadataActions(flowState, era)
      : []),
    {
      id: "request_authorization_server_metadata",
      label: era.authorizationServerMetadata.label,
      description: era.authorizationServerMetadata.description,
      from: "client",
      to: "authServer",
      details: flowState.authorizationServerUrl
        ? [
            { label: "URL", value: flowState.authorizationServerUrl },
            { label: "Protocol", value: era.protocolVersion },
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
              value: pathnameOrRawValue(
                flowState.authorizationServerMetadata.token_endpoint,
              ),
            },
            {
              label: "Auth",
              value: pathnameOrRawValue(
                flowState.authorizationServerMetadata.authorization_endpoint,
              ),
            },
          ]
        : undefined,
    },
    ...registrationActions(flowState, era, registrationStrategy),
    {
      id: "generate_pkce_parameters",
      label: era.pkce.label,
      description: era.pkce.description,
      from: "client",
      to: "client",
      details: flowState.codeChallenge
        ? [
            {
              label: "code_challenge",
              value: truncate(flowState.codeChallenge, 15),
            },
            { label: "method", value: flowState.codeChallengeMethod || "S256" },
            { label: "resource", value: resourceDetailValue(flowState, era, "—") },
            { label: "Protocol", value: era.protocolVersion },
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
              // Preserved verbatim from the era builders, `||` precedence and
              // all: on an absent challenge this yields the string
              // "undefined..." rather than "S256". Changing it would move the
              // goldens, and this function's job is to not move them.
              value: flowState.codeChallenge?.substring(0, 12) + "..." || "S256",
            },
            { label: "resource", value: resourceDetailValue(flowState, era, "") },
            ...(era.authorizationRequestExtras?.(flowState) ?? []),
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
      description: "Authorization Server redirects browser back to callback URL",
      from: "authServer",
      to: "browser",
      details: flowState.authorizationCode
        ? [{ label: "code", value: truncate(flowState.authorizationCode, 20) }]
        : undefined,
    },
    {
      id: "received_authorization_code",
      label: "Authorization code callback",
      description: "Browser redirects back to client with authorization code",
      from: "browser",
      to: "client",
      details: flowState.authorizationCode
        ? [{ label: "code", value: truncate(flowState.authorizationCode, 20) }]
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
            { label: "resource", value: resourceDetailValue(flowState, era, "") },
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
              value: `Bearer ${truncate(flowState.accessToken, 15)}`,
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
