import type { AuthChallengeSignal } from "../mcp-client-manager/auth-challenge.js";
import type { NormalizedOAuthConformanceConfig } from "../oauth-conformance/types.js";
import { discoverLoginChallengeMetadata } from "./login-challenge-metadata.js";
import type { OAuthFlowState } from "./state-machines/types.js";

export async function detectLoginIssuerMigration(
  config: NormalizedOAuthConformanceConfig,
  state: OAuthFlowState,
  challenge?: AuthChallengeSignal
) {
  if (
    config.protocolVersion !== "2026-07-28" ||
    challenge?.source !== "http_401" ||
    !state.recordedIssuer
  ) {
    return undefined;
  }

  const resourceMetadataUrl = challenge.resourceMetadataUrl;
  const discovery = await discoverLoginChallengeMetadata(
    config,
    resourceMetadataUrl
  );
  const issuer = discovery.authorizationServerMetadata?.issuer;
  const resource = discovery.resourceMetadata?.resource;
  if (
    typeof issuer === "string" &&
    issuer !== state.recordedIssuer &&
    typeof resource === "string" &&
    resource === state.resourceMetadata?.resource
  ) {
    return { issuer, resource, resourceMetadataUrl, discovery };
  }
  return undefined;
}
