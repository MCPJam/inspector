import type { Action } from "@/components/oauth/shared/types";
import type { XAAFlowState } from "./types";
import { NEGATIVE_TEST_MODE_DETAILS, SAML2_TOKEN_TYPE } from "@/shared/xaa.js";

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
  // Input axis (D6): the three identity-leg actions change wording for SAML
  // runs so the diagram visibly reflects the assertion format. OIDC labels
  // stay byte-identical to the pre-SAML diagram.
  const isSaml = flowState.identityAssertionFormat === "saml";

  // Strategy-specific bootstrap exchanges. Included only for the selected
  // strategy so default (pre-registered) diagrams are unchanged.
  const registrationActions: Action[] =
    flowState.registrationStrategy === "dcr"
      ? flowState.dcrRegistrationReused
        ? [
            {
              id: "received_client_credentials",
              label: "Reuse session registration",
              description:
                "No network exchange: the Agent reuses the client it registered earlier this browser session.",
              from: "client",
              to: "client",
              details: flowState.clientId
                ? [{ label: "client_id", value: flowState.clientId }]
                : undefined,
            },
          ]
        : [
            {
              id: "request_client_registration",
              label: "Register client (open DCR)",
              description:
                "The Agent registers a client at the Authorization Server without an initial access token. (RFC 7591.)",
              from: "client",
              to: "authServer",
              details: flowState.authzMetadata?.registration_endpoint
                ? [
                    {
                      label: "Endpoint",
                      value: safePath(
                        flowState.authzMetadata.registration_endpoint
                      ),
                    },
                  ]
                : undefined,
            },
            {
              id: "received_client_credentials",
              label: "Client credentials issued",
              description:
                "The Authorization Server created the client; MCPJam holds its credentials for this session only.",
              from: "authServer",
              to: "client",
              details: flowState.clientId
                ? [{ label: "client_id", value: flowState.clientId }]
                : undefined,
            },
          ]
      : flowState.registrationStrategy === "cimd"
        ? [
            {
              id: "fetch_client_metadata_document",
              label: "Preflight hosted client metadata document",
              description:
                "Debugger preflight of MCPJam's hosted document — the Authorization Server performs its own fetch; only the later JWT bearer grant tests its acceptance.",
              from: "client",
              to: "client",
              details: flowState.clientId
                ? [{ label: "client_id (URL)", value: flowState.clientId }]
                : undefined,
            },
            {
              id: "received_client_metadata",
              label: "Client metadata ready",
              description:
                "The document's client_id equals its URL and declares the XAA grants; the URL is this run's client identity.",
              from: "client",
              to: "client",
              details: [{ label: "Auth method", value: "none (public)" }],
            },
          ]
        : [];

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
    ...registrationActions,
    {
      id: "user_authentication",
      label: isSaml ? "Mock SAML SSO" : "Simulate sign-in at MCPJam IdP",
      description: isSaml
        ? "MCPJam signs the user in at the IdP via SP-initiated SAML SSO (mocked)."
        : "MCPJam simulates the user signing in at its identity provider.",
      from: "client",
      to: "testIdp",
      details: flowState.email
        ? [{ label: "User", value: flowState.email }]
        : undefined,
    },
    {
      id: "received_identity_assertion",
      label: isSaml
        ? "SAML assertion issued"
        : "ID token issued by MCPJam IdP",
      description: isSaml
        ? "MCPJam's identity provider gives the Agent a signed SAML assertion."
        : "MCPJam's identity provider gives the Agent an ID token.",
      from: "testIdp",
      to: "client",
      details: flowState.identityAssertion
        ? isSaml
          ? [
              { label: "Type", value: "SAML 2.0 assertion (base64)" },
              // Structured subject metadata from the /authenticate response —
              // rendered only when actually present, never a placeholder.
              ...(flowState.identityAssertionSubject
                ? [
                    {
                      label: "NameID",
                      value: flowState.identityAssertionSubject.nameid,
                    },
                  ]
                : []),
            ]
          : [{ label: "Type", value: "OIDC ID token" }]
        : undefined,
    },
    {
      id: "token_exchange_request",
      label: "Token exchange",
      description: isSaml
        ? "The Agent trades the SAML assertion to the IdP for an ID-JAG."
        : "The Agent trades the ID token to the IdP for an ID-JAG.",
      from: "client",
      to: "testIdp",
      details: [
        {
          label: "Mode",
          value: NEGATIVE_TEST_MODE_DETAILS[flowState.negativeTestMode].label,
        },
        // Draft §4.3: a SAML run presents the assertion under the saml2
        // subject_token_type. OIDC runs keep the original detail set.
        ...(isSaml
          ? [{ label: "subject_token_type", value: SAML2_TOKEN_TYPE }]
          : []),
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
      label: "Request access token using ID-JAG",
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
