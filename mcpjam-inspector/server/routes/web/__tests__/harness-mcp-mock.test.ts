/**
 * A mock attached to a hosted harness client (Claude Code, Codex, OpenCode).
 * The sandbox only ever holds the proxy URL and a token naming the caller; the
 * proxy rebuilds that caller's authorized connection, so the mock row is
 * dialed through the in-process door with a grant minted for that caller,
 * never at its placeholder address and never as an ordinary server row. The
 * backend is a stub and the base is the ticket fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { MockDefinition } from "@mcpjam/sdk/mocks";
import { startTicketHttp, type RunningTicketServer } from "../../mcp/__tests__/helpers/ticket-server.js";
import { stubMockBackend, type MockBackendStub } from "../../mcp/__tests__/helpers/mock-backend-stub.js";
import { signTestProxyToken } from "../../../utils/harness/__tests__/sign-test-token.js";
import { registerMockInProcessHandler } from "../../../services/mock/registry.js";
import { inProcessMockHandler } from "../../../services/mock/route.js";
import { harnessMcp } from "../harness-mcp.js";

const definition: MockDefinition = {
  tools: {
    lookup_ticket: {
      description: "Reads a ticket (mock).",
      answer: { from: "saved", cases: [{ when: { id: "123" }, result: { content: [{ type: "text", text: "saved 123" }] } }] },
    },
  },
};

const app = new Hono();
app.route("/api/web/harness-mcp", harnessMcp);

let http: RunningTicketServer & { url: string };
let backend: MockBackendStub;

const token = () =>
  signTestProxyToken({ serverId: "mock-row", projectId: "proj1", externalId: "user_ext_1", orgId: "org_1" });

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const response = await app.request("/api/web/harness-mcp/mock-row", {
    method: "POST",
    headers: { "content-type": "application/json", "X-MCPJam-Proxy-Token": token() },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", "test-harness-proxy-secret-32-chars");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token-for-harness-tests");
  http = await startTicketHttp();
  backend = stubMockBackend({ definition, base: { transportType: "http", url: http.url } });
  registerMockInProcessHandler(inProcessMockHandler());
});

afterEach(async () => {
  registerMockInProcessHandler(undefined);
  backend.restore();
  vi.unstubAllEnvs();
  await http.close();
});

describe("a mock behind the harness proxy", () => {
  it("serves its tools as the token's caller, in process", async () => {
    const listed = await rpc("tools/list");
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining(["lookup_ticket", "echo"]),
    );

    const saved = await rpc("tools/call", { name: "lookup_ticket", arguments: { id: "123" } });
    expect(saved.body.result.content[0].text).toBe("saved 123");
    expect(http.dispatchCount()).toBe(0);

    // An uncovered call is forwarded to the real server, as the same caller.
    const forwarded = await rpc("tools/call", { name: "lookup_ticket", arguments: { id: "456" } });
    expect(forwarded.body.result.content[0].text).toContain('"status":"open"');
    expect(http.store.dispatches).toEqual([{ tool: "lookup_ticket", arguments: { id: "456" } }]);

    // The door resolved the mock with the grant, acting as the token's user.
    const resolved = backend.calls.filter((call) => call.path === "/web/mock/resolve");
    expect(resolved.length).toBeGreaterThan(0);
    for (const call of resolved) {
      expect(call.body).toEqual({ grant: "grant-1" });
      expect(call.headers["x-mcpjam-acting-as"]).toBe("user_ext_1");
      expect(call.headers["x-mcpjam-acting-in-org"]).toBe("org_1");
    }
    expect(backend.placeholderRequests).toEqual([]);
  });

  it("serves nothing when the backend refuses the mock to the caller, as for any refused server", async () => {
    backend.authorizeRefusal =
      "Mock servers are not available to guest sessions. Sign in and use the mock from your project.";
    const listed = await rpc("tools/list");
    // The proxy answers every refused server with its one generic error.
    expect(listed.body.error).toMatchObject({ message: "harness proxy error" });
    expect(listed.body.result).toBeUndefined();
    expect(backend.calls.some((call) => call.path === "/web/mock/resolve")).toBe(false);
    expect(backend.placeholderRequests).toEqual([]);
  });

  it("stops serving the moment the workspace blocks forwarding for a live call, and answers saved calls", async () => {
    backend.forwarding = "block";
    const forwarded = await rpc("tools/call", { name: "lookup_ticket", arguments: { id: "456" } });
    expect(forwarded.body.result.isError).toBe(true);
    const saved = await rpc("tools/call", { name: "lookup_ticket", arguments: { id: "123" } });
    expect(saved.body.result.content[0].text).toBe("saved 123");
    expect(http.dispatchCount()).toBe(0);
  });
});
