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
  isPolicyDependentNegativeTestMode,
  REGISTRATION_STRATEGIES,
  DEFAULT_REGISTRATION_STRATEGY,
  normalizeRegistrationStrategy,
  normalizeRegistrationMode,
  normalizeAuthMethod,
  IDENTITY_ASSERTION_FORMATS,
  DEFAULT_IDENTITY_ASSERTION_FORMAT,
  normalizeIdentityAssertionFormat,
  SUBJECT_IDENTIFIER_FORMATS,
  DEFAULT_SUBJECT_IDENTIFIER_FORMAT,
  normalizeSubjectIdentifierFormat,
  SAML2_TOKEN_TYPE,
  isLoopbackClientMetadataUrl,
} from "@mcpjam/sdk/browser";
export type {
  NegativeTestMode,
  RegistrationStrategy,
  RegistrationMode,
  AuthMethod,
  IdentityAssertionFormat,
  SubjectIdentifierFormat,
} from "@mcpjam/sdk/browser";

/**
 * Client-authentication method for a CIMD run (XAA-debugger-only vocabulary).
 * Public CIMD is `none`; confidential CIMD is `private_key_jwt` — the debugger
 * holds a client key (server-side) and signs a client_assertion, addressing the
 * client via the confidential reflector document URL. Only meaningful when the
 * registration strategy is `cimd`.
 */
export const XAA_CLIENT_AUTH_METHODS = ["none", "private_key_jwt"] as const;
export type XaaClientAuthMethod = (typeof XAA_CLIENT_AUTH_METHODS)[number];
export const DEFAULT_XAA_CLIENT_AUTH: XaaClientAuthMethod = "none";

/** Narrow a bare wire value to a known method; undefined ⇒ fall back to public. */
export function normalizeXaaClientAuth(
  value: unknown,
): XaaClientAuthMethod | undefined {
  return typeof value === "string" &&
    (XAA_CLIENT_AUTH_METHODS as readonly string[]).includes(value)
    ? (value as XaaClientAuthMethod)
    : undefined;
}

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
