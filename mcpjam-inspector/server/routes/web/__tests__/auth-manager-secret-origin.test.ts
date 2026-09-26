import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mcpClientManagerMock, disconnectAllServersMock } = vi.hoisted(() => ({
  mcpClientManagerMock: vi.fn(),
  disconnectAllServersMock: vi.fn(),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk",
  );
  return {
    ...actual,
    MCPClientManager: mcpClientManagerMock.mockImplementation(() => ({
      disconnectAllServers: disconnectAllServersMock,
    })),
  };
});

import type { Context } from "hono";
import { createAuthorizedManager, callerContextFromHono } from "../auth.js";

const mockVars: Record<string, unknown> = { requestLogContext: undefined };
const mockContext = {
  var: mockVars,
  get: (key: string) => mockVars[key],
  set: vi.fn((key: string, value: unknown) => {
    mockVars[key] = value;
  }),
} as unknown as Context;

const SECRET_HEADER_VALUE = "Bearer victim-header-credential";
const STORED_OAUTH_TOKEN = "victim-oauth-token";

/** The origin a URL reduces to, for the fake backend's decision below. */
function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * Authorize + reveal in one fetch mock. The reveal stands in for the backend's
 * broker: it refuses when the declared `targetUrl` is not an origin the stored
 * headers were saved for (`boundOrigin`), exactly as `/web/server/reveal-secrets`
 * does, and otherwise answers with the headers and the bound origins. The
 * inspector no longer compares origins itself — these tests pin that it
 * declares the target, forwards the refusal, and holds the headers to the
 * bound origins on the wire.
 */
