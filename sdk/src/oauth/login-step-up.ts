import type { AuthChallengeSignal } from "../mcp-client-manager/auth-challenge.js";
import type { NormalizedOAuthConformanceConfig } from "../oauth-conformance/types.js";
import { discoverAuthorizationMetadata } from "./metadata-discovery.js";
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
    const pointer = new URL(challenge.resourceMetadataUrl);
    if (
      pointer.origin !== new URL(config.serverUrl).origin ||
      (pointer.protocol !== "https:" && pointer.protocol !== "http:") ||
      pointer.username ||
      pointer.password ||
      pointer.hash
    ) {
      throw new Error(
        "OAuth step-up received an invalid protected resource metadata URL."
      );
    }
    const discovery = await discoverAuthorizationMetadata(
      {
        url: config.serverUrl,
        protocolVersion: config.protocolVersion,
        headers: config.customHeaders,
        timeoutMs: config.stepTimeout,
        fetchFn: config.fetchFn,
        allowPrivateNetwork: config.allowPrivateNetwork,
      },
      {
        optional: false,
        wwwAuthenticate: `Bearer resource_metadata=${JSON.stringify(pointer.href)}`,
      }
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
