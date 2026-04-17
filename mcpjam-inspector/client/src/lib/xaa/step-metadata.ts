import type { XAAFlowStep } from "./types";

export interface XAAStepInfo {
  title: string;
  summary: string;
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
    summary: "The debugger is ready to walk through the XAA enterprise authorization flow.",
    teachableMoments: [
      "You need three aligned values before stage 3 works: trusted issuer, audience, and resource.",
    ],
  },
  discover_resource_metadata: {
    title: "Discover Resource Metadata",
    summary: "Fetch RFC 9728 protected resource metadata from the target MCP server.",
    teachableMoments: [
      "This tells the client which authorization server should mint access tokens for the MCP server.",
    ],
  },
  received_resource_metadata: {
    title: "Resource Metadata Received",
    summary: "Capture the MCP server resource identifier and linked authorization server issuer.",
    teachableMoments: [
      "The `resource` claim in the ID-JAG should line up with this metadata.",
    ],
  },
  discover_authz_metadata: {
    title: "Discover Authorization Metadata",
    summary: "Fetch RFC 8414 or OIDC discovery metadata from the authorization server.",
    teachableMoments: [
      "The ID-JAG `aud` claim should match the authorization server issuer, not the token endpoint URL.",
    ],
  },
  received_authz_metadata: {
    title: "Authorization Metadata Received",
    summary: "Inspect the issuer and token endpoint that will receive the JWT bearer assertion.",
    teachableMoments: [
      "If discovery fails, the authorization server issuer or well-known metadata is usually misconfigured.",
    ],
  },
  user_authentication: {
    title: "Mock User Authentication",
    summary: "MCPJam issues a synthetic OIDC ID token for the simulated enterprise user.",
    teachableMoments: [
      "This is stage 1 of the XAA flow: a user identity assertion from the enterprise IdP.",
    ],
  },
  received_identity_assertion: {
    title: "Identity Assertion Ready",
    summary: "The debugger stores the synthetic ID token that will be exchanged for an ID-JAG.",
    teachableMoments: [
      "The ID token is an input to token exchange; it is not sent directly to the target authorization server.",
    ],
  },
  token_exchange_request: {
    title: "RFC 8693 Token Exchange",
    summary: "Exchange the synthetic ID token for an ID-JAG, optionally injecting a negative test mode.",
    teachableMoments: [
      "This is where broken assertions get created for audience, issuer, header, and claim validation tests.",
    ],
  },
  received_id_jag: {
    title: "ID-JAG Issued",
    summary: "The synthetic issuer returns a signed ID-JAG JWT.",
    teachableMoments: [
      "A valid ID-JAG includes `iss`, `sub`, `aud`, `resource`, `client_id`, `jti`, `iat`, and `exp`.",
    ],
  },
  inspect_id_jag: {
    title: "Inspect ID-JAG",
    summary: "Decode the header and payload locally before sending the assertion downstream.",
    teachableMoments: [
      "Use this step to confirm which field a negative test mode is intentionally breaking.",
    ],
  },
  jwt_bearer_request: {
    title: "RFC 7523 JWT Bearer Request",
    summary: "Submit the ID-JAG to the target authorization server token endpoint through the debugger proxy.",
    teachableMoments: [
      "If this fails, check whether the server trusts the synthetic issuer JWKS and supports the JWT bearer grant.",
    ],
  },
  received_access_token: {
    title: "Access Token Received",
    summary: "Store the access token returned by the authorization server.",
    teachableMoments: [
      "A successful response here proves the authorization server accepted the ID-JAG and policy checks passed.",
    ],
  },
  authenticated_mcp_request: {
    title: "Authenticated MCP Request",
    summary: "Retry an MCP initialize request with the issued access token.",
    teachableMoments: [
      "This closes the loop: the access token has to work on the real MCP server, not just the token endpoint.",
    ],
  },
  complete: {
    title: "Flow Complete",
    summary: "The debugger completed the synthetic XAA flow end-to-end.",
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
