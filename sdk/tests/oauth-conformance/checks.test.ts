import {
  runDcrHttpRedirectUriCheck,
  runInvalidAuthorizeRedirectCheck,
  runInvalidClientCheck,
  runInvalidTokenCheck,
  runInvalidRedirectCheck,
} from "../../src/oauth-conformance/checks/oauth-negative.js";
import { runTokenFormatCheck } from "../../src/oauth-conformance/checks/oauth-token-format.js";
import {
  runAsRegistrationEndpointCheck,
  runDiscoveryStaleProtocolHeaderCheck,
  runResourceMetadataChallengeCheck,
  runStaleSessionRejectionCheck,
  runUnauthenticatedChallengeCheck,
} from "../../src/oauth-conformance/checks/oauth-server-obligations.js";

const baseNegativeInput = {
  config: {
    serverUrl: "https://mcp.example.com",
    protocolVersion: "2025-11-25",
    auth: { mode: "headless" },
  },
  state: {
    authorizationServerMetadata: {
      token_endpoint: "https://auth.example.com/token",
    },
    authorizationCode: "auth-code",
  },
  redirectUrl: "http://127.0.0.1:3333/callback",
};

describe("oauth conformance unit checks", () => {
  it("turns invalid-client transport errors into failed checks", async () => {
    const result = await runInvalidClientCheck({
      ...(baseNegativeInput as any),
      trackedRequest: jest.fn().mockRejectedValue(new Error("timeout")),
    });

    expect(result).toMatchObject({
      step: "oauth_invalid_client",
      status: "failed",
      error: {
        message: "Token endpoint request failed: timeout",
        details: expect.objectContaining({
          request: expect.objectContaining({
            method: "POST",
            url: "https://auth.example.com/token",
          }),
        }),
      },
    });
  });

  it("turns invalid-redirect transport errors into failed checks", async () => {
    const result = await runInvalidRedirectCheck({
      ...(baseNegativeInput as any),
      trackedRequest: jest.fn().mockRejectedValue(new Error("connection reset")),
    });

    expect(result).toMatchObject({
      step: "oauth_invalid_redirect",
      status: "failed",
      error: {
        message: "Token endpoint request failed: connection reset",
        details: expect.objectContaining({
          request: expect.objectContaining({
            method: "POST",
            url: "https://auth.example.com/token",
          }),
        }),
      },
    });
  });

  it("includes resource in authorization_code invalid-client checks", async () => {
    const trackedRequest = jest.fn().mockImplementation(async (request) => {
      expect(request.body).toMatchObject({
        grant_type: "authorization_code",
        client_id: "invalid-client-id",
        code: "auth-code",
        redirect_uri: "http://127.0.0.1:3333/callback",
        resource: "https://mcp.example.com/",
      });

      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        body: {
          error: "invalid_client",
        },
      };
    });

    const result = await runInvalidClientCheck({
      ...(baseNegativeInput as any),
      trackedRequest,
    });

    expect(result).toMatchObject({
      step: "oauth_invalid_client",
      status: "passed",
    });
  });

  it("includes resource in authorization_code invalid-redirect checks", async () => {
    const trackedRequest = jest.fn().mockImplementation(async (request) => {
      expect(request.body).toMatchObject({
        grant_type: "authorization_code",
        code: "auth-code",
        redirect_uri: "http://127.0.0.1:3333/callback?invalid=1",
        resource: "https://mcp.example.com/",
      });

      return {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        body: {
          error: "invalid_request",
          error_description: "redirect_uri mismatch",
        },
      };
    });

    const result = await runInvalidRedirectCheck({
      ...(baseNegativeInput as any),
      trackedRequest,
    });

    expect(result).toMatchObject({
      step: "oauth_invalid_redirect",
      status: "passed",
    });
  });

  it("passes when the MCP server rejects an invalid bearer token with HTTP 401", async () => {
    const result = await runInvalidTokenCheck({
      ...(baseNegativeInput as any),
      trackedRequest: jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        body: {
          error: "invalid_token",
        },
      }),
    });

    expect(result).toMatchObject({
      step: "oauth_invalid_token",
      status: "passed",
    });
  });

  it("probes 2026-07-28 with a stateless tools/list request, not initialize", async () => {
    const trackedRequest = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      body: { error: "invalid_token" },
    });

    const result = await runInvalidTokenCheck({
      ...(baseNegativeInput as any),
      config: {
        ...baseNegativeInput.config,
        protocolVersion: "2026-07-28",
      },
      trackedRequest,
    });

    const request = trackedRequest.mock.calls[0][0];
    expect(request.body.method).toBe("tools/list");
    expect(request.headers["Mcp-Method"]).toBe("tools/list");
    expect(request.headers["MCP-Protocol-Version"]).toBe("2026-07-28");
    // The 401 must still classify as a passing invalid-token check.
    expect(result).toMatchObject({
      step: "oauth_invalid_token",
      status: "passed",
    });
  });

  it("passes when the authorization endpoint rejects a mismatched redirect_uri", async () => {
    const result = await runInvalidAuthorizeRedirectCheck({
      ...(baseNegativeInput as any),
      state: {
        clientId: "registered-client",
        codeChallenge: "test-code-challenge",
        authorizationServerMetadata: {
          authorization_endpoint: "https://auth.example.com/authorize",
        },
      },
      trackedRequest: jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        headers: {},
        body: {
          error: "invalid_request",
          error_description: "redirect_uri mismatch",
        },
      }),
    });

    expect(result).toMatchObject({
      step: "oauth_invalid_authorize_redirect",
      status: "passed",
    });
  });

  it("skips authorization-endpoint redirect validation when the rejection is unrelated", async () => {
    const result = await runInvalidAuthorizeRedirectCheck({
      ...(baseNegativeInput as any),
      state: {
        clientId: "registered-client",
        codeChallenge: "test-code-challenge",
        authorizationServerMetadata: {
          authorization_endpoint: "https://auth.example.com/authorize",
        },
      },
      trackedRequest: jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        headers: {},
        body: {
          error: "invalid_scope",
          error_description: "Client is not allowed to request this scope",
        },
      }),
    });

    expect(result).toMatchObject({
      step: "oauth_invalid_authorize_redirect",
      status: "skipped",
      error: {
        message:
          "Authorization request was rejected for a non-redirect reason: Client is not allowed to request this scope",
      },
    });
  });

  it("fails when the authorization endpoint redirects to an invalid redirect_uri", async () => {
    const result = await runInvalidAuthorizeRedirectCheck({
      ...(baseNegativeInput as any),
      state: {
        clientId: "registered-client",
        codeChallenge: "test-code-challenge",
        authorizationServerMetadata: {
          authorization_endpoint: "https://auth.example.com/authorize",
        },
      },
      trackedRequest: jest.fn().mockResolvedValue({
        ok: false,
        status: 302,
        statusText: "Found",
        headers: {
          location: "http://127.0.0.1:3333/callback?invalid=1&error=invalid_request",
        },
        body: undefined,
      }),
    });

    expect(result).toMatchObject({
      step: "oauth_invalid_authorize_redirect",
      status: "failed",
      error: {
        message: expect.stringContaining("redirected the user agent"),
      },
    });
  });

  it("fails when the MCP server accepts an invalid bearer token", async () => {
    const result = await runInvalidTokenCheck({
      ...(baseNegativeInput as any),
      trackedRequest: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        body: {
          jsonrpc: "2.0",
          result: {},
        },
      }),
    });

    expect(result).toMatchObject({
      step: "oauth_invalid_token",
      status: "failed",
      error: {
        message: expect.stringContaining("expected HTTP 401"),
      },
    });
  });

  it("fails when dynamic client registration accepts a non-loopback http redirect URI", async () => {
    const result = await runDcrHttpRedirectUriCheck({
      ...(baseNegativeInput as any),
      state: {
        authorizationServerMetadata: {
          registration_endpoint: "https://auth.example.com/register",
        },
      },
      trackedRequest: jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        statusText: "Created",
        body: {
          client_id: "evil-client",
          redirect_uris: ["http://evil.example/callback"],
        },
      }),
    });

    expect(result).toMatchObject({
      step: "oauth_dcr_http_redirect_uri",
      status: "failed",
      error: {
        message:
          "Authorization server accepted a non-loopback http redirect_uri during dynamic client registration",
        details: expect.objectContaining({
          redirectUri: "http://evil.example/callback",
          clientId: "evil-client",
        }),
      },
    });
  });

  it("skips DCR redirect validation when the rejection is not redirect-specific", async () => {
    const result = await runDcrHttpRedirectUriCheck({
      ...(baseNegativeInput as any),
      state: {
        authorizationServerMetadata: {
          registration_endpoint: "https://auth.example.com/register",
        },
      },
      trackedRequest: jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        body: {
          error: "invalid_scope",
          error_description: "Client is not allowed to request this scope",
        },
      }),
    });

    expect(result).toMatchObject({
      step: "oauth_dcr_http_redirect_uri",
      status: "skipped",
      error: {
        message:
          "Dynamic client registration was rejected for a non-redirect reason: Client is not allowed to request this scope",
        details: expect.objectContaining({
          redirectUri: "http://evil.example/callback",
          evidence:
            "Received 400 Bad Request with Client is not allowed to request this scope.",
        }),
      },
    });
  });

  it("skips redirect validation when the token rejection is not redirect-specific", async () => {
    const result = await runInvalidRedirectCheck({
      ...(baseNegativeInput as any),
      trackedRequest: jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        body: {
          error: "invalid_grant",
          error_description: "Authorization code already used",
        },
      }),
    });

    expect(result).toMatchObject({
      step: "oauth_invalid_redirect",
      status: "skipped",
      error: {
        message:
          "Token request was rejected for a non-redirect reason: Authorization code already used",
        details: expect.objectContaining({
          evidence:
            "Received 400 Bad Request with Authorization code already used.",
        }),
      },
    });
  });

  it("treats expires_in as optional but validates its type when present", () => {
    const withoutExpires = runTokenFormatCheck({
      tokenRequestStep: {
        http: {
          response: {
            body: {
              access_token: "access-token",
              token_type: "Bearer",
            },
          },
        },
      } as any,
      state: {
        accessToken: undefined,
        tokenType: undefined,
        expiresIn: undefined,
      },
    });
    const invalidExpires = runTokenFormatCheck({
      tokenRequestStep: {
        http: {
          response: {
            body: {
              access_token: "access-token",
              token_type: "Bearer",
              expires_in: "3600",
            },
          },
        },
      } as any,
      state: {
        accessToken: undefined,
        tokenType: undefined,
        expiresIn: undefined,
      },
    });

    expect(withoutExpires.status).toBe("passed");
    expect(invalidExpires).toMatchObject({
      status: "failed",
      error: {
        message: expect.stringContaining("expires_in"),
      },
    });
  });
});

