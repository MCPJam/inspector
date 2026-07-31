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
import { InsufficientScopeError } from "@modelcontextprotocol/client";
import {
  createMockMcpClientManager,
  createTestApp,
  expectJson,
  type MockMCPClientManager,
} from "./helpers/index.js";
import { signTestProxyToken } from "../../../utils/harness/__tests__/sign-test-token.js";
import {
  __resetHarnessScopeStepUpForTests,
  HARNESS_SCOPE_STEP_UP_CORRELATION_HEADER,
  HARNESS_SCOPE_STEP_UP_CORRELATION_QUERY,
  subscribeHarnessScopeStepUp,
} from "../../../utils/harness/harness-scope-step-up.js";

const mintLocal = (serverId: string) => signTestProxyToken({ serverId });
const TURN_ID = "11111111-1111-4111-8111-111111111111";

describe("adapter-http harness proxy-token (validate-when-present)", () => {
  let manager: MockMCPClientManager;
  let app: Hono;

  beforeAll(() => {
    process.env.COMPUTERS_TERMINAL_TOKEN_SECRET =
      "test-harness-proxy-secret-32-chars";
  });

  beforeEach(() => {
    vi.clearAllMocks();
    __resetHarnessScopeStepUpForTests();
    manager = createMockMcpClientManager({
      listServers: vi.fn().mockReturnValue(["test-server"]),
      getManagedClient: vi
        .fn()
        .mockImplementation((id: string) =>
          id === "test-server" ? {} : undefined
        ),
      hasServer: vi
        .fn()
        .mockImplementation((id: string) => id === "test-server"),
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
    const res = await toolsList({
      "X-MCPJam-Proxy-Token": mintLocal("test-server"),
    });
    expect(res.status).toBe(200);
  });

  it("IGNORES a `?t=` query token (header-only, Phase 4) — treated as no token", async () => {
    // A bogus `?t=` would 401 if honored; header-only means it's ignored, so
    // the request is unauthenticated-but-present-free → passes through (200).
    const res = await toolsList({}, `?t=bogus`);
    expect(res.status).toBe(200);
  });

  it("401s a token minted for another server (server-scoped)", async () => {
    const res = await toolsList({
      "X-MCPJam-Proxy-Token": mintLocal("other-server"),
    });
    expect(res.status).toBe(401);
  });

  it("401s the GET (SSE) stream when an invalid token is supplied (header)", async () => {
    const res = await app.request("/api/mcp/adapter-http/test-server", {
      method: "GET",
      headers: { "X-MCPJam-Proxy-Token": "bogus" },
    });
    expect(res.status).toBe(401);
  });

  it("forwards an actionable direct-POST tool error from the URL correlation", async () => {
    const challenge = new InsufficientScopeError({
      requiredScope: "bench:write",
      resourceMetadataUrl: new URL(
        "https://bench.example/.well-known/oauth-protected-resource"
      ),
    });
    manager.executeTool.mockRejectedValueOnce(challenge);
    const received: unknown[] = [];
    subscribeHarnessScopeStepUp(TURN_ID, (info) => received.push(info));

    const res = await app.request(
      `/api/mcp/adapter-http/test-server?${HARNESS_SCOPE_STEP_UP_CORRELATION_QUERY}=${TURN_ID}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "call-1",
          method: "tools/call",
          params: { name: "bench_write", arguments: { value: "x" } },
        }),
      }
    );

    const { status, data } = await expectJson(res);
    expect(status).toBe(200);
    expect(data.error.code).toBe(-32000);
    expect(received).toEqual([
      {
        serverId: "test-server",
        toolCallId: "call-1",
        requiredScope: "bench:write",
        resourceMetadataUrl:
          "https://bench.example/.well-known/oauth-protected-resource",
        errorDescription: undefined,
        toolName: "bench_write",
        toolInput: { value: "x" },
      },
    ]);
  });

  it("retains the turn correlation across the legacy SSE messages endpoint", async () => {
    manager.executeTool.mockRejectedValueOnce(
      new InsufficientScopeError({ requiredScope: "bench:write" })
    );
    const received: unknown[] = [];
    subscribeHarnessScopeStepUp(TURN_ID, (info) => received.push(info));

    const streamResponse = await app.request(
      `/api/mcp/adapter-http/test-server?${HARNESS_SCOPE_STEP_UP_CORRELATION_QUERY}=${TURN_ID}`,
      {
        method: "GET",
      }
    );
    const reader = streamResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (let i = 0; i < 8; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("sessionId=")) break;
    }
    const sessionId = /sessionId=([^"&\s]+)/.exec(buffer)?.[1];
    expect(sessionId).toBeTruthy();

    const messageResponse = await app.request(
      `/api/mcp/adapter-http/test-server/messages?sessionId=${encodeURIComponent(
        sessionId!
      )}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "bench_write", arguments: { value: "x" } },
        }),
      }
    );
    expect(messageResponse.status).toBe(202);
    expect(received).toEqual([
      {
        serverId: "test-server",
        toolCallId: "7",
        requiredScope: "bench:write",
        resourceMetadataUrl: undefined,
        errorDescription: undefined,
        toolName: "bench_write",
        toolInput: { value: "x" },
      },
    ]);
    await reader.cancel();
  });

  it("does not forward ordinary or errorDescription-only failures", async () => {
    const received: unknown[] = [];
    subscribeHarnessScopeStepUp(TURN_ID, (info) => received.push(info));
    for (const error of [
      new Error("ordinary failure"),
      new InsufficientScopeError({
        errorDescription: "More access is required",
      }),
    ]) {
      manager.executeTool.mockRejectedValueOnce(error);
      const res = await app.request("/api/mcp/adapter-http/test-server", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [HARNESS_SCOPE_STEP_UP_CORRELATION_HEADER]: TURN_ID,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: { name: "bench_write", arguments: {} },
        }),
      });
      expect(res.status).toBe(200);
    }
    expect(received).toEqual([]);
  });
});
