import { resolveEffectiveClientCapabilities } from "../../../../client/src/lib/effective-client";
import { toMCPServerConfig } from "../../../utils/local-server-resolver";
import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebSocket } from "ws";
import { createLocalMrtrStream } from "../../web/local-mrtr-stream";
import { generateSessionToken } from "../../../services/session-token";
import { localMrtrMessageSchema, localMrtrProtocols, type LocalMrtrMessage } from "@/shared/local-mrtr-wire";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  requestFormInput,
  type OpenAIForm,
} from "@openai/mcp-extensions/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MCPClientManager } from "@mcpjam/sdk";
import {
  registerLocalMrtrCollector,
  withLocalMrtrElicitationCapability,
} from "../mrtr";

const schema = {
  type: "object",
  properties: {
    name: { type: "string", pattern: "^[A-Z]+$" },
    revision: { type: "integer", minimum: 0 },
    approved: { type: "boolean" },
    date: { type: "string", format: "date" },
  },
  required: ["name", "revision", "approved", "date"],
} satisfies OpenAIForm;

async function fixture() {
  let calls = 0;
  const capabilities: unknown[] = [];
  const server = http.createServer(
    toNodeHandler(
      createMcpHandler(() => {
        const mcp = new McpServer(
          { name: "manual-review", version: "1" },
          { capabilities: { tools: {} } },
        );
        mcp.registerTool("review", {}, async (ctx) => {
          calls++;
          const envelope = ctx.mcpReq.envelope;
          capabilities.push(envelope && "io.modelcontextprotocol/clientCapabilities" in envelope
            ? envelope["io.modelcontextprotocol/clientCapabilities"] : undefined);
          const form = requestFormInput(ctx, {
            key: "review",
            mode: "form",
            message: "Review the fixture",
            requestedSchema: schema,
          });
          if ("resultType" in form) return form;
          return {
            content: [],
            structuredContent:
              form.action === "accept" ? form.content : { action: form.action },
          };
        });
        return mcp;
      }),
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    capabilities,
    calls: () => calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("manual modern extended form transport", () => {
  it("declares support and completes the original tool through the authenticated WebSocket using the extended schema and false/zero", async () => {
    const served = await fixture();
    const manager = new MCPClientManager();
    const app = new Hono();
    const adapter = createNodeWebSocket({ app });
    const localStream = createLocalMrtrStream(adapter.upgradeWebSocket);
    app.get("/api/web/mcp/mrtr/stream", localStream.handler);
    const bridge = http.createServer((_request, response) => response.end());
    adapter.injectWebSocket(bridge);
    await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    const address = bridge.address();
    if (!address || typeof address === "string") throw new Error("Missing bridge address");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/web/mcp/mrtr/stream`, localMrtrProtocols(generateSessionToken()), { origin: "http://localhost:5173" });
    const frames: LocalMrtrMessage[] = [];
    socket.on("message", (data) => frames.push(localMrtrMessageSchema.parse(JSON.parse(data.toString()))));
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    try {
      registerLocalMrtrCollector(manager, "manual");
      const clientCapabilities = resolveEffectiveClientCapabilities({
        localFormSupport: true,
        host: {
          hostStyle: "chatgpt",
          clientCapabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
          mcpProfile: { profileVersion: 1, apps: { pluginExtensions: { enabled: true, capabilities: { forms: true } } } },
        },
      });
      const config = toMCPServerConfig({
        ok: true, role: "owner", accessLevel: "project_member", permissions: { chatOnly: false },
        serverConfig: { transportType: "http", url: served.url, useOAuth: false },
      }, { clientCapabilities, timeoutMs: 5_000 });
      await manager.connectToServer("manual", withLocalMrtrElicitationCapability(config));
      expect(manager.getInitializationInfo("manual")?.protocolVersion).toBe("2026-07-28");
      const result = manager.executeTool("manual", "review", {});
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === "mrtr_input_request")).toBe(true));
      const event = frames.find((frame) => frame.type === "mrtr_input_request");
      if (!event || event.type !== "mrtr_input_request") throw new Error("Missing input round");
      expect(event.requests[0]).toMatchObject({
        pluginForm: true,
        requestedSchema: schema,
      });
      socket.send(JSON.stringify({ type: "respond", requestId: "invalid", opId: event.opId, roundKey: event.roundKey, responses: { review: { action: "accept", content: { name: "invalid", revision: 0, approved: false, date: "2026-11-04" } } } }));
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ type: "response", requestId: "invalid", result: expect.objectContaining({ ok: false, status: 400 }) })));
      expect(served.calls()).toBe(1);
      const answer = {
        name: "QA",
        revision: 0,
        approved: false,
        date: "2026-11-04",
      };
      socket.send(JSON.stringify({ type: "respond", requestId: "valid", opId: event.opId, roundKey: event.roundKey, responses: { review: { action: "accept", content: answer } } }));
      await vi.waitFor(() => expect(frames).toContainEqual({ type: "response", requestId: "valid", result: { ok: true } }));
      await expect(result).resolves.toMatchObject({
        structuredContent: answer,
      });
      expect(served.calls()).toBe(2);
      expect(served.capabilities).toHaveLength(2);
      for (const caps of served.capabilities)
        expect(caps).toMatchObject({
          elicitation: { form: {} },
          extensions: { "openai/elicitation": { form: {} } },
        });
    } finally {
      socket.terminate();
      localStream.kill();
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
      await manager.disconnectAllServers();
      await served.close();
    }
  });

  it("preserves an exact capability set that withholds extension forms", async () => {
    const served = await fixture();
    const manager = new MCPClientManager();
    try {
      registerLocalMrtrCollector(manager, "manual");
      await manager.connectToServer(
        "manual",
        withLocalMrtrElicitationCapability({
          url: served.url,
          timeout: 5_000,
          clientCapabilities: { elicitation: { form: {} } },
        }),
      );
      await expect(
        manager.executeTool("manual", "review", {}),
      ).resolves.toMatchObject({ isError: true });
      expect(served.calls()).toBe(1);
      expect(served.capabilities[0]).not.toHaveProperty(
        "extensions.openai/elicitation",
      );
    } finally {
      await manager.disconnectAllServers();
      await served.close();
    }
  });
});
