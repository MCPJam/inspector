/**
 * Harness proxy-token on `adapter-http` (LOCAL plane, validate-when-present).
 *
 * The relay edge binds every tunnel to `/api/mcp/adapter-http/{serverId}`, so
 * the local-desktop harness reuses that route. Its `X-MCPJam-Proxy-Token`
 * (header-only) — minted by Convex, verified here — is checked only WHEN
 * PRESENT: the harness always sends it; external MCP clients send none and are
 * unaffected.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { Hono } from "hono";
import {
  createMockMcpClientManager,
  createTestApp,
  expectJson,
  type MockMCPClientManager,
} from "./helpers/index.js";
import { signTestProxyToken } from "../../../utils/harness/__tests__/sign-test-token.js";

const mintLocal = (serverId: string) => signTestProxyToken({ serverId });

describe("adapter-http harness proxy-token (validate-when-present)", () => {
  let manager: MockMCPClientManager;
  let app: Hono;

  beforeAll(() => {
    process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "test-harness-proxy-secret-32-chars";
  });

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createMockMcpClientManager({
      listServers: vi.fn().mockReturnValue(["test-server"]),
      getManagedClient: vi
        .fn()
        .mockImplementation((id: string) =>
          id === "test-server" ? {} : undefined,
        ),
      hasServer: vi.fn().mockImplementation((id: string) => id === "test-server"),
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: "echo" }] }),
    });
    app = createTestApp(manager, ["adapter-http"]);
  });

  const toolsList = (headers: Record<string, string> = {}, query = "") =>
    app.request(`/api/mcp/adapter-http/test-server${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ id: 1, method: "tools/list", params: {} }),
    });

  it("200s for external clients (no token) — unaffected", async () => {
    const res = await toolsList();
    const { status, data } = await expectJson(res);
    expect(status).toBe(200);
    expect(data.result.tools).toEqual([{ name: "echo" }]);
  });

  it("401s when a token is supplied but invalid", async () => {
    const res = await toolsList({ "X-MCPJam-Proxy-Token": "nope" });
    expect(res.status).toBe(401);
  });

  it("200s with a valid token (header)", async () => {
    const res = await toolsList({ "X-MCPJam-Proxy-Token": mintLocal("test-server") });
    expect(res.status).toBe(200);
  });

  it("IGNORES a `?t=` query token (header-only, Phase 4) — treated as no token", async () => {
    // A bogus `?t=` would 401 if honored; header-only means it's ignored, so
    // the request is unauthenticated-but-present-free → passes through (200).
    const res = await toolsList({}, `?t=bogus`);
    expect(res.status).toBe(200);
  });

  it("401s a token minted for another server (server-scoped)", async () => {
    const res = await toolsList({ "X-MCPJam-Proxy-Token": mintLocal("other-server") });
    expect(res.status).toBe(401);
  });

  it("401s the GET (SSE) stream when an invalid token is supplied (header)", async () => {
    const res = await app.request("/api/mcp/adapter-http/test-server", {
      method: "GET",
      headers: { "X-MCPJam-Proxy-Token": "bogus" },
    });
    expect(res.status).toBe(401);
  });
});
