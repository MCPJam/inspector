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

const ORIGINAL_HOSTED_MODE = process.env.VITE_MCPJAM_HOSTED_MODE;

afterEach(() => {
  vi.clearAllMocks();

  if (ORIGINAL_HOSTED_MODE === undefined) {
    delete process.env.VITE_MCPJAM_HOSTED_MODE;
  } else {
    process.env.VITE_MCPJAM_HOSTED_MODE = ORIGINAL_HOSTED_MODE;
  }
});

function createApp() {
  return new Hono().route("/api/mcp/oauth", oauth);
}

async function startDebugFlow(app: Hono, serverUrl: string): Promise<string> {
  const response = await app.request("/api/mcp/oauth/debug/flows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverUrl }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { flowId: string };
  return body.flowId;
}

describe("OAuth debugger private-origin policy", () => {
  it("automatically applies a server-owned exact origin to the debugger proxy only", async () => {
    delete process.env.VITE_MCPJAM_HOSTED_MODE;
    vi.mocked(executeDebugOAuthProxy).mockResolvedValue({} as never);
    vi.mocked(executeOAuthProxy).mockResolvedValue({
      finalUrl: "https://auth.example.com/token",
    } as never);

    const app = createApp();
    const debugFlowId = await startDebugFlow(app, "https://100.64.0.1/mcp");
    const request = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://100.64.0.1/mcp",
        debugFlowId,
        // This caller-supplied list must not affect the server-owned flow.
        allowedPrivateNetworkOrigins: ["https://10.0.0.99"],
      }),
    };

    await app.request("/api/mcp/oauth/debug/proxy", request);
    await app.request("/api/mcp/oauth/proxy", request);

    expect(executeDebugOAuthProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedPrivateNetworkOrigins: ["https://100.64.0.1"],
        url: "https://100.64.0.1/mcp",
      })
    );
    expect(executeOAuthProxy).toHaveBeenCalledWith({
      url: "https://100.64.0.1/mcp",
      method: undefined,
      body: undefined,
      headers: undefined,
    });
  });

  it("keeps debugger private targets disabled in hosted mode", async () => {
    process.env.VITE_MCPJAM_HOSTED_MODE = "true";
    vi.mocked(executeDebugOAuthProxy).mockResolvedValue({} as never);

    const app = createApp();
    const flowResponse = await app.request("/api/mcp/oauth/debug/flows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverUrl: "https://100.64.0.1/mcp" }),
    });
    expect(flowResponse.status).toBe(403);

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
      })
    );
  });

  it("keeps metadata fetching on the default private-target policy", async () => {
    vi.mocked(fetchOAuthMetadata).mockResolvedValue({
      metadata: {},
      finalUrl:
        "https://auth.example.com/.well-known/oauth-authorization-server",
    } as never);

    const app = createApp();
    await app.request(
      "/api/mcp/oauth/metadata?url=https%3A%2F%2F100.64.0.1%2F.well-known%2Foauth-authorization-server"
    );

    expect(fetchOAuthMetadata).toHaveBeenCalledWith(
      "https://100.64.0.1/.well-known/oauth-authorization-server"
    );
  });
});
