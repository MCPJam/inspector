import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import oauth from "../oauth.js";
import {
  executeDebugOAuthProxy,
  executeOAuthProxy,
  fetchOAuthMetadata,
} from "../../../utils/oauth-proxy.js";

vi.mock("../../../utils/oauth-proxy.js", () => ({
  OAuthProxyError: class OAuthProxyError extends Error {
    status = 400;
  },
  executeOAuthProxy: vi.fn(),
  executeDebugOAuthProxy: vi.fn(),
  fetchOAuthMetadata: vi.fn(),
}));

const ORIGINAL_ALLOW_PRIVATE_TARGETS = process.env.MCPJAM_ALLOW_PRIVATE_TARGETS;
const ORIGINAL_HOSTED_MODE = process.env.VITE_MCPJAM_HOSTED_MODE;

afterEach(() => {
  vi.clearAllMocks();

  if (ORIGINAL_ALLOW_PRIVATE_TARGETS === undefined) {
    delete process.env.MCPJAM_ALLOW_PRIVATE_TARGETS;
  } else {
    process.env.MCPJAM_ALLOW_PRIVATE_TARGETS = ORIGINAL_ALLOW_PRIVATE_TARGETS;
  }

  if (ORIGINAL_HOSTED_MODE === undefined) {
    delete process.env.VITE_MCPJAM_HOSTED_MODE;
  } else {
    process.env.VITE_MCPJAM_HOSTED_MODE = ORIGINAL_HOSTED_MODE;
  }
});

function createApp() {
  return new Hono().route("/api/mcp/oauth", oauth);
}

describe("OAuth debugger private-origin policy", () => {
  it("applies administrator-enabled exact origins to the debugger proxy only", async () => {
    process.env.MCPJAM_ALLOW_PRIVATE_TARGETS = "1";
    delete process.env.VITE_MCPJAM_HOSTED_MODE;
    vi.mocked(executeDebugOAuthProxy).mockResolvedValue({} as never);
    vi.mocked(executeOAuthProxy).mockResolvedValue({
      finalUrl: "https://auth.example.com/token",
    } as never);

    const app = createApp();
    const request = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://100.64.0.1/mcp",
        allowedPrivateNetworkOrigins: ["https://100.64.0.1"],
      }),
    };

    await app.request("/api/mcp/oauth/debug/proxy", request);
    await app.request("/api/mcp/oauth/proxy", request);

    expect(executeDebugOAuthProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedPrivateNetworkOrigins: ["https://100.64.0.1"],
        url: "https://100.64.0.1/mcp",
      }),
    );
    expect(executeOAuthProxy).toHaveBeenCalledWith({
      url: "https://100.64.0.1/mcp",
      method: undefined,
      body: undefined,
      headers: undefined,
    });
  });

  it("keeps debugger private targets disabled in hosted mode", async () => {
    process.env.MCPJAM_ALLOW_PRIVATE_TARGETS = "1";
    process.env.VITE_MCPJAM_HOSTED_MODE = "true";
    vi.mocked(executeDebugOAuthProxy).mockResolvedValue({} as never);

    const app = createApp();
    await app.request("/api/mcp/oauth/debug/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://100.64.0.1/mcp",
        allowedPrivateNetworkOrigins: ["https://100.64.0.1"],
      }),
    });

    expect(executeDebugOAuthProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedPrivateNetworkOrigins: [],
        url: "https://100.64.0.1/mcp",
      }),
    );
  });

  it("keeps metadata fetching on the default private-target policy", async () => {
    process.env.MCPJAM_ALLOW_PRIVATE_TARGETS = "1";
    vi.mocked(fetchOAuthMetadata).mockResolvedValue({
      metadata: {},
      finalUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
    } as never);

    const app = createApp();
    await app.request(
      "/api/mcp/oauth/metadata?url=https%3A%2F%2F100.64.0.1%2F.well-known%2Foauth-authorization-server",
    );

    expect(fetchOAuthMetadata).toHaveBeenCalledWith(
      "https://100.64.0.1/.well-known/oauth-authorization-server",
    );
  });
});
