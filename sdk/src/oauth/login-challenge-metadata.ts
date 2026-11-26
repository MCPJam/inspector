import type { NormalizedOAuthConformanceConfig } from "../oauth-conformance/types.js";
import { discoverAuthorizationMetadata } from "./metadata-discovery.js";

export function discoverLoginChallengeMetadata(
  config: NormalizedOAuthConformanceConfig,
  resourceMetadataUrl?: string
) {
  let wwwAuthenticate: string | undefined;
  if (resourceMetadataUrl) {
    const pointer = new URL(resourceMetadataUrl);
    if (
      (pointer.protocol !== "https:" && pointer.protocol !== "http:") ||
      pointer.username ||
      pointer.password ||
      pointer.hash
    ) {
      throw new Error(
        "OAuth received an invalid protected resource metadata URL."
      );
    }
    wwwAuthenticate = `Bearer resource_metadata=${JSON.stringify(pointer.href)}`;
  }
  return discoverAuthorizationMetadata(
    {
      url: config.serverUrl,
      protocolVersion: config.protocolVersion,
      headers: config.customHeaders,
      timeoutMs: config.stepTimeout,
      fetchFn: config.fetchFn,
      allowPrivateNetwork: config.allowPrivateNetwork,
    },
    { optional: false, wwwAuthenticate }
  );
}
