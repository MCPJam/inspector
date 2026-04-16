import { redactSensitiveValue } from "../src/redaction";

describe("redactSensitiveValue", () => {
  it("redacts standalone OAuth authorization codes and code verifiers", () => {
    expect(
      redactSensitiveValue({
        code: "splxlOBeZQQYbYS6WxSbIA",
        codeVerifier: "verifier-secret",
      }),
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
      }),
    ).toEqual({
      error: { code: "INTERNAL_ERROR" },
      snapshotError: { code: "TIMEOUT" },
    });
  });
});
