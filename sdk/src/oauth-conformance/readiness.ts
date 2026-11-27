import { OAUTH_READINESS_CATALOG } from "../conformance-catalog.js";
import type { OAuthFlowState } from "../oauth/state-machines/types.js";
import type {
  MCPOAuthPassedAdvice,
  MCPOAuthReadinessWarning,
  NormalizedOAuthConformanceConfig,
} from "./types.js";

/**
 * The OAuth suite's advice, read off the metadata discovery already fetched,
 * so it sends nothing of its own. An authorization server that does not
 * advertise RFC 9207 `iss` leaves clients unable to spot a mix-up attack.
 * Spread into the result: a warning, a pass, or nothing when the run fetched
 * no authorization server metadata or left the advice out.
 */
export function oauthReadiness(
  config: NormalizedOAuthConformanceConfig,
  state: OAuthFlowState
): {
  readiness?: MCPOAuthReadinessWarning[];
  passedAdvice?: MCPOAuthPassedAdvice[];
} {
  const id = "readiness-oauth-iss-advertised";
  const metadata = state.authorizationServerMetadata;
  if (!metadata || (config.readinessIds && !config.readinessIds.includes(id))) {
    return {};
  }
  const title = OAUTH_READINESS_CATALOG[id].title;
  if (metadata.authorization_response_iss_parameter_supported === true) {
    return { passedAdvice: [{ id, title, specStrength: "SHOULD" }] };
  }
  const issuer = state.authorizationServerUrl ?? metadata.issuer;
  return {
    readiness: [
      {
        id,
        title,
        severity: "warning",
        specStrength: "SHOULD",
        message: `Authorization server ${issuer} does not advertise authorization_response_iss_parameter_supported; emitting iss lets clients detect authorization-server mix-up attacks`,
        details: { issuer },
      },
    ],
  };
}
