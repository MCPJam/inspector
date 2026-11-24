import { describe, expect, it } from "vitest";
import { discoverClaudeAuthMetadata } from "../../src/claude-readiness/discovery.js";
import { discoverProtectedResourceMetadata } from "../../src/directory-readiness/discovery.js";
import { discoverOAuthServerInfo } from "../../src/oauth/browser-auth.js";
import { discoverAuthorizationMetadata } from "../../src/oauth/metadata-discovery.js";
import { findPublishedResourceMetadata } from "../../src/oauth-conformance/published-resource-metadata.js";
import { discoverOpenAIAuthMetadata } from "../../src/openai-readiness/discovery.js";
import { probeMcpServer } from "../../src/server-probe.js";

// Recorded metadata responses for a handful of server shapes, run through
// every caller of the shared discovery module. The snapshot was recorded from
// each caller's own discovery code, before they were routed through
// `oauth/metadata-candidates.ts` and `oauth/metadata-discovery.ts`, so a change
// to the shared URLs or order shows up as a diff against that behavior. One
// request differs from the recording: Claude readiness used to ask a root
// issuer for `/.well-known/openid-configuration` twice in a row, and the shared
// URL list asks once. Its result is unchanged.

type RecordedResponse = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

interface Fixture {
  name: string;
  serverUrl: string;
  /** The challenge the server answers `initialize` with. */
  challenge: string;
  /** The `resource_metadata` in that challenge, for callers that take it. */
  pointer?: string;
  responses: Record<string, RecordedResponse>;
}

const AS_DOCUMENT = {
  authorization_endpoint: "https://auth.example.com/tenant/authorize",
  token_endpoint: "https://auth.example.com/tenant/token",
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
};

const FIXTURES: Fixture[] = [
  {
    name: "path issuer publishing only OIDC metadata",
    serverUrl: "https://mcp.example.com/mcp",
    challenge: 'Bearer realm="mcp"',
    responses: {
      "GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp": {
        status: 200,
        body: {
          resource: "https://mcp.example.com/mcp",
          authorization_servers: ["https://auth.example.com/tenant"],
          scopes_supported: ["read"],
        },
      },
      "GET https://auth.example.com/.well-known/openid-configuration/tenant": {
        status: 200,
        body: {
          issuer: "https://auth.example.com/tenant",
          ...AS_DOCUMENT,
          client_id_metadata_document_supported: true,
        },
      },
    },
  },
  {
    name: "metadata only at the root, root issuer",
    serverUrl: "https://api.example.com/v1/mcp",
    challenge: 'Bearer error="invalid_token"',
    responses: {
      "GET https://api.example.com/.well-known/oauth-protected-resource": {
        status: 200,
        body: {
          resource: "https://api.example.com/v1/mcp",
          authorization_servers: ["https://api.example.com"],
        },
      },
      "GET https://api.example.com/.well-known/oauth-authorization-server": {
        status: 200,
        body: {
          issuer: "https://api.example.com",
          ...AS_DOCUMENT,
          registration_endpoint: "https://api.example.com/register",
        },
      },
    },
  },
  {
    name: "challenge pointer, authorization server unavailable",
    serverUrl: "https://pointer.example.com/mcp",
    challenge:
      'Bearer resource_metadata="https://pointer.example.com/meta/prm.json"',
    pointer: "https://pointer.example.com/meta/prm.json",
    responses: {
      "GET https://pointer.example.com/meta/prm.json": {
        status: 200,
        body: {
          resource: "https://pointer.example.com/mcp",
          authorization_servers: ["https://idp.example.com"],
        },
      },
      "GET https://idp.example.com/.well-known/oauth-authorization-server": {
        status: 503,
      },
      "GET https://idp.example.com/.well-known/openid-configuration": {
        status: 503,
      },
    },
  },
  {
    name: "pointer to another origin",
    serverUrl: "https://split.example.com/mcp",
    challenge: 'Bearer resource_metadata="https://meta.example.net/prm"',
    pointer: "https://meta.example.net/prm",
    responses: {
      "GET https://split.example.com/.well-known/oauth-protected-resource/mcp":
        {
          status: 200,
          body: {
            resource: "https://split.example.com/mcp",
            authorization_servers: ["https://auth.example.com/tenant"],
          },
        },
      "GET https://auth.example.com/.well-known/oauth-authorization-server/tenant":
        {
          status: 200,
          body: { issuer: "https://auth.example.com/tenant", ...AS_DOCUMENT },
        },
    },
  },
  {
    name: "no metadata anywhere",
    serverUrl: "https://plain.example.com/mcp",
    challenge: "Bearer",
    responses: {},
  },
];

