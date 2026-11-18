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
  runUnauthenticatedChallengeCheck,
} from "../../src/oauth-conformance/checks/oauth-server-obligations.js";
import { runStaleSessionRejectionCheck } from "../../src/oauth-conformance/checks/oauth-stale-session.js";

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

    it("probes 2026-07-28 with a stateless tools/list request, not initialize", async () => {
      const trackedRequest = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: { "www-authenticate": BEARER_WITH_METADATA },
        body: { error: "unauthorized" },
      });

      const result = await runUnauthenticatedChallengeCheck({
        ...(baseObligationInput as any),
        config: {
          ...baseObligationInput.config,
          protocolVersion: "2026-07-28",
        },
        trackedRequest,
      });

      const request = trackedRequest.mock.calls[0][0];
      expect(request.body.method).toBe("tools/list");
      expect(request.headers["Mcp-Method"]).toBe("tools/list");
      expect(request.headers["MCP-Protocol-Version"]).toBe("2026-07-28");
      expect(request.headers.Authorization).toBeUndefined();
      expect(result).toMatchObject({
        step: "oauth_unauthenticated_challenge",
        status: "passed",
      });
    });

    it("sends one Mcp-Method and one MCP-Protocol-Version when customHeaders use another case", async () => {
      const trackedRequest = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: { "www-authenticate": BEARER_WITH_METADATA },
        body: { error: "unauthorized" },
      });

      await runUnauthenticatedChallengeCheck({
        ...(baseObligationInput as any),
        config: {
          ...baseObligationInput.config,
          protocolVersion: "2026-07-28",
          customHeaders: {
            "mcp-method": "initialize",
            "mcp-protocol-version": "2025-11-25",
            "X-Gateway": "bypass",
          },
        },
        trackedRequest,
      });

      const headers: Record<string, string> =
        trackedRequest.mock.calls[0][0].headers;
      const valuesFor = (name: string) =>
        Object.entries(headers)
          .filter(([key]) => key.toLowerCase() === name)
          .map(([, value]) => value);
      expect(valuesFor("mcp-method")).toEqual(["tools/list"]);
      expect(valuesFor("mcp-protocol-version")).toEqual(["2026-07-28"]);
      expect(headers["X-Gateway"]).toBe("bypass");
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

    it("skips on 2026-07-28 when the stateless probe is served without a token", async () => {
      const trackedRequest = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {},
        body: { jsonrpc: "2.0", id: 1001, result: { tools: [] } },
      });

      const result = await runUnauthenticatedChallengeCheck({
        ...(baseObligationInput as any),
        config: {
          ...baseObligationInput.config,
          protocolVersion: "2026-07-28",
        },
        trackedRequest,
      });

      expect(trackedRequest.mock.calls[0][0].body.method).toBe("tools/list");
      expect(result).toMatchObject({
        step: "oauth_unauthenticated_challenge",
        status: "skipped",
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

    it("passes on 2026-07-28, probing with the stateless tools/list", async () => {
      const trackedRequest = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: { "www-authenticate": BEARER_WITH_METADATA },
        body: undefined,
      });

      const result = await runResourceMetadataChallengeCheck({
        ...(baseObligationInput as any),
        config: {
          ...baseObligationInput.config,
          protocolVersion: "2026-07-28",
        },
        trackedRequest,
      });

      const request = trackedRequest.mock.calls[0][0];
      expect(request.body.method).toBe("tools/list");
      expect(request.headers["Mcp-Method"]).toBe("tools/list");
      expect(request.headers["MCP-Protocol-Version"]).toBe("2026-07-28");
      expect(result).toMatchObject({
        step: "oauth_resource_metadata_challenge",
        status: "passed",
      });
    });

    it("passes an omitted resource_metadata on 2026-07-28 when a well-known URI serves the metadata", async () => {
      const trackedRequest = jest.fn().mockImplementation(async (request) => {
        if (request.url.includes("/.well-known/oauth-protected-resource")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
            body: {
              resource: "https://mcp.example.com/api/mcp",
              authorization_servers: ["https://as.example.com"],
            },
          };
        }
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: { "www-authenticate": 'Bearer error="invalid_token"' },
          body: undefined,
        };
      });

      const result = await runResourceMetadataChallengeCheck({
        ...(baseObligationInput as any),
        config: {
          ...(baseObligationInput.config as any),
          serverUrl: "https://mcp.example.com/api/mcp",
          protocolVersion: "2026-07-28",
        },
        trackedRequest,
      });

      // 2026-07-28, like 2025-11-25, sanctions the well-known URI as the
      // second discovery mechanism.
      expect(result).toMatchObject({
        step: "oauth_resource_metadata_challenge",
        status: "passed",
        warnings: [expect.stringContaining("well-known URI")],
      });
    });

    it("fails an omitted resource_metadata outright on 2025-06-18, where the header is a flat MUST", async () => {
      const trackedRequest = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: { "www-authenticate": 'Bearer error="invalid_token"' },
        body: undefined,
      });
      const result = await runResourceMetadataChallengeCheck({
        ...(baseObligationInput as any),
        config: {
          ...(baseObligationInput.config as any),
          protocolVersion: "2025-06-18",
        },
        trackedRequest,
      });

      expect(result).toMatchObject({
        step: "oauth_resource_metadata_challenge",
        status: "failed",
        error: {
          message: expect.stringContaining("2025-06-18 requires the header"),
        },
      });
      // The flat MUST needs no fallback probing: one request, no well-known.
      expect(trackedRequest).toHaveBeenCalledTimes(1);
    });

    it("passes an omitted resource_metadata on 2025-11-25 when a well-known URI serves the metadata, path-scoped first", async () => {
      const requested: string[] = [];
      const trackedRequest = jest.fn().mockImplementation(async (request) => {
        requested.push(request.url);
        if (request.url.includes("/.well-known/oauth-protected-resource")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
            body: {
              resource: "https://mcp.example.com/api/mcp",
              authorization_servers: ["https://as.example.com"],
            },
          };
        }
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: { "www-authenticate": 'Bearer error="invalid_token"' },
          body: undefined,
        };
      });

      const result = await runResourceMetadataChallengeCheck({
        ...(baseObligationInput as any),
        config: {
          ...(baseObligationInput.config as any),
          serverUrl: "https://mcp.example.com/api/mcp",
        },
        trackedRequest,
      });

      expect(result).toMatchObject({
        step: "oauth_resource_metadata_challenge",
        status: "passed",
        warnings: [expect.stringContaining("well-known URI")],
      });
      // 2025-11-25 lists the path-scoped URI before the root.
      const wellKnownRequests = requested.filter((url) =>
        url.includes("/.well-known/"),
      );
      expect(wellKnownRequests[0]).toBe(
        "https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp",
      );
    });

    it("fails on 2025-11-25 when the header is omitted and no well-known URI serves real metadata", async () => {
      // A 200 that is NOT protected-resource metadata (an SPA index page)
      // must not count as the second mechanism.
      const trackedRequest = jest.fn().mockImplementation(async (request) => {
        if (request.url.includes("/.well-known/")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "text/html" },
            body: "<html>app shell</html>",
          };
        }
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: { "www-authenticate": 'Bearer error="invalid_token"' },
          body: undefined,
        };
      });

      const result = await runResourceMetadataChallengeCheck({
        ...(baseObligationInput as any),
        trackedRequest,
      });

      expect(result).toMatchObject({
        step: "oauth_resource_metadata_challenge",
        status: "failed",
        error: {
          message: expect.stringContaining("provides neither"),
        },
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
        // A lookalike parameter is an omission; on 2025-11-25 that cascades
        // into the well-known probe, and this mock serves neither mechanism.
        error: {
          message: expect.stringContaining("provides neither"),
        },
      });
    });

    it("fails an EMPTY resource_metadata as present-but-invalid, even with valid well-known metadata", async () => {
      const trackedRequest = jest.fn().mockImplementation(async (request) => {
        if (request.url.includes("/.well-known/")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
            body: { resource: "https://mcp.example.com" },
          };
        }
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: { "www-authenticate": 'Bearer resource_metadata=""' },
          body: undefined,
        };
      });

      const result = await runResourceMetadataChallengeCheck({
        ...(baseObligationInput as any),
        trackedRequest,
      });

      // A present-but-empty parameter is a malformed challenge, not an
      // omission — the well-known fallback must not launder it into a pass.
      expect(result).toMatchObject({
        step: "oauth_resource_metadata_challenge",
        status: "failed",
        error: {
          message: expect.stringContaining("must be an absolute http(s) URL"),
        },
      });
    });

    it("holds a well-known 200 to RFC 9728: JSON media type and a resource that identifies the server under test", async () => {
      const requested: Array<{ url: string; headers: Record<string, string> }> = [];
      const trackedRequest = jest.fn().mockImplementation(async (request) => {
        requested.push({ url: request.url, headers: request.headers });
        if (request.url.endsWith("/.well-known/oauth-protected-resource/api/mcp")) {
          // JSON-looking body under the wrong media type (§3.2).
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "text/html" },
            body: '{"resource":"https://mcp.example.com/api/mcp"}',
          };
        }
        if (request.url.endsWith("/.well-known/oauth-protected-resource")) {
          // Right media type, but metadata for a DIFFERENT resource (§3.3).
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
            body: { resource: "https://other.example.com/mcp" },
          };
        }
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: { "www-authenticate": 'Bearer error="invalid_token"' },
          body: undefined,
        };
      });

      const result = await runResourceMetadataChallengeCheck({
        ...(baseObligationInput as any),
        config: {
          ...(baseObligationInput.config as any),
          serverUrl: "https://mcp.example.com/api/mcp",
          customHeaders: {
            "x-gateway-key": "route-me",
            Authorization: "Bearer must-not-leak",
          },
        },
        trackedRequest,
      });

      expect(result).toMatchObject({
        step: "oauth_resource_metadata_challenge",
        status: "failed",
        error: { message: expect.stringContaining("provides neither") },
      });
      const details = (result as any).error?.details;
      expect(JSON.stringify(details)).toContain("not application/json");
      expect(JSON.stringify(details)).toContain("different resource");

      // The probe carries the run's routing headers but never credentials.
      const wellKnown = requested.filter((r) => r.url.includes("/.well-known/"));
      expect(wellKnown.length).toBeGreaterThan(0);
      for (const request of wellKnown) {
        expect(request.headers["x-gateway-key"]).toBe("route-me");
        expect(
          Object.keys(request.headers).some(
            (key) => key.toLowerCase() === "authorization",
          ),
        ).toBe(false);
      }
    });

    it("inserts the well-known segment before both path and query", async () => {
      const requested: string[] = [];
      const trackedRequest = jest.fn().mockImplementation(async (request) => {
        requested.push(request.url);
        if (request.url.includes("/.well-known/")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
            body: { resource: "https://mcp.example.com/api/mcp?tenant=a" },
          };
        }
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: { "www-authenticate": 'Bearer error="invalid_token"' },
          body: undefined,
        };
      });

      const result = await runResourceMetadataChallengeCheck({
        ...(baseObligationInput as any),
        config: {
          ...(baseObligationInput.config as any),
          serverUrl: "https://mcp.example.com/api/mcp?tenant=a",
        },
        trackedRequest,
      });

      expect(result.status).toBe("passed");
      // RFC 9728 §3: the well-known segment precedes path AND query.
      expect(requested).toContain(
        "https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp?tenant=a",
      );
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

  // Finding 5 — an ended session's id must be answered with exactly 404.
  // basic/transports#session-management: "The server MAY terminate the session
  // at any time, after which it MUST respond to requests containing that
  // session ID with HTTP 404 Not Found."
  describe("stale session rejection", () => {
    type Reply = {
      status: number;
      headers?: Record<string, string>;
      body?: unknown;
    };

    /** A server that opens a session, then answers the DELETE and the request
     * that follows it however the test says. */
    function sessionServer(replies: {
      initialize?: Reply;
      terminate?: Reply;
      afterTermination?: Reply;
    }) {
      const requests: Array<{
        method: string;
        rpcMethod?: string;
        sessionId?: string;
        authorization?: string;
        protocolVersion?: string;
      }> = [];
      const respond = (reply: Reply) => ({
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        statusText: "",
        headers: reply.headers ?? {},
        body: reply.body,
      });
      const trackedRequest = jest.fn().mockImplementation(async (request) => {
        const rpcMethod = request.body?.method as string | undefined;
        requests.push({
          method: request.method,
          rpcMethod,
          sessionId: request.headers["Mcp-Session-Id"],
          authorization: request.headers.Authorization,
          protocolVersion: request.headers["MCP-Protocol-Version"],
        });
        if (request.method === "DELETE") {
          return respond(replies.terminate ?? { status: 200 });
        }
        if (rpcMethod === "initialize") {
          return respond(
            replies.initialize ?? {
              status: 200,
              headers: { "mcp-session-id": "session-abc" },
              body: { jsonrpc: "2.0", id: 1002, result: { protocolVersion: request.body.params.protocolVersion } },
            },
          );
        }
        if (rpcMethod === "notifications/initialized") {
          return respond({ status: 202 });
        }
        return respond(replies.afterTermination ?? { status: 404 });
      });
      return { trackedRequest, requests };
    }

    it("uses the negotiated version after a downgrade, including SSE replies", async () => {
      const { trackedRequest, requests } = sessionServer({ initialize: {
        status: 200, headers: { "mcp-session-id": "session-abc" },
        body: 'data: {"jsonrpc":"2.0","id":1002,"result":{"protocolVersion":"2025-06-18"}}\n\n',
      }});
      await runStaleSessionRejectionCheck({ ...baseObligationInput, trackedRequest });
      expect(requests.slice(1).map(r => r.protocolVersion)).toEqual([
        "2025-06-18", "2025-06-18", "2025-06-18",
      ]);
    });

    for (const version of ["2025-03-26", "2025-06-18"] as const) {
      it(`initializes using the selected ${version} revision`, async () => {
        const { trackedRequest } = sessionServer({});
        await runStaleSessionRejectionCheck({
          ...baseObligationInput,
          config: { ...baseObligationInput.config, protocolVersion: version },
          trackedRequest,
        });
        expect(trackedRequest.mock.calls[0][0].body.params.protocolVersion).toBe(version);
      });
    }

    it("ends a real session and passes when the ended id gets 404", async () => {
      const { trackedRequest, requests } = sessionServer({
        afterTermination: { status: 404, body: { error: "session not found" } },
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
      expect(result.warnings).toBeUndefined();
      // Initialize, finish the handshake, end the session, then reuse its id.
      expect(requests).toEqual([
        {
          method: "POST",
          rpcMethod: "initialize",
          sessionId: undefined,
          authorization: "Bearer valid-access-token",
          protocolVersion: "2025-11-25",
        },
        {
          method: "POST",
          rpcMethod: "notifications/initialized",
          sessionId: "session-abc",
          authorization: "Bearer valid-access-token",
          protocolVersion: "2025-11-25",
        },
        {
          method: "DELETE",
          rpcMethod: undefined,
          sessionId: "session-abc",
          authorization: "Bearer valid-access-token",
          protocolVersion: "2025-11-25",
        },
        {
          method: "POST",
          rpcMethod: "ping",
          sessionId: "session-abc",
          authorization: "Bearer valid-access-token",
          protocolVersion: "2025-11-25",
        },
      ]);
    });

    it("passes a 404 whatever its body, since the spec mandates none", async () => {
      const { trackedRequest } = sessionServer({
        afterTermination: { status: 404, body: "" },
      });
      const result = await runStaleSessionRejectionCheck({
        ...(baseObligationInput as any),
        trackedRequest,
      });

      expect(result).toMatchObject({
        step: "oauth_stale_session_rejection",
        status: "passed",
      });
      expect(result.warnings).toBeUndefined();
    });

    for (const status of [400, 401, 403, 410, 500, 200]) {
      it(`fails when the ended session id gets HTTP ${status} instead of 404`, async () => {
        const { trackedRequest } = sessionServer({
          afterTermination: { status, body: { error: "nope" } },
        });
        const result = await runStaleSessionRejectionCheck({
          ...(baseObligationInput as any),
          trackedRequest,
        });

        expect(result).toMatchObject({
          step: "oauth_stale_session_rejection",
          status: "failed",
          error: {
            message: expect.stringContaining(
              `returned HTTP ${status} for a request carrying the session id it had just ended`,
            ),
            details: { status, deleteStatus: 200 },
          },
        });
        expect(result.error?.message).toContain("requires HTTP 404 Not Found");
      });
    }

    it("reads the session id header whatever its casing", async () => {
      const { trackedRequest, requests } = sessionServer({
        initialize: {
          status: 200,
          headers: { "Mcp-Session-Id": "Session-XYZ" },
          body: { jsonrpc: "2.0", id: 1002, result: { protocolVersion: "2025-11-25" } },
        },
      });
      const result = await runStaleSessionRejectionCheck({
        ...(baseObligationInput as any),
        trackedRequest,
      });

      expect(result.status).toBe("passed");
      expect(requests.at(-1)).toMatchObject({
        rpcMethod: "ping",
        sessionId: "Session-XYZ",
      });
    });

    it("skips a server that assigns no session id, which is allowed", async () => {
      const { trackedRequest, requests } = sessionServer({
        initialize: { status: 200, headers: {}, body: {} },
      });
      const result = await runStaleSessionRejectionCheck({
        ...(baseObligationInput as any),
        trackedRequest,
      });

      expect(result).toMatchObject({
        step: "oauth_stale_session_rejection",
        status: "skipped",
        error: {
          message: expect.stringContaining("did not assign an Mcp-Session-Id"),
        },
      });
      // Nothing is sent under a session that does not exist.
      expect(requests.map((request) => request.rpcMethod)).toEqual([
        "initialize",
      ]);
    });

    it("skips a server that refuses the client DELETE with 405, which is allowed", async () => {
      const { trackedRequest, requests } = sessionServer({
        terminate: { status: 405 },
      });
      const result = await runStaleSessionRejectionCheck({
        ...(baseObligationInput as any),
        trackedRequest,
      });

      expect(result).toMatchObject({
        step: "oauth_stale_session_rejection",
        status: "skipped",
        error: {
          message: expect.stringContaining("session DELETE with HTTP 405"),
        },
      });
      // The session is still live, so its id is never graded as an ended one.
      expect(requests.some((request) => request.rpcMethod === "ping")).toBe(
        false,
      );
    });

    it("skips when the authenticated initialize is refused", async () => {
      const { trackedRequest } = sessionServer({
        initialize: { status: 403, body: { error: "forbidden" } },
      });
      const result = await runStaleSessionRejectionCheck({
        ...(baseObligationInput as any),
        trackedRequest,
      });

      expect(result).toMatchObject({
        step: "oauth_stale_session_rejection",
        status: "skipped",
        error: {
          message: expect.stringContaining("no session could be opened"),
        },
      });
    });

    it("omits MCP-Protocol-Version on 2025-03-26, which has no such header", async () => {
      const { trackedRequest, requests } = sessionServer({});
      const result = await runStaleSessionRejectionCheck({
        ...(baseObligationInput as any),
        config: {
          ...baseObligationInput.config,
          protocolVersion: "2025-03-26",
        },
        trackedRequest,
      });

      expect(result.status).toBe("passed");
      expect(requests.map((request) => request.protocolVersion)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
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
