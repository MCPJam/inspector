// Versioned XAA (Cross-App Access) grant / token URNs and JOSE constants.
//
// Pinned to draft-ietf-oauth-identity-assertion-authz-grant-04. The draft is
// still unstable, so every wire URN the three-leg flow depends on lives here in
// one place — when the draft revs, this module is the only one to update.
//
// The three legs use TWO different grant types (the most common implementation
// mistake is conflating them):
//   leg 2 — mint the id-jag at the IdP  -> token-exchange (RFC 8693)
//   leg 3 — redeem the id-jag at the AS -> jwt-bearer     (RFC 7523)

/** The XAA draft these constants are verified against. */
export const XAA_DRAFT_VERSION =
  "draft-ietf-oauth-identity-assertion-authz-grant-04";

// --- Grant types -----------------------------------------------------------

/** Leg 2: RFC 8693 token-exchange grant (id_token -> id-jag at the IdP). */
export const TOKEN_EXCHANGE_GRANT =
  "urn:ietf:params:oauth:grant-type:token-exchange";

/** Leg 3: RFC 7523 jwt-bearer grant (id-jag -> access token at the resource AS). */
export const JWT_BEARER_GRANT =
  "urn:ietf:params:oauth:grant-type:jwt-bearer";

// --- Token types -----------------------------------------------------------

/** The cross-app assertion type. Leg 2 requests and returns this. */
export const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";

/** Leg 2 `subject_token_type` when the subject is an OIDC id_token. */
export const ID_TOKEN_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";

/** Leg 2 `subject_token_type` when the subject is a refresh token (draft §4.3.2). */
export const REFRESH_TOKEN_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:refresh_token";

// --- JOSE ------------------------------------------------------------------

/**
 * The JOSE header `typ` that identifies an id-jag assertion. The resource AS
 * uses this as its validation discriminator (draft requires it).
 */
export const ID_JAG_JWT_TYP = "oauth-id-jag+jwt";

// --- IdP selector axis -----------------------------------------------------

/**
 * Which identity provider mints the XAA assertion. This is orthogonal to
 * `authServerMode` (which selects the resource's authorization server for
 * leg 3) — do NOT conflate them.
 *   - "mcpjam":   the built-in test IdP self-mints the id-jag; legs 1+2 skipped.
 *   - "external": a real OIDC IdP (Okta, Auth0, …) mints it via legs 1+2.
 */
export const XAA_IDP_MODES = ["mcpjam", "external"] as const;
export type XaaIdpMode = (typeof XAA_IDP_MODES)[number];

/** Default IdP mode — the built-in test IdP, so the existing path is unchanged. */
export const DEFAULT_XAA_IDP_MODE: XaaIdpMode = "mcpjam";

// --- Helpers ---------------------------------------------------------------

/**
 * Case-insensitive check that a token-exchange response's `issued_token_type`
 * is the id-jag type. Casing varies across IdPs, so never compare with `===`.
 */
export function isIdJagTokenType(value: string | undefined | null): boolean {
  return (value ?? "").toLowerCase() === ID_JAG_TOKEN_TYPE;
}
