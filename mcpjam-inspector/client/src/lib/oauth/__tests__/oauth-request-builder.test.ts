/**
 * One server identity, four entry points, one wire behavior.
 *
 * Four production paths used to hand-roll their own `initiateOAuth` options.
 * They disagreed: the hosted gate omitted `allowPathScopedIssuer`,
 * `hasClientSecret`, `customHeaders`, `resourceUrl`, and `registrationMode`;
 * the initial-connect path omitted `resourceUrl`. "Same server, different wire
 * behavior depending on which button you pressed" is the most expensive shape
 * an OAuth bug can take, because it only reproduces on one entry point.
 *
 * Options-object equality alone would not be enough — two identical bags can
 * still be consumed differently — so the last test drives a built request into
 * the real state machine and re-checks the Checkpoint 4 wire invariants.
 */

import http from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  startFakeOAuthMcpServer,
  type FakeMcpServer,
} from "../../../../../e2e/fixtures/fake-oauth-mcp-server";

vi.mock("@/lib/config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/config")>(
    "@/lib/config",
  );
  return { ...actual, HOSTED_MODE: true, SANITIZE_OAUTH_TRACES: true };
});

const mockAuthFetch = vi.fn();
vi.mock("@/lib/session-token", () => ({ authFetch: mockAuthFetch }));

const SERVER_NAME = "builder-parity";
const SERVER_URL = "https://mcp.example.com/mcp";

/** The per-server facts every entry point resolves from its own source. */
const STORED_SERVER = {
  serverName: SERVER_NAME,
  serverUrl: SERVER_URL,
  scopes: ["openid", "profile"],
  resourceUrl: "https://mcp.example.com/mcp",
  clientId: "stored-client-id",
  hasClientSecret: true,
  customHeaders: { "x-tenant": "acme" },
  registryServerId: "registry-123",
  useRegistryOAuthProxy: true,
  allowPathScopedIssuer: true,
  protocolMode: "2025-11-25" as const,
  protocolVersion: "2025-11-25" as const,
  registrationMode: "dcr" as const,
  registrationStrategy: "dcr" as const,
};

