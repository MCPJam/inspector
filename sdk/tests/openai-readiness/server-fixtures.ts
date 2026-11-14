/**
 * Wire evidence for a server that satisfies every OpenAI wire lane, shared by
 * the whole-run tests and the trap tests that change one piece of it.
 */

import type { OpenAIReadinessEvidence } from "../../src/openai-readiness/runner.js";

/** A server that satisfies every wire lane. */
export function healthyServerEvidence(): Partial<OpenAIReadinessEvidence> {
  return {
    endpoint: {
      enteredUrl: "https://plugin.example.com/mcp",
      redirectChain: [{ url: "https://plugin.example.com/mcp", status: 200 }],
    },
    auth: {
      enteredUrl: "https://plugin.example.com/mcp",
      unauthenticated: {
        status: 401,
        wwwAuthenticate:
          'Bearer resource_metadata="https://plugin.example.com/.well-known/oauth-protected-resource/mcp"',
        metaWwwAuthenticate: 'Bearer realm="mcp"',
      },
      prm: {
        discoveredVia: "well-known-path-suffixed",
        url: "https://plugin.example.com/.well-known/oauth-protected-resource/mcp",
        document: {
          resource: "https://plugin.example.com/mcp",
          authorization_servers: ["https://auth.example.com"],
        },
      },
      authorizationServers: [
        {
          issuer: "https://auth.example.com",
          metadataUrl:
            "https://auth.example.com/.well-known/oauth-authorization-server",
          document: {
            code_challenge_methods_supported: ["S256"],
            authorization_response_iss_parameter_supported: true,
            registration_endpoint: "https://auth.example.com/register",
            grant_types_supported: ["authorization_code", "refresh_token"],
          },
        },
      ],
      advertisedAuthorizationServerCount: 1,
    },
    domainVerification: {
      url: "https://plugin.example.com/.well-known/openai-apps-challenge",
      status: 200,
      body: "token-placeholder-not-a-secret",
    },
    tools: [
      {
        name: "get_forecast",
        description: "Look up a forecast for a city",
        inputSchema: { type: "object" },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
    ],
    appsUi: { resources: [] },
  };
}
