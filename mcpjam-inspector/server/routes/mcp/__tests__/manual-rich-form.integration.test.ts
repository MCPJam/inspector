import { resolveEffectiveClientCapabilities } from "../../../../client/src/lib/effective-client";
import { toMCPServerConfig } from "../../../utils/local-server-resolver";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  requestFormInput,
  type OpenAIForm,
} from "@openai/mcp-extensions/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MCPClientManager } from "@mcpjam/sdk";
import mrtr, {
  registerLocalMrtrCollector,
  submitMrtrResponses,
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
  it("declares support and completes the original tool through SSE using the extended schema and false/zero", async () => {
    const served = await fixture();
    const manager = new MCPClientManager();
    const response = await mrtr.request("/stream");
    const reader = response.body!.getReader();
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
      await reader.read();
      const result = manager.executeTool("manual", "review", {});
      const frame = await Promise.race([
        reader.read(),
        result.then((value) => {
          throw new Error(`Completed before input: ${JSON.stringify(value)}`);
        }),
      ]);
      const message = new TextDecoder().decode(frame.value);
      const event = JSON.parse(message.replace(/^data: /, "").trim());
      expect(event.requests[0]).toMatchObject({
        pluginForm: true,
        requestedSchema: schema,
      });
      const invalid = submitMrtrResponses(event.opId, {
        review: {
          action: "accept",
          content: {
            name: "invalid",
            revision: 0,
            approved: false,
            date: "2026-11-04",
          },
        },
      });
      expect(invalid).toMatchObject({ ok: false, status: 400 });
      expect(served.calls()).toBe(1);
      const answer = {
        name: "QA",
        revision: 0,
        approved: false,
        date: "2026-11-04",
      };
      expect(
        submitMrtrResponses(event.opId, {
          review: { action: "accept", content: answer },
        }),
      ).toEqual({ ok: true });
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
      await reader.cancel();
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
