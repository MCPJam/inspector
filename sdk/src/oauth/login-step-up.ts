import type { AuthChallengeSignal } from "../mcp-client-manager/auth-challenge.js";
import type { NormalizedOAuthConformanceConfig } from "../oauth-conformance/types.js";
import { discoverLoginChallengeMetadata } from "./login-challenge-metadata.js";
import {
  computeScopeUnion,
  parseScopeString,
} from "./state-machines/shared/challenges.js";
import type { OAuthFlowState } from "./state-machines/types.js";

export async function resolveLoginStepUpScopes(
  config: NormalizedOAuthConformanceConfig,
  state: OAuthFlowState,
  challenge: AuthChallengeSignal
): Promise<string | undefined> {
  if (challenge.source !== "http_403_insufficient_scope") return;
  const previousScopes = state.requestedScopes ?? [];
  const scopes = computeScopeUnion(
    previousScopes,
    parseScopeString(challenge.requiredScope)
  );
  if (scopes.every((scope) => previousScopes.includes(scope))) return;

  if (challenge.resourceMetadataUrl) {
    const discovery = await discoverLoginChallengeMetadata(
      config,
      challenge.resourceMetadataUrl
    );
    const issuer = state.recordedIssuer;
    if (
      !issuer ||
      discovery.authorizationServerMetadata?.issuer !== issuer ||
      discovery.resourceMetadata?.resource !== state.resourceMetadata?.resource
    ) {
      throw new Error(
        "OAuth step-up could not confirm the original issuer and resource."
      );
    }
  }

  return scopes.join(" ");
}
