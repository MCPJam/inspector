/**
 * MJ-003 — the Inspector must not send a stored credential to a URL it was not
 * saved against.
 *
 * The backend clears a row's credentials when a `url` change crosses their
 * origin, which closes the reported attack. These tests cover what a write-side
 * gate cannot: the window between the authorize read and the reveal read (two
 * separate round trips), and any future writer added without the gate.
 *
 * SCOPE. What this gate covers is the row's ON-ROW credentials — the revealed
 * headers, and the client secret a preregistered/DCR XAA mint spends. A stored
 * hosted OAuth token is bound elsewhere (per subject, against its own
 * `serverUrl`) and refused backend-side, so it is deliberately NOT gated here;
 * the tests below pin both halves of that division.
 *
 * The assertions are about what reaches the wire. `MCPClientManager` is mocked,
 * so the exact `requestInit.headers` handed to the transport is inspectable —
 * which is the only thing that actually matters here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mcpClientManagerMock, disconnectAllServersMock } = vi.hoisted(() => ({
  mcpClientManagerMock: vi.fn(),
  disconnectAllServersMock: vi.fn(),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk"
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

/**
 * Authorize + reveal in one fetch mock. `revealHeaders` is what
 * `/web/server/reveal-secrets` hands back, so a test can make the reveal
 * succeed and still expect the connect to be refused — which is the
 * authorize/reveal-window case.
 */
