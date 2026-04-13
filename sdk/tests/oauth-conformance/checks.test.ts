import {
  runDcrHttpRedirectUriCheck,
  runInvalidAuthorizeRedirectCheck,
  runInvalidClientCheck,
  runInvalidTokenCheck,
  runInvalidRedirectCheck,
} from "../../src/oauth-conformance/checks/oauth-negative.js";
import { runTokenFormatCheck } from "../../src/oauth-conformance/checks/oauth-token-format.js";

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
