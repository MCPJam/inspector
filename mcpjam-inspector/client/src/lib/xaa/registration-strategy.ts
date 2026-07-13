import {
  REGISTRATION_STRATEGIES,
  type RegistrationStrategy,
} from "@/shared/xaa.js";

/**
 * UI copy for the XAA registration-strategy selector, shared by the
 * "Configure Server to Test" modal and the flow's DCR re-register control.
 * The canonical ordering/union lives in the SDK's shared registration
 * vocabulary (re-exported via shared/xaa.ts); this module only owns the
 * human-facing labels and hints.
 */
export const XAA_STRATEGY_LABELS: Record<RegistrationStrategy, string> = {
  preregistered: "Pre-registered client",
  cimd: "Client metadata URL (CIMD)",
  dcr: "Open dynamic registration (DCR)",
};

export const XAA_STRATEGY_HINTS: Record<RegistrationStrategy, string> = {
  preregistered:
    "Uses the client ID and secret you registered at the authorization server yourself.",
  cimd: "Uses MCPJam's hosted metadata URL as the client_id. It does not request a DCR-created client, though the authorization server may fetch/cache the document. This mode is public (no client authentication) and requires advertised CIMD support.",
  dcr: "Creates a real client at this authorization server. MCPJam keeps its credentials only for this browser session; the remote registration may remain after the session ends. Protected DCR requiring an initial access token is not tested.",
};

/** Ordered options for a <Select>, following the canonical strategy order. */
export const XAA_STRATEGY_OPTIONS: Array<{
  value: RegistrationStrategy;
  label: string;
}> = REGISTRATION_STRATEGIES.map((value) => ({
  value,
  label: XAA_STRATEGY_LABELS[value],
}));
