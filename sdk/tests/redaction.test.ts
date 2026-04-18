import { redactSensitiveValue } from "../src/redaction";

describe("redactSensitiveValue", () => {
  it("redacts standalone OAuth authorization codes and code verifiers", () => {
    expect(
      redactSensitiveValue({
        code: "splxlOBeZQQYbYS6WxSbIA",
        codeVerifier: "verifier-secret",
      })
    ).toEqual({
      code: "[REDACTED]",
      codeVerifier: "[REDACTED]",
    });
  });

  it("preserves ordinary structured error codes", () => {
    expect(
      redactSensitiveValue({
        error: { code: "INTERNAL_ERROR" },
        snapshotError: { code: "TIMEOUT" },
      })
    ).toEqual({
      error: { code: "INTERNAL_ERROR" },
      snapshotError: { code: "TIMEOUT" },
    });
  });

  it("redacts nested doctor auth headers and token-like values", () => {
    expect(
      redactSensitiveValue({
        probe: {
          transport: {
            attempts: [
              {
                request: {
                  headers: {
                    Authorization: "Bearer oauth-token",
                    Cookie: "session=secret",
                  },
                },
              },
            ],
          },
        },
        oauthAccessToken: "oauth-token",
        refreshToken: "refresh-secret",
        clientSecret: "client-secret",
        note: "Authorization: Bearer oauth-token access_token=oauth-token refresh_token=refresh-secret",
      })
    ).toEqual({
      probe: {
        transport: {
          attempts: [
            {
              request: {
                headers: {
                  Authorization: "[REDACTED]",
                  Cookie: "[REDACTED]",
                },
              },
            },
          ],
        },
      },
      oauthAccessToken: "[REDACTED]",
      refreshToken: "[REDACTED]",
      clientSecret: "[REDACTED]",
      note: "Authorization: [REDACTED]",
    });
  });
});
