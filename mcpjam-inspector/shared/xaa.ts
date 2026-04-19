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
export const XAA_IDP_KID = "xaa-idp-1";

export const NEGATIVE_TEST_MODE_DETAILS: Record<
  NegativeTestMode,
  {
    label: string;
    description: string;
    expectedFailure: string;
  }
> = {
  valid: {
    label: "Valid",
    description: "Issue a well-formed ID-JAG for the happy path.",
    expectedFailure: "No failure expected.",
  },
  bad_signature: {
    label: "Bad Signature",
    description: "Signs the JWT with a throwaway key instead of the published JWKS key.",
    expectedFailure: "Authorization server should reject the signature.",
  },
  wrong_audience: {
    label: "Wrong Audience",
    description: "Sets `aud` to a different authorization server issuer.",
    expectedFailure: "Authorization server should reject the audience.",
  },
  expired: {
    label: "Expired",
    description: "Backdates `exp` so the assertion is already expired.",
    expectedFailure: "Authorization server should reject the expired assertion.",
  },
  missing_claims: {
    label: "Missing Claims",
    description: "Omits `sub` and `resource` from the ID-JAG payload.",
    expectedFailure: "Authorization server should reject missing required claims.",
  },
  invalid_type_header: {
    label: "Invalid `typ` Header",
    description: "Uses `JWT` instead of `oauth-id-jag+jwt` in the JOSE header.",
    expectedFailure: "Authorization server should reject the JWT type.",
  },
  wrong_issuer: {
    label: "Wrong Issuer",
    description: "Sets `iss` to an untrusted issuer value.",
    expectedFailure: "Authorization server should reject the issuer.",
  },
  resource_mismatch: {
    label: "Resource Mismatch",
    description: "Sets `resource` to a different MCP server resource identifier.",
    expectedFailure: "Authorization server should reject the resource claim.",
  },
  client_id_mismatch: {
    label: "Client ID Mismatch",
    description: "Sets `client_id` to a different OAuth client.",
    expectedFailure: "Authorization server should reject the client identity.",
  },
  unknown_kid: {
    label: "Unknown `kid`",
    description: "Uses a JOSE `kid` value that does not exist in JWKS.",
    expectedFailure: "Authorization server should fail JWKS key lookup.",
  },
  unknown_sub: {
    label: "Unknown Subject",
    description: "Sets `sub` to an unmapped user identifier.",
    expectedFailure: "Authorization server should reject the unknown subject.",
  },
  scope_denial: {
    label: "Scope Denial",
    description: "Requests privileged scopes the mock user should not receive.",
    expectedFailure: "Authorization server should reject the requested scopes.",
  },
};

export function isNegativeTestMode(value: unknown): value is NegativeTestMode {
  return (
    typeof value === "string" &&
    (NEGATIVE_TEST_MODES as readonly string[]).includes(value)
  );
}
