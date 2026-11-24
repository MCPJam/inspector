import { normalizeHeaders, performRequest } from "../probe-http.js";
import {
  discoverAuthorizationMetadata,
  type AuthorizationMetadataDiscoveryConfig,
} from "./metadata-discovery.js";
import { buildStatelessVerifyRequestBody } from "./state-machines/shared/initialize.js";
import { parseBearerAuthenticateParameters } from "./state-machines/shared/challenges.js";

import type { OAuthAuthMode } from "./state-machines/types.js";

export async function discoverStatelessLoginMetadata(
  config: AuthorizationMetadataDiscoveryConfig,
  authMode?: OAuthAuthMode
) {
  const metadata = await discoverAuthorizationMetadata(config, {
    optional: false,
  });
  if (metadata.resourceMetadata) return metadata;

  // Some servers publish protected resource metadata only at the URL in a 401.
  const protocolVersion = "2026-07-28";
  const response = await performRequest(
    config.fetchFn ?? fetch,
    {
      name: "stateless_tools_list",
      request: {
        method: "POST",
        url: config.url,
        headers: {
          ...normalizeHeaders(config.headers),
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": protocolVersion,
          "mcp-method": "tools/list",
        },
        body: buildStatelessVerifyRequestBody({
          protocolVersion,
          authMode,
          clientName: "MCPJam Inspector",
          clientVersion: "1.0.0",
          id: 1,
        }),
      },
      durationMs: 0,
    },
    config.timeoutMs
  );
  const challenge = response.headers["www-authenticate"];
  if (
    (response.status === 401 || response.status === 403) &&
    parseBearerAuthenticateParameters(challenge).resource_metadata
  ) {
    return discoverAuthorizationMetadata(config, {
      optional: false,
      wwwAuthenticate: challenge,
    });
  }
  return metadata;
}
