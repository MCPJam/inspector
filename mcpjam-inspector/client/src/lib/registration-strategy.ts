import {
  REGISTRATION_STRATEGIES,
  type RegistrationMode,
  type RegistrationStrategy,
} from "@/shared/xaa.js";

/**
 * UI copy for the unified registration-mode/strategy selectors. The canonical
 * union + ordering live in the SDK's registration vocabulary (re-exported via
 * shared/xaa.ts); this module owns only the human-facing labels and hints.
 *
 * Two surfaces share the vocabulary but keep their own wording:
 * - Connect page ("Registration Strategy" under Advanced Settings): modes,
 *   including "auto".
 * - XAA debugger ("Configure Server to Test" modal + DCR re-register
 *   control): explicit strategies only — a debugger run pins one strategy.
 */

export const REGISTRATION_MODE_LABELS: Record<RegistrationMode, string> = {
  auto: "Automatic",
  preregistered: "Preregistration (Client Credentials)",
  cimd: "Client ID Metadata Documents (CIMD)",
  dcr: "Dynamic Client Registration (DCR)",
};

/** Ordered options for the Connect page's mode <Select> (auto first). */
export const REGISTRATION_MODE_OPTIONS: Array<{
  value: RegistrationMode;
  label: string;
}> = (["auto", ...REGISTRATION_STRATEGIES] as RegistrationMode[]).map(
  (value) => ({
    value,
    label: REGISTRATION_MODE_LABELS[value],
  }),
);

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

/** Ordered options for the XAA debugger <Select>, canonical strategy order. */
export const XAA_STRATEGY_OPTIONS: Array<{
  value: RegistrationStrategy;
  label: string;
}> = REGISTRATION_STRATEGIES.map((value) => ({
  value,
  label: XAA_STRATEGY_LABELS[value],
}));
