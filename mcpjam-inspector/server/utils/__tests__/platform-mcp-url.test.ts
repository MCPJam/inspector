/**
 * Tests for resolvePlatformMcpUrl — the environment-keyed selection of the
 * platform MCP worker URL the Home/MCPJam agent connects to.
 *
 * `resolveEnvironment()` reads ENVIRONMENT / NODE_ENV at call time and the
 * resolver reads MCPJAM_PLATFORM_MCP_URL at call time, so each case saves and
 * restores those three env vars.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePlatformMcpUrl } from "../platform-mcp-url.js";

const LOCAL_URL = "http://localhost:8787/mcp";
const STAGING_URL = "https://mcp-staging.mcpjam.com/mcp";
const PROD_URL = "https://mcp.mcpjam.com/mcp";

describe("resolvePlatformMcpUrl", () => {
  let saved: {
    ENVIRONMENT?: string;
    NODE_ENV?: string;
    MCPJAM_PLATFORM_MCP_URL?: string;
  };

  beforeEach(() => {
    saved = {
      ENVIRONMENT: process.env.ENVIRONMENT,
      NODE_ENV: process.env.NODE_ENV,
      MCPJAM_PLATFORM_MCP_URL: process.env.MCPJAM_PLATFORM_MCP_URL,
    };
    delete process.env.ENVIRONMENT;
    delete process.env.NODE_ENV;
    delete process.env.MCPJAM_PLATFORM_MCP_URL;
  });

  afterEach(() => {
    for (const key of [
      "ENVIRONMENT",
      "NODE_ENV",
      "MCPJAM_PLATFORM_MCP_URL",
    ] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it.each([
    ["dev", LOCAL_URL],
    ["local", LOCAL_URL],
    ["test", LOCAL_URL],
    ["staging", STAGING_URL],
    ["preview", STAGING_URL],
    ["prod", PROD_URL],
  ])("ENVIRONMENT=%s resolves to %s", (env, expected) => {
    process.env.ENVIRONMENT = env;
    expect(resolvePlatformMcpUrl()).toBe(expected);
  });

  it("resolves to prod when ENVIRONMENT is unset and NODE_ENV=production", () => {
    process.env.NODE_ENV = "production";
    expect(resolvePlatformMcpUrl()).toBe(PROD_URL);
  });

  it("MCPJAM_PLATFORM_MCP_URL override wins regardless of ENVIRONMENT", () => {
    process.env.ENVIRONMENT = "prod";
    process.env.MCPJAM_PLATFORM_MCP_URL = "http://localhost:9999/mcp";
    expect(resolvePlatformMcpUrl()).toBe("http://localhost:9999/mcp");
  });

  it("ignores a whitespace-only override and falls back to the env mapping", () => {
    process.env.ENVIRONMENT = "staging";
    process.env.MCPJAM_PLATFORM_MCP_URL = "   ";
    expect(resolvePlatformMcpUrl()).toBe(STAGING_URL);
  });
});
