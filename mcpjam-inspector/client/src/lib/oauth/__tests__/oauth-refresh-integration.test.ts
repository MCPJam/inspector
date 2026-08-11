/**
 * The joint the #3865 bug lived in, wired for real.
 *
 * Every other OAuth test mocks one side of the executor ↔ state-machine seam:
 * the inspector's tests mock `@mcpjam/sdk/browser`, and the SDK's tests stub the
 * executor. Nobody ran the real pair, which is exactly why a redactor applied
 * to live response bodies reached production.
 *
 * This test mocks only the two things that cannot exist in a unit process:
 *   - `@/lib/config`, pinned to the HOSTED configuration that exhibited the bug
 *     (`SANITIZE_OAUTH_TRACES` is derived from `HOSTED_MODE`, so the failure is
 *     invisible locally)
 *   - `authFetch`, replaced by a forwarder that performs the same unwrap the
 *     real `/api/web/oauth` proxy performs and then makes a real request
 *
 * `@mcpjam/sdk/browser` is deliberately NOT mocked. `client/vitest.config.ts`
 * aliases it to SDK source, so the real state machines run.
 *
 * The oracle is the fixture, not our own options object: its `/mcp` returns 401
 * unless `Authorization` matches byte-for-byte, and every wire assertion below
 * reads the requests the fixture actually received.
 */

import http from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FAKE_OAUTH_ACCESS_TOKEN,
  FAKE_OAUTH_AUTH_CODE,
  startFakeOAuthMcpServer,
  type FakeMcpRequestRecord,
  type FakeMcpServer,
  type FakeOAuthMcpServerOptions,
} from "../../../../../e2e/fixtures/fake-oauth-mcp-server";

vi.mock("@/lib/config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/config")>(
    "@/lib/config",
  );
  return { ...actual, HOSTED_MODE: true, SANITIZE_OAUTH_TRACES: true };
});

const mockAuthFetch = vi.fn();
vi.mock("@/lib/session-token", () => ({ authFetch: mockAuthFetch }));

const UPSTREAM_URL_HEADER = "x-mcpjam-oauth-upstream-url";

/**
 * The shared test setup replaces `global.fetch` with a stub, so the forwarder
 * cannot use it — the fixture would never see a request and every response
 * would be an empty 200. Talk to the fixture over `node:http` directly.
 */
function httpRequest(
  target: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  text: string;
}> {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers: {
          ...(init.headers ?? {}),
          ...(init.body != null
            ? { "content-length": String(Buffer.byteLength(init.body)) }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? "",
            headers: Object.fromEntries(
              Object.entries(response.headers).flatMap(([key, value]) =>
                typeof value === "string" ? [[key, value] as const] : [],
              ),
            ),
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    if (init.body != null) {
      request.write(init.body);
    }
    request.end();
  });
}

/**
 * Restore a working `fetch` for loopback targets.
 *
 * `src/test/setup.ts` replaces `global.fetch` with a stub that answers every
 * request with an empty 200. `mcp-oauth.ts` captures `window.fetch` at module
 * load, so the unauthenticated `/mcp` probe that starts the flow would never
 * reach the fixture and would read as "this server does not need OAuth". This
 * is un-mocking, not mocking: non-http targets still fall through to the stub.
 */
const stubbedFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const target =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  if (!/^http:\/\/127\.0\.0\.1:/.test(target)) {
    return stubbedFetch(input as RequestInfo, init);
  }

  const headers = init?.headers
    ? Object.fromEntries(new Headers(init.headers as HeadersInit).entries())
    : {};
  const upstream = await httpRequest(target, {
    method: init?.method ?? "GET",
    headers,
    body: typeof init?.body === "string" ? init.body : undefined,
  });
  return new Response(upstream.text, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}) as typeof fetch;
(window as unknown as { fetch: typeof fetch }).fetch = globalThis.fetch;

/**
 * Stand in for `/api/web/oauth`. Mirrors the real proxy's two shapes:
 * `GET /metadata?url=…` returns the upstream response as-is, and
 * `POST /proxy` returns a `{status, statusText, headers, body}` envelope.
 *
 * Notably it forwards the request VERBATIM. Nothing here redacts, so anything
 * the trace shows was redacted by the code under test.
 */