// ── Server-side spec obligations (HP-17 findings 3/4/5) ────────────────

const baseObligationInput = {
  config: {
    serverUrl: "https://mcp.example.com",
    protocolVersion: "2025-11-25",
    auth: { mode: "headless" },
  },
  state: {
    accessToken: "valid-access-token",
  },
};

const BEARER_WITH_METADATA =
  'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"';

describe("oauth server obligation checks", () => {
  // Finding 4 — unauthenticated request → 401 + Bearer challenge, never 500.
  describe("unauthenticated challenge", () => {
    it("sends no Authorization header on the probe", async () => {
      const trackedRequest = jest.fn().mockImplementation(async (request) => {
        expect(request.headers.Authorization).toBeUndefined();
        expect(request.method).toBe("POST");
        expect(request.url).toBe("https://mcp.example.com");
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: { "www-authenticate": BEARER_WITH_METADATA },
          body: { error: "unauthorized" },
        };
      });

      const result = await runUnauthenticatedChallengeCheck({
        ...(baseObligationInput as any),
        trackedRequest,
      });

      expect(result).toMatchObject({
        step: "oauth_unauthenticated_challenge",
        status: "passed",
      });
    });

    it("strips Authorization variants supplied via customHeaders", async () => {
      const trackedRequest = jest.fn().mockImplementation(async (request) => {
        const authKeys = Object.keys(request.headers).filter(
          (key: string) => key.toLowerCase() === "authorization",
        );
        expect(authKeys).toEqual([]);
        expect(request.headers["X-Gateway"]).toBe("bypass");
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: { "www-authenticate": BEARER_WITH_METADATA },
          body: { error: "unauthorized" },
        };
      });

      const result = await runUnauthenticatedChallengeCheck({
        ...(baseObligationInput as any),
        config: {
          ...baseObligationInput.config,
          customHeaders: {
            authorization: "Bearer gateway-bypass-token",
            "X-Gateway": "bypass",
          },
        },
        trackedRequest,
      });

      expect(result).toMatchObject({
        step: "oauth_unauthenticated_challenge",
        status: "passed",
      });
    });

    it("fails when the server returns 500 instead of 401", async () => {
      const result = await runUnauthenticatedChallengeCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          headers: {},
          body: "boom",
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_unauthenticated_challenge",
        status: "failed",
        error: { message: expect.stringContaining("instead of 401") },
      });
    });

    it("fails when a 401 omits the Bearer challenge", async () => {
      const result = await runUnauthenticatedChallengeCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockResolvedValue({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: {},
          body: { error: "unauthorized" },
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_unauthenticated_challenge",
        status: "failed",
        error: { message: expect.stringContaining("without a WWW-Authenticate Bearer challenge") },
      });
    });

    it("fails when a 401 challenge does not offer a Bearer scheme", async () => {
      const result = await runUnauthenticatedChallengeCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockResolvedValue({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: { "www-authenticate": 'Basic realm="mcp"' },
          body: { error: "unauthorized" },
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_unauthenticated_challenge",
        status: "failed",
        error: {
          message: expect.stringContaining("does not offer a Bearer challenge"),
        },
      });
    });

    it("skips when the server accepts an unauthenticated initialize", async () => {
      // Anonymous initialize is spec-legal (authorization may be enforced on
      // later requests), so a 2xx is unverifiable, not a violation — mirrors
      // the stale-session 2xx handling.
      const result = await runUnauthenticatedChallengeCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {},
          body: { jsonrpc: "2.0", result: {} },
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_unauthenticated_challenge",
        status: "skipped",
        error: {
          message: expect.stringContaining(
            "accepted an unauthenticated initialize",
          ),
        },
      });
    });

    it("still fails a non-401 rejection such as 403", async () => {
      const result = await runUnauthenticatedChallengeCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockResolvedValue({
          ok: false,
          status: 403,
          statusText: "Forbidden",
          headers: {},
          body: { error: "forbidden" },
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_unauthenticated_challenge",
        status: "failed",
        error: { message: expect.stringContaining("expected HTTP 401, received 403") },
      });
    });

    it("turns transport errors into failed checks", async () => {
      const result = await runUnauthenticatedChallengeCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockRejectedValue(new Error("timeout")),
      });

      expect(result).toMatchObject({
        step: "oauth_unauthenticated_challenge",
        status: "failed",
        error: { message: "Unauthenticated MCP request failed: timeout" },
      });
    });
  });

  // Finding 3 — Bearer challenge must carry an absolute resource_metadata URL.
  describe("resource metadata challenge", () => {
    it("passes when the challenge advertises an absolute resource_metadata URL", async () => {
      const result = await runResourceMetadataChallengeCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockResolvedValue({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: { "www-authenticate": BEARER_WITH_METADATA },
          body: undefined,
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_resource_metadata_challenge",
        status: "passed",
      });
    });

    it("fails when the challenge omits resource_metadata", async () => {
      const result = await runResourceMetadataChallengeCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockResolvedValue({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: { "www-authenticate": 'Bearer error="invalid_token"' },
          body: undefined,
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_resource_metadata_challenge",
        status: "failed",
        error: { message: expect.stringContaining("omitted the resource_metadata parameter") },
      });
    });

    it("fails when resource_metadata is a relative URL", async () => {
      const result = await runResourceMetadataChallengeCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockResolvedValue({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="/.well-known/oauth-protected-resource"',
          },
          body: undefined,
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_resource_metadata_challenge",
        status: "failed",
        error: { message: expect.stringContaining("must be an absolute http(s) URL") },
      });
    });

    it("skips when the challenge does not offer a Bearer scheme", async () => {
      const result = await runResourceMetadataChallengeCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockResolvedValue({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: { "www-authenticate": 'Basic realm="mcp"' },
          body: undefined,
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_resource_metadata_challenge",
        status: "skipped",
        error: {
          message: expect.stringContaining("does not offer a Bearer scheme"),
        },
      });
    });

    it("does not accept a lookalike parameter name for resource_metadata", async () => {
      const result = await runResourceMetadataChallengeCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockResolvedValue({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: {
            "www-authenticate":
              'Bearer x_resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
          body: undefined,
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_resource_metadata_challenge",
        status: "failed",
        error: {
          message: expect.stringContaining(
            "omitted the resource_metadata parameter",
          ),
        },
      });
    });

    it("skips on 2025-03-26, which predates RFC 9728, without probing", async () => {
      const trackedRequest = jest.fn();
      const result = await runResourceMetadataChallengeCheck({
        ...(baseObligationInput as any),
        config: {
          ...baseObligationInput.config,
          protocolVersion: "2025-03-26",
        },
        trackedRequest,
      });

      expect(result).toMatchObject({
        step: "oauth_resource_metadata_challenge",
        status: "skipped",
        error: { message: expect.stringContaining("predates RFC 9728") },
      });
      expect(trackedRequest).not.toHaveBeenCalled();
    });

    it("skips when there is no challenge to inspect", async () => {
      const result = await runResourceMetadataChallengeCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockResolvedValue({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: {},
          body: undefined,
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_resource_metadata_challenge",
        status: "skipped",
      });
    });
  });

  // Finding 5 — stale Mcp-Session-Id → 4xx (404 preferred), never 500.
  describe("stale session rejection", () => {
    it("sends a valid bearer token with an unknown Mcp-Session-Id", async () => {
      const trackedRequest = jest.fn().mockImplementation(async (request) => {
        expect(request.headers.Authorization).toBe("Bearer valid-access-token");
        expect(request.headers["Mcp-Session-Id"]).toBeDefined();
        expect(request.body).toMatchObject({ method: "tools/list" });
        return {
          ok: false,
          status: 404,
          statusText: "Not Found",
          headers: {},
          body: { error: "session not found" },
        };
      });

      const result = await runStaleSessionRejectionCheck({
        ...(baseObligationInput as any),
        trackedRequest,
      });

      expect(result).toMatchObject({
        step: "oauth_stale_session_rejection",
        status: "passed",
      });
      expect(result.error).toBeUndefined();
    });

    it("fails when the server crashes with a 500 on a stale session", async () => {
      const result = await runStaleSessionRejectionCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          headers: {},
          body: "stack trace",
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_stale_session_rejection",
        status: "failed",
        error: { message: expect.stringContaining("instead of a 4xx") },
      });
    });

    it("passes a non-404 4xx and records it as a warning, not an error", async () => {
      const result = await runStaleSessionRejectionCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockResolvedValue({
          ok: false,
          status: 400,
          statusText: "Bad Request",
          headers: {},
          body: { error: "bad session" },
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_stale_session_rejection",
        status: "passed",
        warnings: [expect.stringContaining("prefers 404")],
      });
      expect(result.error).toBeUndefined();
    });

    it("treats a 404 with an empty JSON object body as parseable", async () => {
      const result = await runStaleSessionRejectionCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockResolvedValue({
          ok: false,
          status: 404,
          statusText: "Not Found",
          headers: {},
          body: {},
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_stale_session_rejection",
        status: "passed",
      });
      expect(result.warnings).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it("warns when a 404 rejection has an empty body", async () => {
      const result = await runStaleSessionRejectionCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockResolvedValue({
          ok: false,
          status: 404,
          statusText: "Not Found",
          headers: {},
          body: "",
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_stale_session_rejection",
        status: "passed",
        warnings: [expect.stringContaining("empty or unparseable")],
      });
      expect(result.error).toBeUndefined();
    });

    it("skips when the server accepts an unknown session id", async () => {
      const result = await runStaleSessionRejectionCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {},
          body: { jsonrpc: "2.0", result: { tools: [] } },
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_stale_session_rejection",
        status: "skipped",
        error: { message: expect.stringContaining("does not appear to enforce session state") },
      });
    });

    it("skips on the stateless 2026-07-28 transport", async () => {
      const trackedRequest = jest.fn();
      const result = await runStaleSessionRejectionCheck({
        ...(baseObligationInput as any),
        config: {
          ...baseObligationInput.config,
          protocolVersion: "2026-07-28",
        },
        trackedRequest,
      });

      expect(result).toMatchObject({
        step: "oauth_stale_session_rejection",
        status: "skipped",
        error: { message: expect.stringContaining("stateless") },
      });
      expect(trackedRequest).not.toHaveBeenCalled();
    });

    it("redacts the access token from transport-failure details", async () => {
      const result = await runStaleSessionRejectionCheck({
        ...(baseObligationInput as any),
        trackedRequest: jest.fn().mockRejectedValue(new Error("timeout")),
      });

      expect(result).toMatchObject({
        step: "oauth_stale_session_rejection",
        status: "failed",
        error: { message: "Stale-session MCP request failed: timeout" },
      });
      const details = result.error?.details as {
        request: { headers: Record<string, string> };
      };
      expect(details.request.headers.Authorization).toBe("[REDACTED]");
      expect(JSON.stringify(details)).not.toContain("valid-access-token");
    });

    it("skips when no access token is available", async () => {
      const trackedRequest = jest.fn();
      const result = await runStaleSessionRejectionCheck({
        ...(baseObligationInput as any),
        state: {},
        trackedRequest,
      });

      expect(result).toMatchObject({
        step: "oauth_stale_session_rejection",
        status: "skipped",
        error: { message: expect.stringContaining("No access token") },
      });
      expect(trackedRequest).not.toHaveBeenCalled();
    });
  });
});