describe("buildOAuthRequest produces one shared shape for every intent", () => {
  it.each(["connect", "reconnect", "hosted-connect", "step-up"] as const)(
    "%s builds the same security-sensitive fields",
    async (intent) => {
      const { buildOAuthRequest, pickSharedOAuthRequestFields } = await import(
        "../oauth-request"
      );
      // The baseline every other connect-like intent must match.
      const reference = pickSharedOAuthRequestFields(
        buildOAuthRequest(STORED_SERVER, { intent: "connect" }),
      );
      const actual = pickSharedOAuthRequestFields(
        buildOAuthRequest(STORED_SERVER, { intent }),
      );

      expect(actual).toEqual(reference);
    },
  );

  it("records the intent so a nonconforming request cannot be mistaken for a connect", async () => {
    const { buildOAuthRequest } = await import("../oauth-request");
    expect(buildOAuthRequest(STORED_SERVER, { intent: "debug" }).intent).toBe(
      "debug",
    );
  });

  it("carries the fields the hosted gate used to drop", async () => {
    const { buildOAuthRequest } = await import("../oauth-request");
    const request = buildOAuthRequest(STORED_SERVER, {
      intent: "hosted-connect",
    });

    expect(request.allowPathScopedIssuer).toBe(true);
    expect(request.hasClientSecret).toBe(true);
    expect(request.customHeaders).toEqual({ "x-tenant": "acme" });
    expect(request.resourceUrl).toBe(SERVER_URL);
    expect(request.registrationMode).toBe("dcr");
    expect(request.registryServerId).toBe("registry-123");
  });

  it("never lets an absent path-scoped-issuer toggle read as on", async () => {
    const { buildOAuthRequest } = await import("../oauth-request");
    const { allowPathScopedIssuer: _drop, ...withoutToggle } = STORED_SERVER;

    expect(
      buildOAuthRequest(withoutToggle, { intent: "connect" })
        .allowPathScopedIssuer,
    ).toBe(false);
  });

  // The intentional differences, asserted separately so they stay intentional.
  it("step-up widens the scopes and may pin a challenge metadata URL", async () => {
    const { buildOAuthRequest } = await import("../oauth-request");

    const stepUp = buildOAuthRequest(STORED_SERVER, {
      intent: "step-up",
      stepUpScopes: ["openid", "profile", "tasks:write"],
      resourceMetadataUrl:
        "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    });

    expect(stepUp.scopes).toEqual(["openid", "profile", "tasks:write"]);
    expect(stepUp.resourceMetadataUrl).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );

    // A reconnect that is not a step-up pins neither.
    const reconnect = buildOAuthRequest(STORED_SERVER, { intent: "reconnect" });
    expect(reconnect.scopes).toEqual(["openid", "profile"]);
    expect(reconnect.resourceMetadataUrl).toBeUndefined();
  });
});

describe("a stored resource indicator is discarded when it is stale", () => {
  const PROFILE_RESOURCE = "https://mcp.example.com/mcp";

  it("keeps a stored resource captured for this exact server URL", async () => {
    const { selectStoredResourceUrl } = await import("../oauth-request");

    expect(
      selectStoredResourceUrl(SERVER_URL, [
        {
          resourceUrl: PROFILE_RESOURCE,
          capturedForServerUrl: SERVER_URL,
        },
      ]),
    ).toBe(PROFILE_RESOURCE);
  });

  // The loud half: after an edit to a new origin the stale value fails
  // validation and would block a connection the user just asked for, blaming a
  // resource they never configured.
  it("discards a resource captured for a different origin", async () => {
    const { selectStoredResourceUrl } = await import("../oauth-request");

    expect(
      selectStoredResourceUrl("https://new.example.com/mcp", [
        {
          resourceUrl: PROFILE_RESOURCE,
          capturedForServerUrl: SERVER_URL,
        },
      ]),
    ).toBeUndefined();
  });

  // The quiet half, and the worse one: same origin, different path. The stale
  // value passes validation and is then minted as the audience for an endpoint
  // it does not describe.
  it("discards a resource captured for a different path on the same origin", async () => {
    const { selectStoredResourceUrl } = await import("../oauth-request");

    expect(
      selectStoredResourceUrl("https://mcp.example.com/other", [
        {
          resourceUrl: PROFILE_RESOURCE,
          capturedForServerUrl: SERVER_URL,
        },
      ]),
    ).toBeUndefined();
  });

  it("tolerates cosmetic URL differences rather than treating them as a move", async () => {
    const { selectStoredResourceUrl } = await import("../oauth-request");

    expect(
      selectStoredResourceUrl("https://MCP.example.com:443/mcp", [
        {
          resourceUrl: PROFILE_RESOURCE,
          capturedForServerUrl: SERVER_URL,
        },
      ]),
    ).toBe(PROFILE_RESOURCE);
  });

  it("falls through to the next candidate and ignores unprovenanced ones", async () => {
    const { selectStoredResourceUrl } = await import("../oauth-request");

    expect(
      selectStoredResourceUrl(SERVER_URL, [
        { resourceUrl: "https://stale.example.com/mcp", capturedForServerUrl: "https://old.example.com/mcp" },
        { resourceUrl: PROFILE_RESOURCE, capturedForServerUrl: SERVER_URL },
      ]),
    ).toBe(PROFILE_RESOURCE);

    // No provenance at all is not a licence to use it.
    expect(
      selectStoredResourceUrl(SERVER_URL, [{ resourceUrl: PROFILE_RESOURCE }]),
    ).toBeUndefined();
  });

  // Staleness and misconfiguration are different: a foreign resource configured
  // for the CURRENT server is still a rejection, not a silent discard.
  it("still rejects a foreign resource configured for the current server", async () => {
    const { buildOAuthRequest, selectStoredResourceUrl, OAuthRequestRejectedError } =
      await import("../oauth-request");

    const configured = selectStoredResourceUrl(SERVER_URL, [
      {
        resourceUrl: "https://attacker.example.com/mcp",
        capturedForServerUrl: SERVER_URL,
      },
    ]);
    expect(configured).toBe("https://attacker.example.com/mcp");

    expect(() =>
      buildOAuthRequest(
        { ...STORED_SERVER, resourceUrl: configured },
        { intent: "connect" },
      ),
    ).toThrow(OAuthRequestRejectedError);
  });
});

describe("connect-like intents cannot opt into a foreign resource audience", () => {
  it.each(["connect", "reconnect", "hosted-connect", "step-up"] as const)(
    "%s rejects a resourceUrl that is not the configured MCP server",
    async (intent) => {
      const { buildOAuthRequest, OAuthRequestRejectedError } = await import(
        "../oauth-request"
      );

      expect(() =>
        buildOAuthRequest(
          { ...STORED_SERVER, resourceUrl: "https://attacker.example.com/mcp" },
          { intent },
        ),
      ).toThrow(OAuthRequestRejectedError);
    },
  );

  // The debugger exists to exercise values a connect must refuse. That is an
  // observation, not conformance, and it requires naming the intent.
  it.each(["debug", "emulation"] as const)(
    "%s may carry a nonconforming resourceUrl",
    async (intent) => {
      const { buildOAuthRequest } = await import("../oauth-request");

      expect(
        buildOAuthRequest(
          { ...STORED_SERVER, resourceUrl: "https://attacker.example.com/mcp" },
          { intent },
        ).resourceUrl,
      ).toBe("https://attacker.example.com/mcp");
    },
  );
});

// ---------------------------------------------------------------------------
// The built request, driven into the real machine.
// ---------------------------------------------------------------------------

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
    if (init.body != null) request.write(init.body);
    request.end();
  });
}

