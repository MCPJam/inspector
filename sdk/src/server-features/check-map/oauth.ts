import type { OAuthCheckFeatureMap } from "./types.js";

/**
 * OAuth suite check → core authorization and transport feature ids. Checks of
 * plain OAuth 2.0 endpoint behavior, and MCPJam's own profile heuristics,
 * have no MCP feature row and are excluded.
 */
export const OAUTH_CHECK_FEATURES = {
  // Profile checks grade MCPJam heuristics about a profile endpoint, not an
  // MCP authorization requirement.
  verify_profile_shape: "excluded",
  verify_profile_stable: "excluded",
  verify_profile_id_opaque: "excluded",
  verify_profile_identity_stable_across_flows: "excluded",
  verify_profile_stable_after_refresh: "excluded",
  // A pass needs a working registration endpoint that enforces the redirect
  // URI rules the 2026-07-28 revision ties to application_type.
  oauth_dcr_http_redirect_uri: ["auth.dcr", "auth.dcr-application-type"],
  // Token endpoint client authentication is OAuth 2.0 itself (RFC 6749).
  oauth_invalid_client: "excluded",
  // Open redirect protection at the authorization endpoint is OAuth 2.0
  // security guidance with no catalog row of its own.
  oauth_invalid_authorize_redirect: "excluded",
  oauth_invalid_token: ["auth.token-validation"],
  // Redirect URI matching at the token endpoint is OAuth 2.0 itself.
  oauth_invalid_redirect: "excluded",
  // Token response fields are OAuth 2.0 itself.
  oauth_token_format: "excluded",
  // A 401 with a Bearer challenge shows the server protects requests; the
  // resource_metadata parameter is graded by the next check.
  oauth_unauthenticated_challenge: ["auth.oauth"],
  oauth_resource_metadata_challenge: ["auth.resource-metadata-challenge"],
  oauth_stale_session_rejection: ["transport-behavior.session-expiry"],
} as const satisfies OAuthCheckFeatureMap;