// ── Catalog-derived server obligations (HP-47 S13/S16) ─────────────────

const AS_ISSUER = "https://auth.example.com";
const AS_METADATA_URL = `${AS_ISSUER}/.well-known/oauth-authorization-server`;
const PRM_URL =
  "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
const PRM_RESOURCE = "https://mcp.example.com/mcp";

const baseCatalogInput = {
  config: {
    serverUrl: "https://mcp.example.com/mcp",
    protocolVersion: "2025-11-25",
    registrationStrategy: "dcr",
    auth: { mode: "headless" },
  },
  state: {},
};

/** A PRM document that was successfully fetched during the flow — the baseline
 * the stale-protocol-header check re-requests. */
const prmDiscoveredState = {
  resourceMetadataUrl: PRM_URL,
  resourceMetadata: { resource: PRM_RESOURCE },
};

/** No PRM, but an AS metadata document whose winning candidate URL is only
 * recoverable from the request history. */
const asDiscoveredState = {
  authorizationServerMetadata: {
    issuer: AS_ISSUER,
    registration_endpoint: `${AS_ISSUER}/register`,
  },
  httpHistory: [
    {
      step: "request_authorization_server_metadata",
      timestamp: 1,
      request: { method: "GET", url: AS_METADATA_URL, headers: {} },
      response: {
        status: 200,
        statusText: "OK",
        headers: {},
        body: { issuer: AS_ISSUER },
      },
    },
  ],
};