function mockBackend(opts: {
  url: string;
  /** Where the stored headers were saved for. Absent ⇒ bound nowhere. */
  boundOrigin?: string;
  hasHeaders?: boolean;
  oauthAccessToken?: string | null;
  revealHeaders?: Record<string, string>;
  /** Extra `serverConfig` fields — the XAA rows need `authMethod`/`registrationMode`. */
  serverConfigExtra?: Record<string, unknown>;
  /** Answers for any other URL (the MCP server itself, in transport tests). */
  upstream?: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const revealBodies: Array<Record<string, unknown>> = [];
  global.fetch = vi.fn(async (input: any, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target.includes("/web/server/reveal-secrets")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      revealBodies.push(body);
      const targetOrigin =
        typeof body.targetUrl === "string" ? originOf(body.targetUrl) : null;
      if (!opts.boundOrigin || targetOrigin !== opts.boundOrigin) {
        return Response.json(
          {
            success: false,
            code: "credential_origin_mismatch",
            secretOriginMismatch: true,
            boundOrigin: opts.boundOrigin ?? null,
            targetOrigin,
            error: `Stored credentials were saved for ${opts.boundOrigin ?? "no origin"}, not ${targetOrigin}. Re-enter them for the new address.`,
          },
          { status: 403 },
        );
      }
      return Response.json({
        success: true,
        env: null,
        headers: opts.revealHeaders ?? { Authorization: SECRET_HEADER_VALUE },
        boundOrigins: [opts.boundOrigin],
      });
    }
    if (!target.includes("example.convex.site") && opts.upstream) {
      return opts.upstream(target, init);
    }
    return new Response(
      JSON.stringify({
        results: {
          "server-1": {
            ok: true,
            role: "member",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            ...(opts.oauthAccessToken !== undefined
              ? { oauthAccessToken: opts.oauthAccessToken }
              : {}),
            serverConfig: {
              transportType: "http",
              url: opts.url,
              headers: {},
              ...(opts.hasHeaders === false ? {} : { hasHeaders: true }),
              ...(opts.serverConfigExtra ?? {}),
            },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return { revealBodies };
}

function connect() {
  return createAuthorizedManager(
    callerContextFromHono(mockContext),
    "bearer-token",
    "project-1",
    ["server-1"],
    10_000,
  );
}

function configForServer1(): any {
  return mcpClientManagerMock.mock.calls[0]?.[0]?.["server-1"];
}

function outboundHeadersForServer1(): Record<string, string> | undefined {
  return configForServer1()?.requestInit?.headers;
}

describe("stored headers at connect time", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
  });

  it("declares the URL it is about to dial on the reveal", async () => {
    const { revealBodies } = mockBackend({
      url: "https://owner.example.com/mcp",
      boundOrigin: "https://owner.example.com",
    });

    await connect();

    expect(revealBodies).toEqual([
      expect.objectContaining({ targetUrl: "https://owner.example.com/mcp" }),
    ]);
  });

  it("attaches revealed secret headers when the backend releases them", async () => {
    mockBackend({
      url: "https://owner.example.com/mcp",
      boundOrigin: "https://owner.example.com",
    });

    await connect();

    expect(outboundHeadersForServer1()).toEqual({
      Authorization: SECRET_HEADER_VALUE,
    });
  });

  it("keeps working when only the path moved on the same origin", async () => {
    mockBackend({
      url: "https://owner.example.com/mcp/v2",
      boundOrigin: "https://owner.example.com",
    });

    await connect();

    expect(outboundHeadersForServer1()).toEqual({
      Authorization: SECRET_HEADER_VALUE,
    });
  });

  it("refuses, and builds no transport, when the backend refuses a repointed row", async () => {
    mockBackend({
      url: "https://collector.attacker.example/mcp",
      boundOrigin: "https://owner.example.com",
    });

    await expect(connect()).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });

    // The load-bearing assertion: no transport was ever constructed, so the
    // credential cannot have reached the attacker's host.
    expect(mcpClientManagerMock).not.toHaveBeenCalled();
  });

  it("forwards both origins so the refusal is actionable", async () => {
    mockBackend({
      url: "https://collector.attacker.example/mcp",
      boundOrigin: "https://owner.example.com",
    });

    // A bare "forbidden" would read as a permissions bug. The client needs to
    // know the server moved and that re-entering the credential is the fix.
    await expect(connect()).rejects.toMatchObject({
      message: expect.stringContaining("https://collector.attacker.example"),
      details: expect.objectContaining({
        secretOriginMismatch: true,
        boundOrigin: "https://owner.example.com",
        targetOrigin: "https://collector.attacker.example",
      }),
    });
  });

  it("forwards an export-policy refusal", async () => {
    global.fetch = vi.fn(async (input: any) => {
      const target = String(input);
      if (target.includes("/web/server/reveal-secrets")) {
        return Response.json(
          {
            success: false,
            code: "export_denied",
            exportDenied: true,
            policy: "credentialExportPolicy",
            error: "Your organization's credential export policy is set to deny.",
          },
          { status: 403 },
        );
      }
      return Response.json({
        results: {
          "server-1": {
            ok: true,
            role: "member",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: {
              transportType: "http",
              url: "https://owner.example.com/mcp",
              headers: {},
              hasHeaders: true,
            },
          },
        },
      });
    }) as typeof fetch;

    await expect(connect()).rejects.toMatchObject({
      status: 403,
      details: expect.objectContaining({ exportDenied: true }),
    });
    expect(mcpClientManagerMock).not.toHaveBeenCalled();
  });

  it("leaves a row with no stored credential alone", async () => {
    const { revealBodies } = mockBackend({
      url: "https://anything.example.com/mcp",
      hasHeaders: false,
      oauthAccessToken: null,
    });

    // Nothing to reveal and nothing to leak.
    await connect();
    expect(outboundHeadersForServer1()).toEqual({});
    expect(revealBodies).toEqual([]);
  });
});

describe("stored headers on the wire", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
  });

  async function dialThroughServer1(
    redirectTo: string,
    headers: Record<string, string>,
  ) {
    const hops: Array<{ url: string; headers: Headers }> = [];
    mockBackend({
      url: "https://owner.example.com/mcp",
      boundOrigin: "https://owner.example.com",
      revealHeaders: headers,
      upstream: async (url, init) => {
        hops.push({ url, headers: new Headers(init?.headers) });
        if (url === "https://owner.example.com/mcp") {
          return new Response(null, {
            status: 302,
            headers: { Location: redirectTo },
          });
        }
        return new Response("ok", { status: 200 });
      },
    });
    await connect();
    const config = configForServer1();
    expect(config.baseFetch).toBeTypeOf("function");
    const response = await config.baseFetch("https://owner.example.com/mcp", {
      method: "GET",
      headers: config.requestInit.headers,
    });
    expect(response.status).toBe(200);
    return hops;
  }

  it("does not carry a stored header across a redirect to another origin", async () => {
    // Fetch drops `Authorization` on a cross-origin redirect, but a stored
    // credential is just as often `x-api-key` — which nothing generic strips.
    const hops = await dialThroughServer1("https://collector.example/steal", {
      "x-api-key": "stored-api-key",
      Authorization: SECRET_HEADER_VALUE,
    });

    expect(hops.map((hop) => hop.url)).toEqual([
      "https://owner.example.com/mcp",
      "https://collector.example/steal",
    ]);
    expect(hops[0]!.headers.get("x-api-key")).toBe("stored-api-key");
    expect(hops[1]!.headers.get("x-api-key")).toBeNull();
    expect(hops[1]!.headers.get("authorization")).toBeNull();
  });

  it("keeps the stored header on a same-origin redirect", async () => {
    const hops = await dialThroughServer1(
      "https://owner.example.com/mcp/v2",
      { "x-api-key": "stored-api-key" },
    );

    expect(hops[1]!.url).toBe("https://owner.example.com/mcp/v2");
    expect(hops[1]!.headers.get("x-api-key")).toBe("stored-api-key");
  });
});

