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
    title: "Find the MCP Server's Authorization Server",
    specStep: null,
    blurb:
      "Setup that runs before XAA proper. The Agent asks the MCP Server which Authorization Server protects it, then looks up where that server hands out tokens. The XAA spec assumes the Agent already knows this, so it's numbered Phase 0 — and skipped entirely when you've pre-configured the Authorization Server. The Authorization Server's issuer found here is reused later so the grant is addressed to the right server. (Uses the standard OAuth discovery specs, RFC 9728 and 8414.)",
  },
  sso: {
    title: "Sign in and get an ID token",
    specStep: 1,
    blurb:
      "The user logs in at their IdP — the identity provider, i.e. the company login — and the Agent comes away with an ID token: proof of who the user is. This happens once per session and isn't tied to any MCP server yet. In this debugger MCPJam plays the IdP, so the login is simulated.",
  },
  token_exchange: {
    title: "Exchange the ID token for an ID-JAG",
    specStep: 2,
    blurb:
      "The Agent hands the ID token back to the IdP and gets an ID-JAG in return — a short-lived grant that means “this user, for this one MCP server.” The Agent tells the IdP which Authorization Server the grant is for (the one found in Phase 0). The ID token itself never travels any further. (On the wire this is an RFC 8693 token exchange.)",
  },
  jwt_bearer: {
    title: "Exchange the ID-JAG for an access token",
    specStep: 3,
    blurb:
      "The Agent presents the ID-JAG to the MCP server's Authorization Server. That server checks the grant came from an IdP it trusts, is addressed to itself, and names the right MCP Server — then issues an access token the Agent can actually use. (On the wire this is an RFC 7523 JWT-bearer grant.)",
  },
  mcp_request: {
    title: "Call the MCP Server with the access token",
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
      "For this to work, the Authorization Server has to trust the IdP, and the grant has to name both that Authorization Server and the right MCP Server.",
    ],
  },
  discover_resource_metadata: {
    title: "Ask the MCP Server Who Guards It",
    summary:
      "The Agent asks the MCP Server which Authorization Server protects it. (RFC 9728 protected-resource metadata.)",
    phase: "bootstrap",
    teachableMoments: [
      "This is how the Agent learns which Authorization Server can issue tokens for the MCP Server.",
    ],
  },
  received_resource_metadata: {
    title: "MCP Server Names Its Authorization Server",
    summary:
      "The MCP Server replies with its resource identifier and the Authorization Server that guards it.",
    phase: "bootstrap",
    teachableMoments: [
      "Both values get reused later: the grant is addressed to this Authorization Server and tagged for this MCP Server.",
    ],
  },
  discover_authz_metadata: {
    title: "Look Up the Authorization Server's Token Endpoint",
    summary:
      "The Agent looks up where the Authorization Server hands out tokens. (RFC 8414 / OpenID Connect discovery.)",
    phase: "bootstrap",
    teachableMoments: [
      "A common XAA mistake: the grant must be addressed to this server's issuer URL, not its token endpoint.",
    ],
  },
  received_authz_metadata: {
    title: "Authorization Server Details Received",
    summary:
      "The Agent now knows the Authorization Server's issuer and token endpoint — where the ID-JAG gets redeemed in Phase 3.",
    phase: "bootstrap",
    teachableMoments: [
      "If discovery fails, the Authorization Server's issuer or its metadata URL is usually misconfigured.",
    ],
  },
  user_authentication: {
    title: "Sign In at the IdP",
    summary:
      "The user signs in at the IdP and the Agent receives an ID token — proof of who the user is. MCPJam fakes the IdP here.",
    phase: "sso",
    teachableMoments: [
      "This login just proves who the user is — it isn't tied to any MCP server yet.",
    ],
  },
  received_identity_assertion: {
    title: "ID Token Ready",
    summary:
      "The Agent holds the ID token, ready to trade it for an ID-JAG. The ID token itself never leaves the IdP.",
    phase: "sso",
    teachableMoments: [
      "The ID token is only used to get the next token — it's never sent to the Authorization Server or the MCP Server.",
    ],
  },
  token_exchange_request: {
    title: "Exchange the ID Token for an ID-JAG",
    summary:
      "The Agent trades the ID token back to the IdP for an ID-JAG — a grant scoped to one MCP Server. A test mode can deliberately break it here.",
    phase: "token_exchange",
    teachableMoments: [
      "The Agent tells the IdP which Authorization Server the grant is for — that becomes the grant's audience.",
      "This is the step where a test mode can forge a broken grant to see how your Authorization Server reacts.",
    ],
  },
  received_id_jag: {
    title: "ID-JAG Issued",
    summary: "The IdP returns a signed ID-JAG — the cross-app grant.",
    phase: "token_exchange",
    teachableMoments: [
      "An ID-JAG is a signed token saying who the user is, which Authorization Server it's for, and which MCP Server it unlocks.",
      "ID-JAG stands for Identity Assertion JWT Authorization Grant — the grant type defined by the XAA spec.",
    ],
  },
  inspect_id_jag: {
    title: "Inspect the ID-JAG",
    summary:
      "Decode the ID-JAG locally to check its claims before sending it to the Authorization Server.",
    phase: "token_exchange",
    teachableMoments: [
      "Check the grant is addressed to the right Authorization Server and names the right MCP Server before sending it.",
    ],
  },
  jwt_bearer_request: {
    title: "Exchange the ID-JAG for an Access Token",
    summary:
      "The Agent presents the ID-JAG to the MCP Server's Authorization Server, which validates it and returns an access token. (RFC 7523 JWT-bearer grant.)",
    phase: "jwt_bearer",
    teachableMoments: [
      "The Authorization Server checks the grant came from a trusted IdP, is addressed to itself, and names the right MCP Server before issuing a token.",
      "If this fails, the Authorization Server probably doesn't trust the IdP's signing keys yet, or doesn't support this grant type.",
    ],
  },
  received_access_token: {
    title: "Access Token Received",
    summary:
      "The Authorization Server accepted the ID-JAG and issued an access token for the MCP Server.",
    phase: "jwt_bearer",
    teachableMoments: [
      "Getting a token here means the Authorization Server accepted the grant and its checks passed.",
    ],
  },
  authenticated_mcp_request: {
    title: "Call the MCP Server with the Token",
    summary:
      "The Agent calls the MCP Server with the access token — the only credential the MCP Server ever sees.",
    phase: "mcp_request",
    teachableMoments: [
      "This proves the token actually works on the MCP Server — not just at the Authorization Server.",
    ],
  },
  complete: {
    title: "Flow Complete",
    summary:
      "The MCP Server accepted the access token. The full cross-app flow worked end to end.",
    phase: "mcp_request",
    teachableMoments: [
      "Try the test modes to see how your Authorization Server handles broken grants: wrong audience, bad signature, expired, and more.",
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
