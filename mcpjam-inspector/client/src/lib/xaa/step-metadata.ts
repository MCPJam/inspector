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

// Actor names match the sequence diagram exactly — Agent, IdP, MCP Server,
// Authorization Server — so a reader new to XAA can map every sentence onto a
// box in the picture. Jargon (ID token, ID-JAG, access token) is glossed on
// first use; RFC numbers stay as secondary parentheticals, never the lead.
export const XAA_PHASES: Record<XAAPhaseKey, XAAPhaseInfo> = {
  bootstrap: {
    title: "Setup — find the MCP server's authorization server",
    specStep: null,
    blurb:
      "Setup that runs before XAA proper. The Agent asks the MCP Server which Authorization Server protects it, then looks up where that server hands out tokens. The XAA spec assumes the Agent already knows this, so it's numbered Phase 0 — and skipped entirely when you've pre-configured the Authorization Server. The Authorization Server's issuer found here is reused later so the grant is addressed to the right server. (Uses the standard OAuth discovery specs, RFC 9728 and 8414.)",
  },
  sso: {
    title: "Sign in — the user logs in at the IdP",
    specStep: 1,
    blurb:
      "The user logs in at their IdP — the identity provider, i.e. the company login — and the Agent comes away with an ID token: proof of who the user is. This happens once per session and isn't tied to any MCP server yet. In this debugger MCPJam plays the IdP, so the login is simulated.",
  },
  token_exchange: {
    title: "Exchange — swap the login for a cross-app grant",
    specStep: 2,
    blurb:
      "The Agent hands the ID token back to the IdP and gets an ID-JAG in return — a short-lived grant that means “this user, for this one MCP server.” The Agent tells the IdP which Authorization Server the grant is for (the one found in Phase 0). The ID token itself never travels any further. (On the wire this is an RFC 8693 token exchange.)",
  },
  jwt_bearer: {
    title: "Redeem — trade the grant for an access token",
    specStep: 3,
    blurb:
      "The Agent presents the ID-JAG to the MCP server's Authorization Server. That server checks the grant came from an IdP it trusts, is addressed to itself, and names the right MCP Server — then issues an access token the Agent can actually use. (On the wire this is an RFC 7523 JWT-bearer grant.)",
  },
  mcp_request: {
    title: "Call — use the access token on the MCP server",
    specStep: 4,
    blurb:
      "The final step: the Agent calls the MCP Server with the access token — the only credential the MCP Server ever sees. The ID token and ID-JAG stay behind. To the MCP Server this looks like an ordinary authenticated request.",
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
      "Ready to walk the XAA flow step by step. XAA lets the Agent call an MCP Server on the user's behalf without making the user log in again.",
    teachableMoments: [
      "The whole flow hinges on three values lining up: the IdP must be trusted by the Authorization Server, the grant must be addressed to that Authorization Server, and it must name the right MCP Server.",
    ],
  },
  discover_resource_metadata: {
    title: "Ask the MCP Server Who Guards It",
    summary:
      "The Agent asks the MCP Server which Authorization Server protects it. (RFC 9728 protected-resource metadata.)",
    phase: "bootstrap",
    teachableMoments: [
      "This is how the Agent learns which Authorization Server can issue access tokens for the MCP Server — the MCP equivalent of already knowing your auth server.",
    ],
  },
  received_resource_metadata: {
    title: "MCP Server Names Its Authorization Server",
    summary:
      "The MCP Server replies with its resource identifier and the Authorization Server that guards it.",
    phase: "bootstrap",
    teachableMoments: [
      "Remember the Authorization Server named here: the ID-JAG minted in Phase 2 is addressed to it, and the ID-JAG's `resource` should match this MCP Server.",
    ],
  },
  discover_authz_metadata: {
    title: "Look Up the Authorization Server's Token Endpoint",
    summary:
      "The Agent looks up where the Authorization Server hands out tokens. (RFC 8414 / OpenID Connect discovery.)",
    phase: "bootstrap",
    teachableMoments: [
      "The `issuer` in this metadata is what the ID-JAG must carry as its `aud` (audience). The audience is the Authorization Server's issuer URL — not its `token_endpoint`.",
    ],
  },
  received_authz_metadata: {
    title: "Authorization Server Details Received",
    summary:
      "The Agent now knows the Authorization Server's issuer and token endpoint — where the ID-JAG gets redeemed in Phase 3.",
    phase: "bootstrap",
    teachableMoments: [
      "If discovery fails, the Authorization Server's issuer or its well-known metadata URL is usually misconfigured.",
    ],
  },
  user_authentication: {
    title: "Sign In at the IdP",
    summary:
      "The user signs in at the IdP and the Agent receives an ID token — proof of who the user is. MCPJam fakes the IdP here.",
    phase: "sso",
    teachableMoments: [
      "XAA step 1: the user authenticates at the IdP and the Agent receives an ID token (an OpenID Connect identity assertion).",
    ],
  },
  received_identity_assertion: {
    title: "ID Token Ready",
    summary:
      "The Agent holds the ID token, ready to trade it for an ID-JAG. The ID token itself never leaves the IdP.",
    phase: "sso",
    teachableMoments: [
      "The ID token is only an input to the next step — it is never sent to the Authorization Server or the MCP Server.",
      'Naming note: here "identity assertion" means the OpenID Connect ID token. Some IdPs (e.g. Okta) call the ID-JAG itself the "identity assertion" — in this debugger the ID-JAG is the grant minted in Phase 2.',
    ],
  },
  token_exchange_request: {
    title: "Exchange the ID Token for an ID-JAG",
    summary:
      "The Agent trades the ID token back to the IdP for an ID-JAG — a grant scoped to one MCP Server. A test mode can deliberately break it here.",
    phase: "token_exchange",
    teachableMoments: [
      "XAA step 2: the `audience` the Agent sends names the MCP Server's Authorization Server — the issuer discovered (or pre-configured) in Phase 0.",
      "This is where the debugger can forge broken grants to test how the Authorization Server reacts: wrong audience, bad signature, expired, and so on.",
      "On the wire this exchange uses `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`.",
    ],
  },
  received_id_jag: {
    title: "ID-JAG Issued",
    summary: "The IdP returns a signed ID-JAG — the cross-app grant.",
    phase: "token_exchange",
    teachableMoments: [
      "A valid ID-JAG carries `iss`, `sub`, `aud`, `resource`, `client_id`, `jti`, `iat`, and `exp`.",
      "ID-JAG stands for Identity Assertion JWT Authorization Grant — the grant type defined by the XAA spec.",
    ],
  },
  inspect_id_jag: {
    title: "Inspect the ID-JAG",
    summary:
      "Decode the ID-JAG locally to check its claims before sending it to the Authorization Server.",
    phase: "token_exchange",
    teachableMoments: [
      "`aud` must exactly match the Authorization Server's issuer, and `resource` must match the MCP Server's resource identifier.",
      "Use this step to confirm which field a test mode is intentionally breaking.",
    ],
  },
  jwt_bearer_request: {
    title: "Redeem the ID-JAG for an Access Token",
    summary:
      "The Agent presents the ID-JAG to the MCP Server's Authorization Server, which validates it and returns an access token. (RFC 7523 JWT-bearer grant.)",
    phase: "jwt_bearer",
    teachableMoments: [
      "XAA step 3: the Authorization Server checks the ID-JAG's `iss` (a trusted IdP?), `aud` (addressed to me?), and `resource` (the right MCP Server?) before issuing a token.",
      "If this fails, check that the Authorization Server trusts the IdP's signing keys (its JWKS) and supports the JWT-bearer grant.",
      "On the wire this is `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` — match it against your Authorization Server's request logs.",
    ],
  },
  received_access_token: {
    title: "Access Token Received",
    summary:
      "The Authorization Server accepted the ID-JAG and issued an access token for the MCP Server.",
    phase: "jwt_bearer",
    teachableMoments: [
      "Getting a token here proves the Authorization Server accepted the ID-JAG and its policy checks passed.",
    ],
  },
  authenticated_mcp_request: {
    title: "Call the MCP Server with the Token",
    summary:
      "The Agent calls the MCP Server with the access token — the only credential the MCP Server ever sees.",
    phase: "mcp_request",
    teachableMoments: [
      "XAA step 4: this closes the loop — the access token has to work on the real MCP Server, not just at the token endpoint.",
    ],
  },
  complete: {
    title: "Flow Complete",
    summary:
      "The MCP Server accepted the access token. The full cross-app flow worked end to end.",
    phase: "mcp_request",
    teachableMoments: [
      "Switch test modes to probe specific Authorization Server validation paths: wrong audience, bad signature, expired grant, and more.",
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
