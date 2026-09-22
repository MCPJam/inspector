import { redactForTelemetry } from "../src/telemetry-redaction";

describe("redactForTelemetry", () => {
  it("redacts standalone OAuth authorization codes and code verifiers", () => {
    expect(
      redactForTelemetry({
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
      redactForTelemetry({
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
      redactForTelemetry({
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

  it("keeps the scheme word's own sentence while still redacting credentials", () => {
    // "Bearer token required" is the hosted 401's copy, not a header: the old
    // rule rewrote the noun after `Bearer` and published "Bearer [REDACTED]
    // required" into the error banner. Both halves in one case so a future
    // loosening of the prose check has to keep the credential covered.
    expect(
      redactForTelemetry({
        serverMessage: "Bearer token required",
        clientMessage: "request failed: Bearer eyJhbGciOi.J9.sig rejected",
      })
    ).toEqual({
      serverMessage: "Bearer token required",
      clientMessage: "request failed: Bearer [REDACTED] rejected",
    });
  });

  it("preserves boolean token summary fields while redacting actual token strings", () => {
    expect(
      redactForTelemetry({
        target: {
          hasAccessToken: false,
          hasRefreshToken: true,
          hasClientSecret: false,
        },
        oauthAccessToken: "oauth-token",
      })
    ).toEqual({
      target: {
        hasAccessToken: false,
        hasRefreshToken: true,
        hasClientSecret: false,
      },
      oauthAccessToken: "[REDACTED]",
    });
  });
});