function mockBackend(opts: {
  url: string;
  secretsBoundOrigin?: string;
  hasHeaders?: boolean;
  oauthAccessToken?: string | null;
  revealHeaders?: Record<string, string>;
  revealBoundOrigin?: string;
  /** Extra `serverConfig` fields — the XAA rows need `authMethod`/`registrationMode`. */
  serverConfigExtra?: Record<string, unknown>;
}) {
  const revealCalls: string[] = [];
  global.fetch = vi.fn(async (input: any) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target.includes("/web/server/reveal-secrets")) {
      revealCalls.push(target);
      return new Response(
        JSON.stringify({
          success: true,
          env: null,
          headers: opts.revealHeaders ?? {
            Authorization: SECRET_HEADER_VALUE,
          },
          secretsBoundOrigin:
            opts.revealBoundOrigin ?? opts.secretsBoundOrigin ?? null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
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
              ...(opts.secretsBoundOrigin !== undefined
                ? { secretsBoundOrigin: opts.secretsBoundOrigin }
                : {}),
              ...(opts.serverConfigExtra ?? {}),
            },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;
  return { revealCalls };
}

function connect() {
  return createAuthorizedManager(
    callerContextFromHono(mockContext),
    "bearer-token",
    "project-1",
    ["server-1"],
    10_000
  );
}

function outboundHeadersForServer1(): Record<string, string> | undefined {
  const config = mcpClientManagerMock.mock.calls[0]?.[0]?.["server-1"];
  return config?.requestInit?.headers;
}

describe("MJ-003 secret origin binding at connect time", () => {
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

  it("refuses a credential saved for a different origin after authorize", async () => {
    mockBackend({
      url: "https://collector.attacker.example/mcp",
      secretsBoundOrigin: "https://collector.attacker.example",
      revealBoundOrigin: "https://owner.example.com",
      revealHeaders: { Authorization: SECRET_HEADER_VALUE },
    });
    await expect(connect()).rejects.toMatchObject({ status: 403 });
    expect(mcpClientManagerMock).not.toHaveBeenCalled();
  });

  it("attaches revealed secret headers when the binding matches", async () => {
    mockBackend({
      url: "https://owner.example.com/mcp",
      secretsBoundOrigin: "https://owner.example.com",
    });

    await connect();

    expect(outboundHeadersForServer1()).toEqual({
      Authorization: SECRET_HEADER_VALUE,
    });
  });

  it("keeps working when only the path moved on the same origin", async () => {
    mockBackend({
      url: "https://owner.example.com/mcp/v2",
      secretsBoundOrigin: "https://owner.example.com",
    });

    await connect();

    // AC 5: legitimate maintenance by the credential owner still works, and the
    // backend does not clear on a same-origin edit either — the two halves have
    // to agree or a saved credential becomes unusable without being cleared.
    expect(outboundHeadersForServer1()).toEqual({
      Authorization: SECRET_HEADER_VALUE,
    });
  });

  it("refuses, and sends nothing, when the row has been repointed", async () => {
    mockBackend({
      url: "https://collector.attacker.example/mcp",
      secretsBoundOrigin: "https://owner.example.com",
    });

    await expect(connect()).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });

    // The load-bearing assertion: no transport was ever constructed, so the
    // credential cannot have reached the attacker's host.
    expect(mcpClientManagerMock).not.toHaveBeenCalled();
  });

  it("names both origins so the refusal is actionable", async () => {
    mockBackend({
      url: "https://collector.attacker.example/mcp",
      secretsBoundOrigin: "https://owner.example.com",
    });

    // A bare "forbidden" would read as a permissions bug. The operator needs to
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

  it("refuses BEFORE spending a reveal", async () => {
    const { revealCalls } = mockBackend({
      url: "https://collector.attacker.example/mcp",
      secretsBoundOrigin: "https://owner.example.com",
    });

    await expect(connect()).rejects.toMatchObject({ status: 403 });

    // Asking Convex to decrypt first would put the plaintext in this process
    // for no reason, and log a reveal that never needed to happen — which
    // matters because reveals are audited.
    expect(revealCalls).toEqual([]);
  });

  it("treats a missing binding on a credential-bearing row as a refusal", async () => {
    mockBackend({
      url: "https://owner.example.com/mcp",
      secretsBoundOrigin: undefined,
    });

    // Fail CLOSED on absence. "Absent means allow" is the hole the field exists
    // to close, and it is why the backend's backfill gates this deploy.
    await expect(connect()).rejects.toMatchObject({ status: 403 });
    expect(mcpClientManagerMock).not.toHaveBeenCalled();
  });

  it("refuses a scheme downgrade on the same host", async () => {
    mockBackend({
      url: "http://owner.example.com/mcp",
      secretsBoundOrigin: "https://owner.example.com",
    });

    await expect(connect()).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a port change on the same host", async () => {
    mockBackend({
      url: "https://owner.example.com:8443/mcp",
      secretsBoundOrigin: "https://owner.example.com",
    });

    await expect(connect()).rejects.toMatchObject({ status: 403 });
  });

  it("leaves a row with no stored credential alone", async () => {
    mockBackend({
      url: "https://anything.example.com/mcp",
      hasHeaders: false,
      oauthAccessToken: null,
      secretsBoundOrigin: undefined,
    });

    // Nothing to bind and nothing to leak, so the gate must not fire — this is
    // the case that would break every unauthenticated server if the check were
    // keyed on the binding's absence alone rather than on holding a credential.
    await connect();
    expect(outboundHeadersForServer1()).toEqual({});
  });
});

describe("MJ-003 gate scope — what it must NOT refuse", () => {
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
      secretsBoundOrigin: undefined,
    });

    await connect();

    expect(outboundHeadersForServer1()).toEqual({
      Authorization: `Bearer ${STORED_OAUTH_TOKEN}`,
    });
  });

  it("allows a caller-supplied token against a repointed row", async () => {
    mockBackend({
      url: "https://moved.example.com/mcp",
      secretsBoundOrigin: "https://owner.example.com",
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
      { "server-1": "callers-own-token" }
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
    const { revealCalls } = mockBackend({
      url: "https://moved.example.com/mcp",
      secretsBoundOrigin: "https://owner.example.com",
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
    expect(revealCalls).toEqual([]);
  });

  it("refuses a repointed preregistered XAA row before revealing its secret", async () => {
    // `preregistered` and `dcr` post the row's stored client secret to a token
    // endpoint discovered from the row's CURRENT url, which the mint's
    // `resource` pinning does not cover. Repointing the row therefore
    // redirects the secret, and the gate has to fire before the reveal.
    const { revealCalls } = mockBackend({
      url: "https://collector.attacker.example/mcp",
      secretsBoundOrigin: "https://owner.example.com",
      hasHeaders: false,
      serverConfigExtra: { authMethod: "xaa", useXaa: true },
    });

    await expect(connect()).rejects.toMatchObject({
      status: 403,
      details: expect.objectContaining({ secretOriginMismatch: true }),
    });
    expect(revealCalls).toEqual([]);
  });
});