// See oauth-refresh-integration.test.ts: the shared setup stubs global.fetch,
// which mcp-oauth captures at module load.
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
  const upstream = await httpRequest(target, {
    method: init?.method ?? "GET",
    headers: init?.headers
      ? Object.fromEntries(new Headers(init.headers as HeadersInit).entries())
      : {},
    body: typeof init?.body === "string" ? init.body : undefined,
  });
  return new Response(upstream.text, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}) as typeof fetch;
(window as unknown as { fetch: typeof fetch }).fetch = globalThis.fetch;

function installProxyForwarder() {
  mockAuthFetch.mockImplementation(
    async (input: string, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/metadata?url=")) {
        const target = decodeURIComponent(path.split("url=")[1]!);
        const upstream = await httpRequest(target);
        return new Response(upstream.text, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: {
            "content-type":
              upstream.headers["content-type"] ?? "application/json",
            "x-mcpjam-oauth-upstream-url": target,
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
              "x-mcpjam-oauth-upstream-url": payload.url,
            },
          },
        );
      }
      throw new Error(`unexpected authFetch to ${path}`);
    },
  );
}

describe("a built request drives the real machine to the same wire", () => {
  let server: FakeMcpServer;

  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    installProxyForwarder();
    server = await startFakeOAuthMcpServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it.each(["connect", "reconnect", "hosted-connect"] as const)(
    "%s reaches the wire with the same resource, PKCE, and redirect binding",
    async (intent) => {
      const { buildOAuthRequest } = await import("../oauth-request");
      const { initiateOAuth } = await import("../mcp-oauth");

      const name = `${SERVER_NAME}-${intent}`;
      await initiateOAuth(
        buildOAuthRequest(
          { serverName: name, serverUrl: server.serverUrl },
          { intent },
        ),
      );

      const stored = JSON.parse(
        localStorage.getItem(`mcp-oauth-flow-state-${name}`) ?? "null",
      ) as { state?: { authorizationUrl?: string } } | null;
      const authorizationUrl = new URL(stored?.state?.authorizationUrl ?? "");

      expect(authorizationUrl.searchParams.get("resource")).toBe(
        server.serverUrl,
      );
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBeTruthy();
      expect(authorizationUrl.searchParams.get("state")).toBeTruthy();

      const registration = server.requests
        .filter((entry) => entry.path === "/register")
        .at(-1);
      expect(
        (registration?.body as { redirect_uris?: string[] })?.redirect_uris,
      ).toContain(authorizationUrl.searchParams.get("redirect_uri"));
    },
  );
});
