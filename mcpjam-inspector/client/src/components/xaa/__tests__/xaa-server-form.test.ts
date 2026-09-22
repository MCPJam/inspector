import { describe, expect, it } from "vitest";
import { buildXaaServerFormData, type XaaServerFormInput } from "../xaa-server-form";

function createInput(overrides: Partial<XaaServerFormInput> = {}): XaaServerFormInput {
  return {
    name: "xaa-server",
    url: "https://example.com/mcp",
    clientId: "client_abc",
    clientSecret: "",
    clearClientSecret: false,
    hasClientSecret: false,
    oauthScopes: [],
    authzIssuer: "",
    allowPathScopedIssuer: false,
    identity: { dirty: false, subject: "", email: "" },
    identityAssertionFormat: "oidc",
    registration: { dirty: false, strategy: "preregistered" },
    ...overrides,
  };
}

describe("buildXaaServerFormData", () => {
  it("preserves leading/trailing whitespace in a typed replacement secret", () => {
    // Trimming here would silently authenticate with a different secret than
    // the one the user typed into the XAA debugger's Configure Server modal.
    const result = buildXaaServerFormData(
      createInput({ clientSecret: " secret " }),
    );

    expect(result.clientSecret).toBe(" secret ");
  });

  it("treats a whitespace-only secret as no replacement, letting Clear take effect", () => {
    const result = buildXaaServerFormData(
      createInput({ clientSecret: "   ", clearClientSecret: true }),
    );

    expect(result).not.toHaveProperty("clientSecret");
    expect(result.clearClientSecret).toBe(true);
  });

  it("lets a typed replacement win over the Clear toggle", () => {
    const result = buildXaaServerFormData(
      createInput({ clientSecret: "new-secret", clearClientSecret: true }),
    );

    expect(result.clientSecret).toBe("new-secret");
    expect(result).not.toHaveProperty("clearClientSecret");
  });
});
