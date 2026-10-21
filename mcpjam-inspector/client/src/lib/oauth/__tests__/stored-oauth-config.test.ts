import { describe, expect, it } from "vitest";
import {
  serializePublicConnectionSettings,
  parseStoredOAuthConfig,
} from "../stored-oauth-config";

describe("public connection settings persistence", () => {
  it("strips credential values even when extra fields reach the persistence boundary", () => {
    const input = {
      scopes: ["read", "percent%scope"],
      resourceUrl: "https://example.com/mcp?tenant=public",
      hasCustomHeaders: true,
      customHeaders: { "X-Key": "header-secret" },
      clientSecret: "client-secret",
      client_secret: "client-secret-alias",
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      secretPatch: { headers: { "X-Key": "patch-secret" } },
      env: { PRIVATE: "env-secret" },
      authorizationServerMetadata: { secret_extension: "metadata-secret" },
    };
    const json = serializePublicConnectionSettings(input);
    expect(JSON.parse(json)).toEqual({
      scopes: input.scopes,
      resourceUrl: input.resourceUrl,
      hasCustomHeaders: true,
    });
    expect(json).not.toContain("secret");
    expect(parseStoredOAuthConfig(JSON.parse(json)).scopes).toEqual(
      input.scopes,
    );
  });
  it.each([
    "https://user:password@example.com/mcp",
    "https://example.com/mcp?access_token=secret",
    "https://example.com/mcp?api_key=secret",
    "https://example.com/mcp#token=secret",
  ])("refuses to persist credentials in a resource URL: %s", (resourceUrl) => {
    expect(() => serializePublicConnectionSettings({ resourceUrl })).toThrow(
      "Resource URL contains credentials",
    );
  });
});
