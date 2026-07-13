// Human-facing descriptions for each XAA negative-test mode. The state machine
// consumes `expectedFailure` to explain a probe's expected outcome, and the
// inspector renders `label`/`description`, so this table lives in the SDK
// alongside the mode enum (the single source of truth) rather than in the client.
import type { NegativeTestMode } from "./constants.js";

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
    description:
      "Issues a correct ID-JAG. Your server should accept this one and mint an access token.",
    expectedFailure: "No failure expected.",
  },
  bad_signature: {
    label: "Bad Signature",
    description:
      "Signs the token with the wrong key. A correct server checks the signature against your published JWKS and rejects it.",
    expectedFailure: "Authorization server should reject the signature.",
  },
  wrong_audience: {
    label: "Wrong Audience",
    description:
      "Addresses the token to a different server (the `aud` claim). A correct server only accepts tokens addressed to its own issuer.",
    expectedFailure: "Authorization server should reject the audience.",
  },
  expired: {
    label: "Expired",
    description:
      "Backdates the token so it is already expired. A correct server rejects tokens past their `exp` time.",
    expectedFailure:
      "Authorization server should reject the expired assertion.",
  },
  missing_claims: {
    label: "Missing Claims",
    description:
      "Drops required claims (`sub` and `jti`). A correct server rejects a token that is missing required fields.",
    expectedFailure:
      "Authorization server should reject missing required claims.",
  },
  invalid_type_header: {
    label: "Invalid `typ` Header",
    description:
      "Labels the token as a plain `JWT` instead of `oauth-id-jag+jwt`. A correct server checks the header type and rejects the wrong one.",
    expectedFailure: "Authorization server should reject the JWT type.",
  },
  wrong_issuer: {
    label: "Wrong Issuer",
    description:
      "Claims the token came from an issuer you don't trust. A correct server only accepts issuers it is configured to trust.",
    expectedFailure: "Authorization server should reject the issuer.",
  },
  resource_mismatch: {
    label: "Resource Mismatch",
    description:
      "Points the token at a different resource. A correct server checks the `resource` matches the MCP server it protects.",
    expectedFailure: "Authorization server should reject the resource claim.",
  },
  client_id_mismatch: {
    label: "Client ID Mismatch",
    description:
      "Names a different OAuth client than the one making the request. A correct server rejects the `client_id` mismatch.",
    expectedFailure: "Authorization server should reject the client identity.",
  },
  unknown_kid: {
    label: "Unknown `kid`",
    description:
      "References a signing key (`kid`) that isn't in your published JWKS. A correct server can't find the key and rejects the token.",
    expectedFailure: "Authorization server should fail JWKS key lookup.",
  },
  unknown_sub: {
    label: "Unknown Subject",
    description:
      "Names a user (`sub`) the server has never seen. A correct server rejects an unknown subject.",
    expectedFailure: "Authorization server should reject the unknown subject.",
  },
  scope_denial: {
    label: "Scope Denial",
    description:
      "Requests high-privilege scopes the mock user shouldn't get. A correct server refuses to grant them.",
    expectedFailure: "Authorization server should reject the requested scopes.",
  },
};
