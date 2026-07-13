// Stable XAA/ID-JAG spec constants used by the mint. Small, byte-identical
// primitives (a key id + the negative-test enum); the inspector keeps its own
// copy in `shared/xaa.ts` alongside UI-only description tables, and both must
// hold the same literal values.

/** JWKS `kid` the mock IdP signs with and publishes. */
export const XAA_IDP_KID = "xaa-idp-1";

/** The tamper modes the debugger can apply when minting a broken ID-JAG. */
export const NEGATIVE_TEST_MODES = [
  "valid",
  "bad_signature",
  "wrong_audience",
  "expired",
  "missing_claims",
  "invalid_type_header",
  "wrong_issuer",
  "resource_mismatch",
  "client_id_mismatch",
  "unknown_kid",
  "unknown_sub",
  "scope_denial",
] as const;

export type NegativeTestMode = (typeof NEGATIVE_TEST_MODES)[number];

export const DEFAULT_NEGATIVE_TEST_MODE: NegativeTestMode = "valid";

export function isNegativeTestMode(value: unknown): value is NegativeTestMode {
  return (
    typeof value === "string" &&
    (NEGATIVE_TEST_MODES as readonly string[]).includes(value)
  );
}