describe("oauth catalog obligation checks", () => {
  // S13 — the AS must advertise a registration_endpoint (RFC 7591 / RFC 8414).
  describe("authorization server registration endpoint", () => {
    it("passes when the AS advertises an absolute registration_endpoint", () => {
      const result = runAsRegistrationEndpointCheck({
        ...(baseCatalogInput as any),
        state: {
          authorizationServerMetadata: {
            issuer: AS_ISSUER,
            registration_endpoint: `${AS_ISSUER}/register`,
          },
        },
      });

      expect(result).toMatchObject({
        step: "oauth_as_registration_endpoint",
        status: "passed",
      });
      expect(result.warnings).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it("fails at error level when a DCR flow's AS omits registration_endpoint", () => {
      const result = runAsRegistrationEndpointCheck({
        ...(baseCatalogInput as any),
        state: {
          authorizationServerMetadata: {
            issuer: AS_ISSUER,
            authorization_endpoint: `${AS_ISSUER}/authorize`,
            token_endpoint: `${AS_ISSUER}/token`,
          },
        },
      });

      expect(result).toMatchObject({
        step: "oauth_as_registration_endpoint",
        status: "failed",
        error: {
          message: expect.stringContaining("omits registration_endpoint"),
          details: expect.objectContaining({
            issuer: AS_ISSUER,
            registrationStrategy: "dcr",
          }),
        },
      });
    });

    it("reports a warning instead of a failure when the flow did not need DCR", () => {
      // The obligation is about DCR-only clients in the catalog, so a CIMD run
      // still reports it — but the run itself proved the server usable, so it
      // must not go red.
      for (const registrationStrategy of ["cimd", "preregistered"]) {
        const result = runAsRegistrationEndpointCheck({
          ...(baseCatalogInput as any),
          config: {
            ...baseCatalogInput.config,
            registrationStrategy,
          },
          state: {
            authorizationServerMetadata: { issuer: AS_ISSUER },
          },
        });

        expect(result).toMatchObject({
          step: "oauth_as_registration_endpoint",
          status: "passed",
          warnings: [expect.stringContaining("DCR-only clients")],
        });
        expect(result.error).toBeUndefined();
      }
    });

    it("fails a relative registration_endpoint even when the flow did not need DCR", () => {
      // An advertised-but-unusable value is a defect in the published document,
      // not an absent capability, so it never softens to a warning.
      const result = runAsRegistrationEndpointCheck({
        ...(baseCatalogInput as any),
        config: {
          ...baseCatalogInput.config,
          registrationStrategy: "cimd",
        },
        state: {
          authorizationServerMetadata: {
            issuer: AS_ISSUER,
            registration_endpoint: "/register",
          },
        },
      });

      expect(result).toMatchObject({
        step: "oauth_as_registration_endpoint",
        status: "failed",
        error: {
          message: expect.stringContaining("must be an absolute http(s) URL"),
        },
      });
    });

    it("fails an empty-string registration_endpoint as advertised-but-unusable", () => {
      const result = runAsRegistrationEndpointCheck({
        ...(baseCatalogInput as any),
        state: {
          authorizationServerMetadata: {
            issuer: AS_ISSUER,
            registration_endpoint: "",
          },
        },
      });

      expect(result).toMatchObject({
        step: "oauth_as_registration_endpoint",
        status: "failed",
        error: {
          message: expect.stringContaining("must be an absolute http(s) URL"),
        },
      });
    });

    it("skips when authorization server metadata was never discovered", () => {
      const result = runAsRegistrationEndpointCheck({
        ...(baseCatalogInput as any),
        state: {},
      });

      expect(result).toMatchObject({
        step: "oauth_as_registration_endpoint",
        status: "skipped",
        error: { message: expect.stringContaining("never discovered") },
      });
    });
  });

  // S16 — discovery must tolerate rmcp's hardcoded MCP-Protocol-Version.
  describe("discovery stale protocol header", () => {
    it("re-requests the recorded PRM URL with rmcp's hardcoded protocol version", async () => {
      const trackedRequest = jest.fn().mockImplementation(async (request) => {
        expect(request.method).toBe("GET");
        expect(request.url).toBe(PRM_URL);
        expect(request.headers["MCP-Protocol-Version"]).toBe("2024-11-05");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {},
          body: { resource: PRM_RESOURCE, authorization_servers: [AS_ISSUER] },
        };
      });

      const result = await runDiscoveryStaleProtocolHeaderCheck({
        ...(baseCatalogInput as any),
        state: prmDiscoveredState,
        trackedRequest,
      });

      expect(trackedRequest).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        step: "oauth_discovery_stale_protocol_header",
        status: "passed",
      });
      expect(result.warnings).toBeUndefined();
    });

    it("keeps same-origin custom headers so the protocol header is the only change", async () => {
      const trackedRequest = jest.fn().mockImplementation(async (request) => {
        expect(request.headers["X-Gateway"]).toBe("bypass");
        expect(request.headers.Authorization).toBe("Bearer gateway-token");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {},
          body: { resource: PRM_RESOURCE },
        };
      });

      const result = await runDiscoveryStaleProtocolHeaderCheck({
        ...(baseCatalogInput as any),
        config: {
          ...baseCatalogInput.config,
          customHeaders: {
            Authorization: "Bearer gateway-token",
            "X-Gateway": "bypass",
          },
        },
        state: prmDiscoveredState,
        trackedRequest,
      });

      expect(result.status).toBe("passed");
    });

    it("falls back to the AS metadata URL recovered from the request history", async () => {
      const trackedRequest = jest.fn().mockImplementation(async (request) => {
        expect(request.url).toBe(AS_METADATA_URL);
        // Cross-origin document: a user-supplied Authorization must not leak to
        // the authorization server, exactly as the flow's own discovery leg does.
        expect(request.headers.Authorization).toBeUndefined();
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {},
          body: { issuer: AS_ISSUER, token_endpoint: `${AS_ISSUER}/token` },
        };
      });

      const result = await runDiscoveryStaleProtocolHeaderCheck({
        ...(baseCatalogInput as any),
        config: {
          ...baseCatalogInput.config,
          customHeaders: { Authorization: "Bearer gateway-token" },
        },
        state: asDiscoveredState,
        trackedRequest,
      });

      expect(result).toMatchObject({
        step: "oauth_discovery_stale_protocol_header",
        status: "passed",
      });
    });

    it("fails when the stale protocol header turns a working discovery URL into a non-2xx", async () => {
      const result = await runDiscoveryStaleProtocolHeaderCheck({
        ...(baseCatalogInput as any),
        state: prmDiscoveredState,
        trackedRequest: jest.fn().mockResolvedValue({
          ok: false,
          status: 400,
          statusText: "Bad Request",
          headers: {},
          body: { error: "unsupported_protocol_version" },
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_discovery_stale_protocol_header",
        status: "failed",
        error: {
          message: expect.stringContaining(
            "MCP-Protocol-Version: 2024-11-05, but succeeded without it",
          ),
          details: expect.objectContaining({
            discoveryUrl: PRM_URL,
            status: 400,
          }),
        },
      });
    });

    it("fails a 2xx whose body no longer carries the identifying field", async () => {
      const result = await runDiscoveryStaleProtocolHeaderCheck({
        ...(baseCatalogInput as any),
        state: prmDiscoveredState,
        trackedRequest: jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {},
          body: { error: "protocol version not supported" },
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_discovery_stale_protocol_header",
        status: "failed",
        error: {
          message: expect.stringContaining('no longer carries "resource"'),
        },
      });
    });

    it("fails a 2xx that answers with a non-JSON body", async () => {
      const result = await runDiscoveryStaleProtocolHeaderCheck({
        ...(baseCatalogInput as any),
        state: prmDiscoveredState,
        trackedRequest: jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {},
          body: "unsupported protocol version",
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_discovery_stale_protocol_header",
        status: "failed",
      });
    });

    it("passes with a warning when the header steers the server to a different document", async () => {
      const result = await runDiscoveryStaleProtocolHeaderCheck({
        ...(baseCatalogInput as any),
        state: prmDiscoveredState,
        trackedRequest: jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {},
          body: { resource: "https://legacy.example.com/mcp" },
        }),
      });

      expect(result).toMatchObject({
        step: "oauth_discovery_stale_protocol_header",
        status: "passed",
        warnings: [expect.stringContaining("changed from")],
      });
      expect(result.error).toBeUndefined();
    });

    it("skips without probing when no discovery document was fetched", async () => {
      const trackedRequest = jest.fn();
      const result = await runDiscoveryStaleProtocolHeaderCheck({
        ...(baseCatalogInput as any),
        state: {},
        trackedRequest,
      });

      expect(result).toMatchObject({
        step: "oauth_discovery_stale_protocol_header",
        status: "skipped",
        error: {
          message: expect.stringContaining("No discovery document"),
        },
      });
      expect(trackedRequest).not.toHaveBeenCalled();
    });

    it("skips when AS metadata exists but its successful URL is not in the history", async () => {
      // A 4xx candidate attempt is not the winning document, so it must not be
      // re-requested as if it had worked.
      const trackedRequest = jest.fn();
      const result = await runDiscoveryStaleProtocolHeaderCheck({
        ...(baseCatalogInput as any),
        state: {
          authorizationServerMetadata: { issuer: AS_ISSUER },
          httpHistory: [
            {
              step: "request_authorization_server_metadata",
              timestamp: 1,
              request: { method: "GET", url: AS_METADATA_URL, headers: {} },
              response: {
                status: 404,
                statusText: "Not Found",
                headers: {},
                body: { error: "not found" },
              },
            },
          ],
        },
        trackedRequest,
      });

      expect(result).toMatchObject({
        step: "oauth_discovery_stale_protocol_header",
        status: "skipped",
      });
      expect(trackedRequest).not.toHaveBeenCalled();
    });

    it("turns transport errors into failed checks", async () => {
      const result = await runDiscoveryStaleProtocolHeaderCheck({
        ...(baseCatalogInput as any),
        state: prmDiscoveredState,
        trackedRequest: jest.fn().mockRejectedValue(new Error("timeout")),
      });

      expect(result).toMatchObject({
        step: "oauth_discovery_stale_protocol_header",
        status: "failed",
        error: {
          message:
            "Discovery request with a stale MCP-Protocol-Version failed: timeout",
        },
      });
    });
  });
});