describe("credential binding scope — what it must NOT refuse", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
  });

  it("connects an OAuth-only row, which carries no binding at all", async () => {
    // THE #4932 REGRESSION, pinned. The backend writes `secretsBoundOrigin`
    // only for rows holding an ON-ROW credential, and a hosted OAuth token is
    // not one: it lives per subject in `hostedOAuthCredentials` with its own
    // `serverUrl`. So an OAuth-only row has no binding even after a complete
    // backfill, and gating its token here would refuse every one of them — the
    // outage this change was reverted for. The token's own origin is enforced
    // backend-side, at `internalResolveHostedOAuthAccessToken`, which every
    // connect path resolves through and which answers
    // `oauthUnavailableReason: 'credential_origin_mismatch'` instead of a token.
    mockBackend({
      url: "https://owner.example.com/mcp",
      hasHeaders: false,
      oauthAccessToken: STORED_OAUTH_TOKEN,
    });

    await connect();

    expect(outboundHeadersForServer1()).toEqual({
      Authorization: `Bearer ${STORED_OAUTH_TOKEN}`,
    });
  });

  it("allows a caller-supplied token against a repointed row", async () => {
    mockBackend({
      url: "https://moved.example.com/mcp",
      boundOrigin: "https://owner.example.com",
      hasHeaders: false,
      oauthAccessToken: null,
    });

    // The caller's own token, passed in for this request. It was never stored
    // against this row, so no saved credential is at risk and refusing would
    // block a connection for nothing. Gating this was a real bug in the first
    // cut of the check, caught by the existing auth-manager suite.
    const result = await createAuthorizedManager(
      callerContextFromHono(mockContext),
      "bearer-token",
      "project-1",
      ["server-1"],
      10_000,
      { "server-1": "callers-own-token" },
    );

    expect(result).toBeTruthy();
    expect(outboundHeadersForServer1()).toEqual({
      Authorization: "Bearer callers-own-token",
    });
  });

  it("does not let a stale binding block a CIMD XAA server", async () => {
    // CIMD sends no secret of the row's — public client, or an org-level key
    // whose assertion is audience-bound to the endpoint it goes to — so a
    // binding left over from the server's OAuth days is irrelevant and must
    // not refuse the connect.
    const { revealBodies } = mockBackend({
      url: "https://moved.example.com/mcp",
      boundOrigin: "https://owner.example.com",
      hasHeaders: false,
      // Converted from OAuth: the stored token is still on the row.
      oauthAccessToken: "stale-oauth-token",
      serverConfigExtra: {
        authMethod: "xaa",
        useXaa: true,
        registrationMode: "cimd",
      },
    });

    // Reaching the issuer check IS the assertion: it sits immediately after
    // the gate, so a 500 for a missing issuer proves the gate passed this row.
    // Asserting "not the origin refusal" instead would pass for almost any
    // regression.
    await expect(connect()).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("Missing XAA issuer"),
    });
    expect(revealBodies).toEqual([]);
  });

  it("does not refuse an unbound preregistered or DCR XAA row at the gate", async () => {
    // Public clients store no secret, so they are never bound, and a DCR row is
    // bound only after the registration that happens inside the mint. A stored
    // secret without a binding is refused where it is resolved, in the mint.
    for (const registrationMode of ["preregistered", "dcr"]) {
      const { revealBodies } = mockBackend({
        url: "https://mcp.example.com/mcp",
          hasHeaders: false,
        serverConfigExtra: { authMethod: "xaa", useXaa: true, registrationMode },
      });

      // Same probe as the CIMD case: the issuer check sits right after the gate.
      await expect(connect()).rejects.toMatchObject({
        status: 500,
        message: expect.stringContaining("Missing XAA issuer"),
      });
      expect(revealBodies).toEqual([]);
    }
  });

  it("leaves a repointed preregistered XAA row to the mint's reveal", async () => {
    // `preregistered` and `dcr` post the row's stored client secret to a token
    // endpoint discovered from the row's CURRENT url. The mint's reveal
    // declares that url and the backend refuses a secret saved for another
    // origin (xaa-connect-cimd-mint.test.ts), so the connect path has no gate
    // of its own to fire: it reaches the issuer check untouched.
    const { revealBodies } = mockBackend({
      url: "https://collector.attacker.example/mcp",
      boundOrigin: "https://owner.example.com",
      hasHeaders: false,
      serverConfigExtra: { authMethod: "xaa", useXaa: true },
    });

    await expect(connect()).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("Missing XAA issuer"),
    });
    expect(revealBodies).toEqual([]);
  });
});
