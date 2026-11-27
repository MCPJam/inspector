/**
 * Conformance on a local Inspector against a saved mock connected as any
 * saved server is: the route reads the manager's config, whose address is the
 * mock's placeholder, so the suite must reach it through the config's
 * in-process door. The sign-in and directory checks refuse a mock by name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { MCPClientManager, type MCPServerConfig } from "@mcpjam/sdk";
import type { MockDefinition } from "@mcpjam/sdk/mocks";
import { startTicketHttp, type RunningTicketServer } from "./helpers/ticket-server.js";
import { stubMockBackend, type MockBackendStub } from "./helpers/mock-backend-stub.js";
import { registerMockInProcessHandler } from "../../../services/mock/registry.js";
import { inProcessMockHandler } from "../../../services/mock/route.js";
import { resolveLocalServerForConnect } from "../../../utils/local-server-resolver.js";
import conformance from "../conformance.js";

const definition: MockDefinition = {
  tools: {
    lookup_ticket: {
      description: "Reads a ticket (mock).",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      answer: { from: "saved", cases: [{ when: { id: "123" }, result: { content: [{ type: "text", text: "saved 123" }] } }] },
    },
  },
};

let http: RunningTicketServer & { url: string };
let backend: MockBackendStub;
let manager: MCPClientManager;
let app: Hono;

const post = (path: string, body: Record<string, unknown>) =>
  app.request(`/api/mcp/conformance${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serverId: "mock", ...body }),
  });

beforeEach(async () => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  http = await startTicketHttp();
  backend = stubMockBackend({ definition, base: { transportType: "http", url: http.url } });
  registerMockInProcessHandler(inProcessMockHandler());
  const ctx = { set: () => {}, get: () => undefined } as never;
  const { config } = await resolveLocalServerForConnect(ctx, "person-bearer", "proj1", "mock-row", {
    serverDisplayName: "Tickets (mock)",
  });
  manager = new MCPClientManager();
  await manager.connectToServer("mock", config as MCPServerConfig);
  app = new Hono();
  app.use("*", async (c, next) => {
    (c as unknown as { mcpClientManager: MCPClientManager }).mcpClientManager = manager;
    await next();
  });
  app.route("/api/mcp/conformance", conformance);
});

afterEach(async () => {
  await manager.disconnectAllServers();
  registerMockInProcessHandler(undefined);
  backend.restore();
  vi.unstubAllEnvs();
  await http.close();
});

describe("local conformance of a mock", () => {
  it("checks the connection and runs protocol checks through the mock's door", async () => {
    const connection = await post("/connection-check", { protocolVersion: "auto" });
    expect(await connection.json()).toMatchObject({ status: "ready" });

    const response = await post("/protocol", { checkIds: ["tools-list", "tools-input-schemas-valid"] });
    const { result } = await response.json();
    const outcome = Object.fromEntries(result.checks.map((check: { id: string; status: string }) => [check.id, check.status]));
    expect(outcome).toMatchObject({ "tools-list": "passed", "tools-input-schemas-valid": "passed" });
    expect(backend.placeholderRequests).toEqual([]);
  });

  it("refuses the sign-in checks and directory readiness, naming the mock", async () => {
    const oauth = await post("/oauth/start", { callbackOrigin: "https://app.example" });
    expect(oauth.status).toBe(400);
    expect((await oauth.json()).error).toMatch(/mock server has none/);

    const readiness = await post("/readiness/claude", {});
    expect(readiness.status).toBe(400);
    expect((await readiness.json()).error).toMatch(/mock server is served only to you/);
    expect(backend.placeholderRequests).toEqual([]);
  });
});
