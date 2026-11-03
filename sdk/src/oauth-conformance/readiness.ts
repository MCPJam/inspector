import { OAUTH_READINESS_CATALOG } from "../conformance-catalog.js";
import type { OAuthFlowState } from "../oauth/state-machines/types.js";
import type {
  MCPOAuthReadinessWarning,
  NormalizedOAuthConformanceConfig,
} from "./types.js";

/**
 * The OAuth suite's advice, read off the metadata discovery already fetched,
 * so it sends nothing of its own. An authorization server that does not
 * advertise RFC 9207 `iss` leaves clients unable to spot a mix-up attack.
 * Spread into the result: absent when there is no advice.
 */
export function oauthReadiness(
  config: NormalizedOAuthConformanceConfig,
  state: OAuthFlowState
): { readiness?: MCPOAuthReadinessWarning[] } {
  const id = "readiness-oauth-iss-advertised";
  const metadata = state.authorizationServerMetadata;
  if (
    !metadata ||
    (config.readinessIds && !config.readinessIds.includes(id)) ||
    metadata.authorization_response_iss_parameter_supported === true
  ) {
    return {};
  }
  const issuer = state.authorizationServerUrl ?? metadata.issuer;
  return {
    readiness: [
      {
        id,
        title: OAUTH_READINESS_CATALOG[id].title,
        severity: "warning",
        specStrength: "RECOMMENDED",
        message: `Authorization server ${issuer} does not advertise authorization_response_iss_parameter_supported; emitting iss lets clients detect authorization-server mix-up attacks`,
        details: { issuer },
      },
    ],
  };
}
