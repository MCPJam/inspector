import {
  runInvalidClientCheck,
  runInvalidRedirectCheck,
} from "../../src/oauth-conformance/checks/oauth-negative.js";
import { runTokenFormatCheck } from "../../src/oauth-conformance/checks/oauth-token-format.js";

const baseNegativeInput = {
  config: {
    serverUrl: "https://mcp.example.com",
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
