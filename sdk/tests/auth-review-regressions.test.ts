import { scopeFallbackWarning } from "../src/claude-readiness/checks/scope-fallback.js";
import { describe, expect, it } from "vitest";
import { parseToolResultAuthChallenge } from "../src/mcp-client-manager/auth-challenge.js";
import { mapInternalCode, V1_ERROR_STATUS } from "../src/public-api/index.js";
import { findPublishedResourceMetadata } from "../src/oauth-conformance/published-resource-metadata.js";
import type { TrackedRequestFn } from "../src/oauth-conformance/types.js";

describe("auth boundary review regressions", () => {
  it("warns when a challenge has no scope and metadata has no fallback", () => {
    const evidence = {
      enteredUrl: "https://example.com/mcp",
      unauthenticated: { status: 401, wwwAuthenticate: "Bearer" },
    };
    expect(scopeFallbackWarning(evidence)?.detail).toContain("names no scope");
    expect(
      scopeFallbackWarning({
        ...evidence,
        prm: {
          discoveredVia: "www-authenticate",
          document: { scopes_supported: ["read"] },
        },
      })
    ).toBeUndefined();
  });
  it("does not accept arbitrary JSON as protected resource metadata", async () => {
    const calls: string[] = [];
    const request: TrackedRequestFn = async (request) => {
      calls.push(request.url);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {},
        body:
          calls.length === 1
            ? { healthy: true }
            : {
                resource: "https://example.com/mcp",
                authorization_servers: ["https://auth.example.com"],
              },
      };
    };
    expect(
      await findPublishedResourceMetadata(
        { serverUrl: "https://example.com/mcp" },
        request
      )
    ).toBe("https://example.com/.well-known/oauth-protected-resource");
    expect(calls).toHaveLength(2);
  });
  it("recognizes OpenAI's single-quoted meta example", () => {
    expect(
      parseToolResultAuthChallenge({
        isError: true,
        _meta: {
          "mcp/www_authenticate": [
            '\'Bearer resource_metadata="https://example.com/prm", error="insufficient_scope", error_description="Sign in"\'',
          ],
        },
      })
    ).toMatchObject({
      facets: {
        challengeHeader: "bearer",
        hasResourceMetadata: true,
        hasErrorParams: true,
      },
    });
  });
  it("keeps AUTH_REQUIRED out of internal-error responses", () => {
    expect(mapInternalCode("AUTH_REQUIRED")).toBe("AUTH_REQUIRED");
    expect(V1_ERROR_STATUS[mapInternalCode("AUTH_REQUIRED")]).toBe(403);
  });
});
