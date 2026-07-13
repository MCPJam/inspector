// XAA/ID-JAG primitives are single-sourced in @mcpjam/sdk. This module
// re-exports them from the browser-safe entry (importable from both the client
// and the server) so the inspector's importers keep their `shared/xaa.js` path.
// The only thing it still owns is the UI-only `NegativeTestDiff` scorecard type.
export {
  NEGATIVE_TEST_MODES,
  DEFAULT_NEGATIVE_TEST_MODE,
  XAA_IDP_KID,
  isNegativeTestMode,
  NEGATIVE_TEST_MODE_DETAILS,
  REGISTRATION_STRATEGIES,
  DEFAULT_REGISTRATION_STRATEGY,
  normalizeRegistrationStrategy,
  normalizeRegistrationMode,
  normalizeAuthMethod,
} from "@mcpjam/sdk/browser";
export type {
  NegativeTestMode,
  RegistrationStrategy,
  RegistrationMode,
  AuthMethod,
} from "@mcpjam/sdk/browser";

/**
 * The single field a negative test tampered with, paired with what a valid
 * assertion would have carried. Lets the scorecard show "sent X, expected Y"
 * so a developer can see exactly which claim their server caught (or missed).
 */
export interface NegativeTestDiff {
  /** The claim or header field the broken assertion changed (e.g. `aud`). */
  field: string;
  /** What the broken assertion actually carried. */
  sent: string;
  /** What a valid assertion would carry. */
  expected: string;
}
