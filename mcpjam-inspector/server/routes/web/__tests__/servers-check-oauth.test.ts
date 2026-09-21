import { describe, expect, it, vi } from "vitest";

vi.mock("../../apps/SandboxProxyHtml.bundled.js", () => ({
  MCP_APPS_SANDBOX_PROXY_HTML: "<html></html>",
}));

import { buildOAuthRequirementProjection } from "../servers.js";

/**
 * SUTB-9: the scenario auth gate used to read `useOAuth`, which a stored `auto`
 * row also carries. The projection has to keep answering that mirror for
 * existing consumers while reporting the upfront requirement separately.
 */
describe("check-oauth authorization requirement projection", () => {
  it("does not require authorization for a discover row that mirrors useOAuth", () => {
    expect(
      buildOAuthRequirementProjection({
        authMethod: "auto",
        useOAuth: true,
        url: "https://stateless.mcpjam.com/mcp",
      })
    ).toEqual({
      useOAuth: true,
      requiresAuthorization: false,
      effectiveAuthMethod: "discover",
      serverUrl: "https://stateless.mcpjam.com/mcp",
    });
  });

  it("requires authorization for a row whose stored auth method is oauth", () => {
    expect(
      buildOAuthRequirementProjection({
        authMethod: "oauth",
        useOAuth: true,
        url: "https://mcp.asana.com/sse",
      })
    ).toEqual({
      useOAuth: true,
      requiresAuthorization: true,
      effectiveAuthMethod: "oauth",
      serverUrl: "https://mcp.asana.com/sse",
    });
  });

  it("does not require authorization for an explicitly auth-less row", () => {
    expect(
      buildOAuthRequirementProjection({
        authMethod: "none",
        url: "https://stateless.mcpjam.com/mcp",
      })
    ).toMatchObject({
      useOAuth: false,
      requiresAuthorization: false,
      effectiveAuthMethod: "none",
    });
  });

  it("still resolves a legacy row that only has the compat booleans", () => {
    expect(
      buildOAuthRequirementProjection({
        useOAuth: true,
        url: "https://mcp.asana.com/sse",
      })
    ).toMatchObject({
      requiresAuthorization: true,
      effectiveAuthMethod: "oauth",
    });
    expect(
      buildOAuthRequirementProjection({
        useXaa: true,
        url: "https://mcp.example.com/mcp",
      })
    ).toMatchObject({
      requiresAuthorization: false,
      effectiveAuthMethod: "xaa",
    });
  });
});
