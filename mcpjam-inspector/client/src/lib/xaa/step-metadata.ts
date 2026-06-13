import type { XAAFlowStep } from "./types";

/**
 * Phases group the debugger's fine-grained machine steps onto the four
 * numbered steps of draft-ietf-oauth-identity-assertion-authz-grant, plus a
 * "Phase 0" for MCP discovery — which the spec does NOT define (it assumes a
 * pre-configured client). Keeping that distinction visible is the point:
 * developers should leave this screen knowing which parts are the XAA grant
 * and which parts are MCP bootstrap.
 */
export type XAAPhaseKey =
  | "bootstrap"
  | "sso"
  | "token_exchange"
  | "jwt_bearer"
  | "mcp_request";

export interface XAAPhaseInfo {
  title: string;
  /** Step number in the ID-JAG draft (1–4); null = not part of the grant. */
  specStep: number | null;
  blurb: string;
}

export const XAA_PHASE_ORDER: XAAPhaseKey[] = [
  "bootstrap",
  "sso",
  "token_exchange",
  "jwt_bearer",
  "mcp_request",
];

export const XAA_PHASES: Record<XAAPhaseKey, XAAPhaseInfo> = {
  bootstrap: {
    title: "Bootstrap — MCP discovery",
    specStep: null,
    blurb:
      "RFC 9728/8414 discovery, not part of the XAA grant. The spec assumes the client already knows the resource's authorization server; an MCP client learns it here instead — and that issuer becomes the ID-JAG audience in Phase 2. Skipped entirely when the authorization server is pre-configured.",
  },
  sso: {
    title: "User SSO with the IdP",
    specStep: 1,
    blurb:
      "The user signs in at the enterprise IdP and the requesting app holds an OIDC ID token. This happens once per user session, independent of any particular MCP server. The debugger mocks the IdP.",
  },
  token_exchange: {
    title: "Token exchange: ID token → ID-JAG",
    specStep: 2,
    blurb:
      "RFC 8693 exchange at the IdP. The app presents the ID token with audience = the resource authorization server's issuer; the IdP mints an ID-JAG addressed to that server. The ID token itself never leaves the IdP relationship.",
  },
  jwt_bearer: {
    title: "JWT bearer grant at the resource's auth server",
    specStep: 3,
    blurb:
      "RFC 7523: the app presents the ID-JAG as an assertion to the resource authorization server's token endpoint. That server validates iss, aud, and resource, then mints an access token.",
  },
  mcp_request: {
    title: "Authenticated resource request",
    specStep: 4,
    blurb:
      "Call the MCP server with the access token — the only credential the resource server ever sees. Neither the ID token nor the ID-JAG is sent to it.",
  },
};

export function getXAAPhaseNumber(phase: XAAPhaseKey): number {
  return XAA_PHASE_ORDER.indexOf(phase);
}

export interface XAAStepInfo {
  title: string;
  summary: string;
  /** Phase this step belongs to; undefined only for machine states like idle. */
  phase?: XAAPhaseKey;
  teachableMoments?: string[];
}

export const XAA_STEP_ORDER: XAAFlowStep[] = [
  "idle",
  "discover_resource_metadata",
  "received_resource_metadata",
  "discover_authz_metadata",
  "received_authz_metadata",
  "user_authentication",
  "received_identity_assertion",
  "token_exchange_request",
  "received_id_jag",
  "inspect_id_jag",
  "jwt_bearer_request",
  "received_access_token",
  "authenticated_mcp_request",
  "complete",
];