function installProxyForwarder() {
  mockAuthFetch.mockImplementation(
    async (input: string, init?: RequestInit) => {
      const path = String(input);

      if (path.includes("/metadata?url=")) {
        const target = decodeURIComponent(path.split("url=")[1]!);
        const upstream = await httpRequest(target, { method: "GET" });
        return new Response(upstream.text, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: {
            "content-type": upstream.headers["content-type"] ?? "application/json",
            [UPSTREAM_URL_HEADER]: target,
          },
        });
      }

      if (path.endsWith("/proxy")) {
        const payload = JSON.parse(String(init?.body)) as {
          url: string;
          method: string;
          headers?: Record<string, string>;
          body?: unknown;
        };
        const headers = { ...(payload.headers ?? {}) };
        const contentType =
          headers["Content-Type"] ?? headers["content-type"] ?? "";
        let body: string | undefined;
        if (payload.body != null && payload.method !== "GET") {
          body = contentType.includes("application/x-www-form-urlencoded")
            ? new URLSearchParams(
                payload.body as Record<string, string>,
              ).toString()
            : typeof payload.body === "string"
              ? payload.body
              : JSON.stringify(payload.body);
        }

        const upstream = await httpRequest(payload.url, {
          method: payload.method,
          headers,
          body,
        });
        let parsed: unknown = upstream.text;
        try {
          parsed = upstream.text ? JSON.parse(upstream.text) : undefined;
        } catch {
          /* leave as text */
        }

        return new Response(
          JSON.stringify({
            status: upstream.status,
            statusText: upstream.statusText,
            headers: upstream.headers,
            body: parsed,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              [UPSTREAM_URL_HEADER]: payload.url,
            },
          },
        );
      }

      throw new Error(`unexpected authFetch to ${path}`);
    },
  );
}

interface FlowResult {
  server: FakeMcpServer;
  authorizationUrl: URL;
  callback: Awaited<
    ReturnType<typeof import("../mcp-oauth").handleOAuthCallback>
  >;
}

/**
 * Drive initiate → authorize → callback exactly as the browser would, with the
 * fixture standing in for both the authorization server and the MCP resource.
 */
async function runFullFlow(
  serverName: string,
  fixtureOptions: FakeOAuthMcpServerOptions = {},
  connectOverrides: Record<string, unknown> = {},
): Promise<FlowResult> {
  const server = await startFakeOAuthMcpServer(fixtureOptions);
  const { initiateOAuth, handleOAuthCallback } = await import("../mcp-oauth");

  const initiate = await initiateOAuth({
    serverName,
    serverUrl: server.serverUrl,
    ...connectOverrides,
  } as never);

  const stored = JSON.parse(
    localStorage.getItem(`mcp-oauth-flow-state-${serverName}`) ?? "null",
  ) as { state?: { authorizationUrl?: string } } | null;
  const authorizationUrlRaw = stored?.state?.authorizationUrl;
  if (!authorizationUrlRaw) {
    throw new Error(
      `no authorization URL was produced: ${JSON.stringify(initiate)}`,
    );
  }
  const authorizationUrl = new URL(authorizationUrlRaw);

  // Let the fixture play the authorization endpoint: it echoes `state` back on
  // the redirect, so the callback's state is the server's value, not ours.
  const authorizeResponse = await httpRequest(authorizationUrl.toString());
  const location = authorizeResponse.headers.location;
  if (!location) {
    throw new Error("fixture did not redirect from /authorize");
  }
  const callbackUrl = new URL(location);

  const callback = await handleOAuthCallback(
    callbackUrl.searchParams.get("code") ?? "",
    {
      callbackState: callbackUrl.searchParams.get("state"),
      callbackIss: callbackUrl.searchParams.get("iss"),
    },
  );

  return { server, authorizationUrl, callback };
}

const find = (requests: FakeMcpRequestRecord[], path: string) =>
  requests.filter((entry) => entry.path === path);

let openServers: FakeMcpServer[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  installProxyForwarder();
});

afterEach(async () => {
  for (const server of openServers) {
    await server.close();
  }
  openServers = [];
});

async function track(promise: Promise<FlowResult>): Promise<FlowResult> {
  const result = await promise;
  openServers.push(result.server);
  return result;
}

