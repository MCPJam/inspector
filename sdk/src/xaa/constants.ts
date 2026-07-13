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

// Two INDEPENDENT identity axes (draft-ietf-oauth-identity-assertion-authz-
// grant-04). Input axis: which assertion format the mock IdP mints and which
// subject_token_type the exchange presents (§4.3). Output axis: whether the
// ID-JAG carries a `sub_id` claim for a SAML-resolving RAS (§3.2.2). A client
// may present an OIDC ID token and still receive a saml-nameid `sub_id`, and
// vice versa — never conflate them.

/** Input axis: the identity assertion format minted at `/authenticate`. */
export const IDENTITY_ASSERTION_FORMATS = ["oidc", "saml"] as const;

export type IdentityAssertionFormat =
  (typeof IDENTITY_ASSERTION_FORMATS)[number];

export const DEFAULT_IDENTITY_ASSERTION_FORMAT: IdentityAssertionFormat =
  "oidc";

/**
 * Narrow an arbitrary persisted/wire value to a known assertion format.
 * Returns undefined for anything unrecognized so callers fall back to the
 * safe default rather than trusting the wire.
 */
export function normalizeIdentityAssertionFormat(
  value: unknown
): IdentityAssertionFormat | undefined {
  return typeof value === "string" &&
    (IDENTITY_ASSERTION_FORMATS as readonly string[]).includes(value)
    ? (value as IdentityAssertionFormat)
    : undefined;
}

/** Output axis: how the ID-JAG identifies the subject to the target RAS. */
export const SUBJECT_IDENTIFIER_FORMATS = ["oauth-sub", "saml-nameid"] as const;

export type SubjectIdentifierFormat =
  (typeof SUBJECT_IDENTIFIER_FORMATS)[number];

export const DEFAULT_SUBJECT_IDENTIFIER_FORMAT: SubjectIdentifierFormat =
  "oauth-sub";

/** Like {@link normalizeIdentityAssertionFormat}, for the output axis. */
export function normalizeSubjectIdentifierFormat(
  value: unknown
): SubjectIdentifierFormat | undefined {
  return typeof value === "string" &&
    (SUBJECT_IDENTIFIER_FORMATS as readonly string[]).includes(value)
    ? (value as SubjectIdentifierFormat)
    : undefined;
}