export const XAA_STEP_METADATA: Record<XAAFlowStep, XAAStepInfo> = {
  idle: {
    title: "Idle",
    summary:
      "The debugger is ready to walk through the XAA enterprise authorization flow.",
    teachableMoments: [
      "You need three aligned values before the JWT bearer grant works: trusted issuer, audience, and resource.",
    ],
  },
  discover_resource_metadata: {
    title: "Discover Resource Metadata",
    summary:
      "Fetch RFC 9728 protected resource metadata from the target MCP server.",
    phase: "bootstrap",
    teachableMoments: [
      "This tells the client which authorization server should mint access tokens for the MCP server.",
    ],
  },
  received_resource_metadata: {
    title: "Resource Metadata Received",
    summary:
      "Capture the MCP server resource identifier and linked authorization server issuer.",
    phase: "bootstrap",
    teachableMoments: [
      "The `resource` claim in the ID-JAG minted in Phase 2 should line up with this metadata.",
    ],
  },
  discover_authz_metadata: {
    title: "Discover Authorization Metadata",
    summary:
      "Fetch RFC 8414 or OIDC discovery metadata from the authorization server.",
    phase: "bootstrap",
    teachableMoments: [
      "Note the `issuer` in this metadata: the ID-JAG minted in Phase 2 must carry it as `aud`. The spec requires the audience to be the authorization server's issuer identifier — not its `token_endpoint`.",
    ],
  },
  received_authz_metadata: {
    title: "Authorization Metadata Received",
    summary:
      "Inspect the issuer and token endpoint that will receive the JWT bearer assertion.",
    phase: "bootstrap",
    teachableMoments: [
      "If discovery fails, the authorization server issuer or well-known metadata is usually misconfigured.",
    ],
  },
  user_authentication: {
    title: "Mock User Authentication",
    summary:
      "MCPJam issues a synthetic OIDC ID token for the simulated enterprise user.",
    phase: "sso",
    teachableMoments: [
      "Spec step 1: the user authenticates at the enterprise IdP and the app receives an identity assertion (an OIDC ID token).",
    ],
  },
  received_identity_assertion: {
    title: "Identity Assertion Ready",
    summary:
      "The debugger stores the synthetic ID token that will be exchanged for an ID-JAG.",
    phase: "sso",
    teachableMoments: [
      "The ID token is an input to token exchange; it is not sent directly to the target authorization server.",
    ],
  },
  token_exchange_request: {
    title: "RFC 8693 Token Exchange",
    summary:
      "Exchange the synthetic ID token for an ID-JAG, optionally injecting a negative test mode.",
    phase: "token_exchange",
    teachableMoments: [
      "Spec step 2: the `audience` parameter names the resource authorization server's issuer — the value discovered (or pre-configured) in Phase 0.",
      "This is where broken assertions get created for audience, issuer, header, and claim validation tests.",
    ],
  },
  received_id_jag: {
    title: "ID-JAG Issued",
    summary: "The synthetic issuer returns a signed ID-JAG JWT.",
    phase: "token_exchange",
    teachableMoments: [
      "A valid ID-JAG includes `iss`, `sub`, `aud`, `resource`, `client_id`, `jti`, `iat`, and `exp`.",
    ],
  },
  inspect_id_jag: {
    title: "Inspect ID-JAG",
    summary:
      "Decode the header and payload locally before sending the assertion downstream.",
    phase: "token_exchange",
    teachableMoments: [
      "`aud` must exactly match the resource authorization server's issuer, and `resource` must match the MCP server's resource identifier.",
      "Use this step to confirm which field a negative test mode is intentionally breaking.",
    ],
  },
  jwt_bearer_request: {
    title: "RFC 7523 JWT Bearer Request",
    summary:
      "Submit the ID-JAG to the target authorization server token endpoint through the debugger proxy.",
    phase: "jwt_bearer",
    teachableMoments: [
      "Spec step 3: the resource authorization server validates the ID-JAG's `iss`, `aud`, and `resource` before minting an access token.",
      "If this fails, check whether the server trusts the synthetic issuer JWKS and supports the JWT bearer grant.",
    ],
  },
  received_access_token: {
    title: "Access Token Received",
    summary: "Store the access token returned by the authorization server.",
    phase: "jwt_bearer",
    teachableMoments: [
      "A successful response here proves the authorization server accepted the ID-JAG and policy checks passed.",
    ],
  },
  authenticated_mcp_request: {
    title: "Authenticated MCP Request",
    summary: "Retry an MCP initialize request with the issued access token.",
    phase: "mcp_request",
    teachableMoments: [
      "Spec step 4: this closes the loop — the access token has to work on the real MCP server, not just the token endpoint.",
    ],
  },
  complete: {
    title: "Flow Complete",
    summary: "The debugger completed the synthetic XAA flow end-to-end.",
    phase: "mcp_request",
    teachableMoments: [
      "Switch negative test modes to probe specific authorization server validation paths.",
    ],
  },
};

export function getXAAStepInfo(step: XAAFlowStep): XAAStepInfo {
  return (
    XAA_STEP_METADATA[step] ?? {
      title: step,
      summary: "No additional information available for this step.",
    }
  );
}

export function getXAAStepIndex(step: XAAFlowStep): number {
  const index = XAA_STEP_ORDER.indexOf(step);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}