describe("real executor → real state machine (hosted)", () => {
  it("produces an Authorization header the MCP resource actually accepts", async () => {
    const { server, callback } = await track(runFullFlow("integration-happy"));

    expect(callback.success, callback.error).toBe(true);

    const authorization = (
      callback.serverConfig?.requestInit?.headers as
        | Record<string, string>
        | undefined
    )?.Authorization;
    expect(authorization).toBeTruthy();
    expect(authorization).not.toContain("[redacted]");

    // The oracle: the fixture 401s unless the header matches byte-for-byte.
    // A redacted token is a non-empty string and passes every check we could
    // write ourselves — only the resource server can tell us it is wrong.
    const probe = await httpRequest(server.serverUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: authorization!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(probe.status, probe.text).toBe(200);
  });

  it("keeps a credential echoed in error_description out of the published trace", async () => {
    const echoed = FAKE_OAUTH_ACCESS_TOKEN;
    const { callback } = await track(
      runFullFlow("integration-token-failure", {
        tokenFailure: { echoInErrorDescription: `access_token=${echoed}` },
      }),
    );

    expect(callback.success).toBe(false);
    const serialized = JSON.stringify(callback.oauthTrace ?? {});
    expect(serialized).not.toContain(echoed);
  });
});

describe("MCP OAuth wire invariants (2025-11-25 via the real machine)", () => {
  let flow: FlowResult;
  let requests: FakeMcpRequestRecord[];

  beforeEach(async () => {
    flow = await track(runFullFlow("integration-invariants"));
    requests = flow.server.requests;
    expect(flow.callback.success, flow.callback.error).toBe(true);
  });

  // Invariant 3: both the authorization request and the code exchange carry
  // `resource`, byte-identical, and equal to the validated canonical resource.
  it("binds the same canonical resource on authorization and token requests", () => {
    const authorizeResource = flow.authorizationUrl.searchParams.get("resource");
    const tokenRequest = find(requests, "/token").at(-1);
    const tokenResource = (tokenRequest?.body as Record<string, string>)
      ?.resource;

    expect(authorizeResource).toBe(flow.server.serverUrl);
    expect(tokenResource).toBe(authorizeResource);
  });

  // Invariant 6: PKCE. S256 on the authorization request, verifier on the
  // token request.
  it("uses S256 PKCE end to end", () => {
    expect(flow.authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(
      flow.authorizationUrl.searchParams.get("code_challenge"),
    ).toBeTruthy();

    const tokenRequest = find(requests, "/token").at(-1);
    expect(
      (tokenRequest?.body as Record<string, string>)?.code_verifier,
    ).toBeTruthy();
  });

  // Invariant 4: one intended `redirect_uri`, reused wherever the field
  // applies.
  it("reuses one redirect_uri across registration, authorization, and exchange", () => {
    const registration = find(requests, "/register").at(-1);
    const registered = (registration?.body as { redirect_uris?: string[] })
      ?.redirect_uris;
    const authorizeRedirect =
      flow.authorizationUrl.searchParams.get("redirect_uri");
    const tokenRedirect = (
      find(requests, "/token").at(-1)?.body as Record<string, string>
    )?.redirect_uri;

    expect(authorizeRedirect).toBeTruthy();
    expect(tokenRedirect).toBe(authorizeRedirect);
    if (registered) {
      expect(registered).toContain(authorizeRedirect);
    }
  });

  // Invariant 7: MCP bearer credentials go only to the MCP resource. A token
  // forwarded to PRM/AS-metadata/registration/authorize/token would hand the
  // resource's credential to a different party.
  it("never sends the MCP bearer token to an OAuth endpoint", () => {
    const oauthPaths = [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      "/register",
      "/authorize",
      "/token",
    ];

    for (const entry of requests) {
      if (!oauthPaths.includes(entry.path)) continue;
      expect(
        entry.authorization ?? "",
        `${entry.method} ${entry.path} carried an Authorization header`,
      ).not.toContain(FAKE_OAUTH_ACCESS_TOKEN);
    }
  });

  // Invariant 2: the current protected-resource profile is actually consulted,
  // and its `resource` — not the raw MCP server URL — is what gets bound.
  it("discovers protected-resource metadata and binds its resource", () => {
    const prm = requests.find((entry) =>
      entry.path.startsWith("/.well-known/oauth-protected-resource"),
    );
    expect(prm, "no PRM request was made").toBeTruthy();
    expect(flow.authorizationUrl.searchParams.get("resource")).toBe(
      flow.server.serverUrl,
    );
  });

  // Invariant 5 (positive half): a matching state is represented as a match,
  // and the raw nonce never appears in the sanitized trace. The negative half
  // lives in its own test below.
  it("does not publish the raw callback state in a sanitized trace", () => {
    const issued = flow.authorizationUrl.searchParams.get("state");
    expect(issued, "the machine issued no state").toBeTruthy();
    expect(JSON.stringify(flow.callback.oauthTrace ?? {})).not.toContain(
      issued!,
    );
  });
});

describe("MCP OAuth wire invariants — failure paths", () => {
  // Invariant 5: a mismatched callback state must fail before any token
  // request. The count is the assertion — an error message alone would not
  // prove the code was never redeemed.
  it("makes zero token requests when the callback state does not match", async () => {
    const server = await startFakeOAuthMcpServer();
    openServers.push(server);
    const { initiateOAuth, handleOAuthCallback } = await import("../mcp-oauth");

    await initiateOAuth({
      serverName: "integration-state-mismatch",
      serverUrl: server.serverUrl,
    } as never);

    const before = find(server.requests, "/token").length;
    const result = await handleOAuthCallback(FAKE_OAUTH_AUTH_CODE, {
      callbackState: "not-the-issued-state",
      callbackIss: null,
    });

    expect(result.success).toBe(false);
    expect(find(server.requests, "/token").length).toBe(before);
  });

  it("makes zero token requests when the callback omits state entirely", async () => {
    const server = await startFakeOAuthMcpServer();
    openServers.push(server);
    const { initiateOAuth, handleOAuthCallback } = await import("../mcp-oauth");

    await initiateOAuth({
      serverName: "integration-state-missing",
      serverUrl: server.serverUrl,
    } as never);

    const before = find(server.requests, "/token").length;
    const result = await handleOAuthCallback(FAKE_OAUTH_AUTH_CODE, {
      callbackState: null,
      callbackIss: null,
    });

    expect(result.success).toBe(false);
    expect(find(server.requests, "/token").length).toBe(before);
  });

  // Invariant 1: the current era must verify S256 support before sending the
  // user to an authorization server. Both shapes of failure stop the flow.
  it.each([
    ["a list without S256", { code_challenge_methods_supported: ["plain"] }],
    ["no advertised methods", { code_challenge_methods_supported: null }],
  ])(
    "stops before browser authorization on %s",
    async (_label, metadataOverride) => {
      const server = await startFakeOAuthMcpServer({
        authorizationServerMetadata: metadataOverride,
      });
      openServers.push(server);
      const { initiateOAuth } = await import("../mcp-oauth");

      const result = await initiateOAuth({
        serverName: `integration-pkce-${_label.replace(/\s+/g, "-")}`,
        serverUrl: server.serverUrl,
      } as never);

      expect(result.success).toBe(false);
      expect(find(server.requests, "/authorize")).toHaveLength(0);
    },
  );

  // Advertising `plain` in addition to S256 is interoperability, not a
  // failure — the client picks S256 and proceeds.
  it("proceeds when the server advertises plain alongside S256", async () => {
    const { authorizationUrl } = await track(
      runFullFlow("integration-pkce-both", {
        authorizationServerMetadata: {
          code_challenge_methods_supported: ["plain", "S256"],
        },
      }),
    );

    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
  });

  // Invariant 2: no silent substitution of the MCP server URL for an
  // authorization server the protected resource never named.
  it.each([
    ["an empty authorization_servers list", { authorization_servers: [] }],
    ["no authorization_servers at all", { authorization_servers: null }],
  ])("fails closed on %s", async (_label, prmOverride) => {
    const server = await startFakeOAuthMcpServer({
      protectedResourceMetadata: prmOverride,
    });
    openServers.push(server);
    const { initiateOAuth } = await import("../mcp-oauth");

    const result = await initiateOAuth({
      serverName: `integration-prm-${_label.replace(/\s+/g, "-")}`,
      serverUrl: server.serverUrl,
    } as never);

    expect(result.success).toBe(false);
    expect(find(server.requests, "/authorize")).toHaveLength(0);
    expect(find(server.requests, "/token")).toHaveLength(0);
  });

  // Invariant 8: a connect-time `resourceUrl` that does not identify the
  // configured MCP server must be rejected before the browser is redirected.
  it("rejects a foreign configured resourceUrl before redirect", async () => {
    const server = await startFakeOAuthMcpServer();
    openServers.push(server);
    const { initiateOAuth } = await import("../mcp-oauth");

    const result = await initiateOAuth({
      serverName: "integration-foreign-resource",
      serverUrl: server.serverUrl,
      resourceUrl: "https://attacker.example.com/mcp",
    } as never);

    const authorizeRequests = find(server.requests, "/authorize");
    const stored = JSON.parse(
      localStorage.getItem("mcp-oauth-flow-state-integration-foreign-resource") ??
        "null",
    ) as { state?: { authorizationUrl?: string } } | null;
    const authorizationUrl = stored?.state?.authorizationUrl;

    // Either the flow refused outright, or it fell back to the configured MCP
    // server's own resource. What it must never do is bind the foreign one.
    if (authorizationUrl) {
      expect(
        new URL(authorizationUrl).searchParams.get("resource") ?? "",
      ).not.toContain("attacker.example.com");
    } else {
      expect(result.success).toBe(false);
    }
    for (const entry of authorizeRequests) {
      expect(entry.query.resource ?? "").not.toContain("attacker.example.com");
    }
  });
});
