import {
  runDcrHttpRedirectUriCheck,
  runInvalidAuthorizeRedirectCheck,
  runInvalidClientCheck,
  runInvalidTokenCheck,
  runInvalidRedirectCheck,
} from "../../src/oauth-conformance/checks/oauth-negative.js";
import { runTokenFormatCheck } from "../../src/oauth-conformance/checks/oauth-token-format.js";
import {
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

    it("fails when the server accepts an unauthenticated request", async () => {
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
        status: "failed",
        error: { message: expect.stringContaining("expected HTTP 401, received 200") },
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

    it("passes a non-404 4xx but records it as evidence only", async () => {
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
        error: { message: expect.stringContaining("prefers 404") },
      });
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
