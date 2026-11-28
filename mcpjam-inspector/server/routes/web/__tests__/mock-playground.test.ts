/**
 * Playground and the Tools tab against a saved mock: the same hosted routes
 * and the same local resolver any saved server goes through. The mock's tool
 * answers locally or forwards, and its prompts, resources and an app's page
 * come from the real server through the mock, as the caller. Nothing may
 * request the mock's placeholder address.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { MCPClientManager, type MCPServerConfig } from "@mcpjam/sdk";
import type { MockDefinition } from "@mcpjam/sdk/mocks";
import { stubMockBackend, type MockBackendStub } from "../../mcp/__tests__/helpers/mock-backend-stub.js";
import { registerMockInProcessHandler } from "../../../services/mock/registry.js";
import { inProcessMockHandler } from "../../../services/mock/route.js";
import { resolveLocalServerForConnect } from "../../../utils/local-server-resolver.js";
import tools from "../tools.js";
import prompts from "../prompts.js";
import resources from "../resources.js";

const APP_URI = "ui://tickets/view";
const APP_HTML = "<html><body>tickets</body></html>";

/** A base with every family Playground reads: a tool, an app tool, a prompt, a note and an app page. */
function buildBase(dispatches: string[]) {
  const server = new McpServer(
    { name: "rich-base", version: "1.0.0" },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );
  server.registerTool("echo", { description: "Echoes.", inputSchema: {} }, async () => {
    dispatches.push("echo");
    return { content: [{ type: "text" as const, text: "echo from base" }] };
  });
  server.registerPrompt("greet", { description: "Greets." }, async () => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text: "hello from base" } }],
  }));
  server.registerResource("note", "note://welcome", { mimeType: "text/plain" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: "welcome note" }],
  }));
  server.registerResource("view", APP_URI, { mimeType: "text/html;profile=mcp-app" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/html;profile=mcp-app", text: APP_HTML }],
  }));
  return server;
}

const definition: MockDefinition = {
  tools: {
    // An app's result carries its page's address in `_meta`, which the mock keeps.
    show_ticket: {
      description: "Shows a ticket (mock).",
      inputSchema: { type: "object", properties: {} },
      answer: {
        from: "saved",
        cases: [
          {
            result: {
              content: [{ type: "text", text: "ticket 123" }],
              _meta: { ui: { resourceUri: APP_URI } },
            },
          },
        ],
      },
    },
  },
};

let dispatches: string[];
let base: { url: string; close(): Promise<void> };
let backend: MockBackendStub;

const hostedApp = new Hono();
hostedApp.route("/tools", tools);
hostedApp.route("/prompts", prompts);
hostedApp.route("/resources", resources);

/** What the browser's Playground and Tools tab post to the hosted app. */
function hosted() {
  const call = async (path: string, body: Record<string, unknown>) => {
    const response = await hostedApp.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer person-bearer" },
      body: JSON.stringify({ projectId: "proj1", serverId: "mock-row", ...body }),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  return {
    tools: async () => (await call("/tools/list", {})).tools.map((tool: { name: string }) => tool.name),
    listMulti: async () => {
      const body = await call("/tools/list-multi", { serverIds: ["mock-row"] });
      return { names: body.results["mock-row"].tools.map((tool: { name: string }) => tool.name), errors: body.errors };
    },
    run: async (toolName: string) => (await call("/tools/execute", { toolName, parameters: {} })).result,
    prompts: async () => (await call("/prompts/list", {})).prompts.map((p: { name: string }) => p.name),
    prompt: async (promptName: string) => (await call("/prompts/get", { promptName })).content,
    resources: async () => (await call("/resources/list", {})).resources.map((r: { uri: string }) => r.uri),
    read: async (uri: string) => (await call("/resources/read", { uri })).content,
    close: async () => {},
  };
}

/** What a local Playground does: resolve the saved server on this device and connect. */
async function local() {
  const ctx = { set: () => {}, get: () => undefined } as never;
  const { config } = await resolveLocalServerForConnect(ctx, "person-bearer", "proj1", "mock-row", {
    serverDisplayName: "Tickets (mock)",
  });
  const manager = new MCPClientManager();
  await manager.connectToServer("mock", config as MCPServerConfig);
  return {
    tools: async () => (await manager.listTools("mock")).tools.map((tool) => tool.name),
    run: (toolName: string) => manager.executeTool("mock", toolName, {}),
    prompts: async () => (await manager.listPrompts("mock")).prompts.map((p) => p.name),
    prompt: (name: string) => manager.getPrompt("mock", { name }),
    resources: async () => (await manager.listResources("mock")).resources.map((r) => r.uri),
    read: (uri: string) => manager.readResource("mock", { uri }),
    close: () => manager.disconnectAllServers(),
  };
}

beforeEach(async () => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  dispatches = [];
  const handler = createMcpHandler(() => buildBase(dispatches), { legacy: "stateless" });
  const http = serve({ fetch: (request) => handler.fetch(request), port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => http.once("listening", () => resolve()));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise<void>((r) => http.close(() => r())) };
  backend = stubMockBackend({ definition, base: { transportType: "http", url: base.url } });
  registerMockInProcessHandler(inProcessMockHandler());
});

afterEach(async () => {
  registerMockInProcessHandler(undefined);
  backend.restore();
  vi.unstubAllEnvs();
  await base.close();
});

describe.each([
  ["the hosted Tools tab and Playground", hosted],
  ["a local Playground", local],
])("%s, connected to a mock", (_name, connect) => {
  it("lists the mock's tool beside the base's, and answers a saved case without the base", async () => {
    const client = await connect();
    expect(await client.tools()).toEqual(expect.arrayContaining(["show_ticket", "echo"]));
    const result = (await client.run("show_ticket")) as { content: Array<{ text: string }>; _meta: unknown };
    expect(result.content[0].text).toBe("ticket 123");
    expect(result._meta).toMatchObject({ ui: { resourceUri: APP_URI } });
    expect(dispatches).toEqual([]);
    await client.close();
  });

  it("forwards a base tool as the caller", async () => {
    const client = await connect();
    const result = (await client.run("echo")) as { content: Array<{ text: string }> };
    expect(result.content[0].text).toBe("echo from base");
    expect(dispatches).toEqual(["echo"]);
    await client.close();
  });

  it("serves the base's prompts through the mock", async () => {
    const client = await connect();
    expect(await client.prompts()).toEqual(["greet"]);
    expect(JSON.stringify(await client.prompt("greet"))).toContain("hello from base");
    await client.close();
  });

  it("serves the base's resources and the page of an app named by a result's metadata", async () => {
    const client = await connect();
    expect(await client.resources()).toEqual(expect.arrayContaining(["note://welcome", APP_URI]));
    expect(JSON.stringify(await client.read("note://welcome"))).toContain("welcome note");
    const page = JSON.stringify(await client.read(APP_URI));
    expect(page).toContain("text/html;profile=mcp-app");
    expect(page).toContain("tickets");
    await client.close();
  });

  it("lists the mock's tools in the batch the Playground Tools pane sends", async () => {
    const client = await connect();
    const listing = await client.listMulti?.();
    if (listing) {
      expect(listing.errors ?? {}).toEqual({});
      expect(listing.names).toEqual(expect.arrayContaining(["show_ticket", "echo"]));
    }
    await client.close();
    expect(backend.placeholderRequests).toEqual([]);
  });

  it("never requests the placeholder address", async () => {
    const client = await connect();
    await client.tools();
    await client.run("show_ticket");
    await client.close();
    expect(backend.placeholderRequests).toEqual([]);
  });
});
