import { describe, expect, it } from "vitest";
import { normalizeImportHostedOAuthTokens } from "@/lib/apis/hosted-oauth-import-tokens-api";

describe("normalizeImportHostedOAuthTokens", () => {
  it("returns null when input is not an object", () => {
    expect(normalizeImportHostedOAuthTokens(null)).toBeNull();
    expect(normalizeImportHostedOAuthTokens(undefined)).toBeNull();
    expect(normalizeImportHostedOAuthTokens("not an object")).toBeNull();
    expect(normalizeImportHostedOAuthTokens(42)).toBeNull();
  });

  it("returns null when access_token is missing or non-string", () => {
    expect(normalizeImportHostedOAuthTokens({})).toBeNull();
    expect(
      normalizeImportHostedOAuthTokens({ access_token: undefined }),
    ).toBeNull();
    expect(normalizeImportHostedOAuthTokens({ access_token: 123 })).toBeNull();
    expect(normalizeImportHostedOAuthTokens({ access_token: null })).toBeNull();
  });

  it("returns just access_token when no other fields are present", () => {
    expect(
      normalizeImportHostedOAuthTokens({ access_token: "tok" }),
    ).toEqual({ access_token: "tok" });
  });

  it("includes string-typed optional fields", () => {
    const out = normalizeImportHostedOAuthTokens({
      access_token: "tok",
      refresh_token: "ref",
      token_type: "Bearer",
      scope: "read write",
      id_token: "id",
    });
    expect(out).toEqual({
      access_token: "tok",
      refresh_token: "ref",
      token_type: "Bearer",
      scope: "read write",
      id_token: "id",
    });
  });

  it("includes expires_in only when it is a number", () => {
    expect(
      normalizeImportHostedOAuthTokens({
        access_token: "tok",
        expires_in: 3600,
      }),
    ).toEqual({ access_token: "tok", expires_in: 3600 });
    // string expires_in ignored
    expect(
      normalizeImportHostedOAuthTokens({
        access_token: "tok",
        expires_in: "3600",
      }),
    ).toEqual({ access_token: "tok" });
  });

  it("drops non-string optional fields silently", () => {
    expect(
      normalizeImportHostedOAuthTokens({
        access_token: "tok",
        refresh_token: 42,
        token_type: null,
        scope: undefined,
        id_token: false,
      }),
    ).toEqual({ access_token: "tok" });
  });

  it("ignores extra unknown fields", () => {
    const out = normalizeImportHostedOAuthTokens({
      access_token: "tok",
      not_a_real_field: "drop me",
      __proto__: "not picked up",
    });
    expect(out).toEqual({ access_token: "tok" });
  });
});