function recordingFetch(fixture: Fixture) {
  const requests: string[] = [];
  const sentHeaderNames = new Set<string>();
  const fetchFn: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    new Headers(init?.headers).forEach((_value, name) =>
      sentHeaderNames.add(name)
    );
    if (method === "POST" && url === fixture.serverUrl) {
      return new Response(null, {
        status: 401,
        statusText: "Unauthorized",
        headers: { "www-authenticate": fixture.challenge },
      });
    }
    const recorded = fixture.responses[`${method} ${url}`] ?? { status: 404 };
    return new Response(
      recorded.body === undefined ? "not found" : JSON.stringify(recorded.body),
      {
        status: recorded.status,
        statusText:
          recorded.status === 200
            ? "OK"
            : recorded.status === 404
              ? "Not Found"
              : "Service Unavailable",
        headers: {
          "content-type":
            recorded.body === undefined ? "text/plain" : "application/json",
          ...recorded.headers,
        },
      }
    );
  };
  return { fetchFn, requests, sentHeaderNames };
}

async function settle<T>(run: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function runCaller<T>(
  fixture: Fixture,
  run: (fetchFn: typeof fetch) => Promise<T>
): Promise<{ result: T | { error: string }; requests: string[] }> {
  const { fetchFn, requests } = recordingFetch(fixture);
  const result = await settle(() => run(fetchFn));
  return { result, requests };
}

async function probe(fixture: Fixture, protocolVersion: "2025-06-18" | "2025-11-25") {
  const { result, requests } = await runCaller(fixture, (fetchFn) =>
    probeMcpServer({ url: fixture.serverUrl, protocolVersion, fetchFn })
  );
  if ("error" in result) return { result, requests };
  return {
    status: result.status,
    oauth: result.oauth,
    attempts: result.transport.attempts.map((attempt) => ({
      name: attempt.name,
      url: attempt.request.url,
      status: attempt.response?.status,
    })),
  };
}

async function collect(fixture: Fixture) {
  const readinessOptions = (fetchFn: typeof fetch) => ({
    enteredUrl: fixture.serverUrl,
    fetchFn,
  });
  return {
    probe: await probe(fixture, "2025-11-25"),
    probeLegacy: await probe(fixture, "2025-06-18"),
    directoryReadiness: await runCaller(fixture, (fetchFn) =>
      discoverProtectedResourceMetadata(
        readinessOptions(fetchFn),
        fixture.pointer
      )
    ),
    claudeReadiness: await runCaller(fixture, (fetchFn) =>
      discoverClaudeAuthMetadata(readinessOptions(fetchFn), fixture.pointer)
    ),
    openaiReadiness: await runCaller(fixture, (fetchFn) =>
      discoverOpenAIAuthMetadata(readinessOptions(fetchFn), fixture.pointer)
    ),
    oauthConformance: await runCaller(fixture, (fetchFn) =>
      findPublishedResourceMetadata(
        { serverUrl: fixture.serverUrl },
        async (request) => {
          const response = await fetchFn(request.url, {
            method: request.method,
            headers: request.headers,
          });
          const text = await response.text();
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {
            // A non-JSON body stays text, as the tracked request reports it.
          }
          return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers: {},
            body,
          };
        }
      )
    ),
    browserAuth: await runCaller(fixture, (fetchFn) =>
      discoverOAuthServerInfo(fixture.serverUrl, {
        resourceMetadataUrl: fixture.pointer,
        fetchFn,
      })
    ),
  };
}

describe("metadata discovery against recorded responses", () => {
  it.each(FIXTURES)("$name", async (fixture) => {
    expect(await collect(fixture)).toMatchSnapshot();
  });

  it("returns the probe's OAuth details when called directly", async () => {
    const fixture = FIXTURES[0];
    const { fetchFn, requests, sentHeaderNames } = recordingFetch(fixture);
    const details = await discoverAuthorizationMetadata(
      {
        url: fixture.serverUrl,
        protocolVersion: "2025-11-25",
        fetchFn,
        headers: { Authorization: "Bearer secret", "X-Api-Key": "secret" },
      },
      { optional: false, wwwAuthenticate: fixture.challenge }
    );
    const probed = await probeMcpServer({
      url: fixture.serverUrl,
      protocolVersion: "2025-11-25",
      fetchFn: recordingFetch(fixture).fetchFn,
    });

    expect(details).toEqual(probed.oauth);
    expect([...sentHeaderNames]).not.toContain("authorization");
    expect([...sentHeaderNames]).not.toContain("x-api-key");
    expect(requests).toEqual([
      "GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      "GET https://auth.example.com/.well-known/oauth-authorization-server/tenant",
      "GET https://auth.example.com/.well-known/openid-configuration/tenant",
    ]);
  });
});
