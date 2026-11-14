/**
 * Wire-level check of OpenAI's extended forms over MRTR (MCP 2026-07-28),
 * against OpenAI's own `requestFormInput` helper on a real loopback server.
 *
 * The core `requestedSchema` such a server sends is empty; the real schema is
 * in `_meta["openai/elicitation"]`. The owned path must advertise both form
 * claims, validate the answer against the extension schema, and retry with the
 * spec's MRTR invariants. Only the human (the collector's answer) is simulated.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { requestFormInput } from "@openai/mcp-extensions/server";
import {
  MCPClientManager,
  resumeInputRequiredOperation,
  type MrtrOperationState,
} from "@mcpjam/sdk";
import {
  compilePluginForm,
  ownedPluginFormProfile,
  validatePluginFormContent,
} from "../../../../shared/plugin-extensions/form-plan.js";
import {
  ownedMrtrFormCapabilities,
  ownedPluginFormSchema,
} from "../owned-mrtr";

const referenceSchema = {
  type: "object" as const,
  required: ["refs"],
  properties: {
    refs: {
      type: "array" as const,
      title: "References",
      items: { type: "string" as const, format: "uri" as const },
      "x-openai-input": {
        type: "resource" as const,
        options: [
          { uri: "fixture://parts/bolt", name: "Bolt" },
          { uri: "fixture://parts/nut", name: "Nut" },
        ],
      },
    },
  },
};

type Received = {
  id: unknown;
  params: Record<string, unknown>;
};

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

async function serve() {
  const calls: Received[] = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: "extended-form-fixture", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.registerTool(
      "cad.pick",
      { description: "Asks one extended form.", inputSchema: z.object({}) },
      async (_args, context) => {
        const result = requestFormInput(context, {
          mode: "form",
          message: "Choose references",
          requestedSchema: referenceSchema,
          key: "form",
          requestState: "opaque-state-1",
        });
        if ("resultType" in result) return result;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      },
    );
    return server;
  });
  const node = toNodeHandler(handler);
  const httpServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : undefined;
    if (body?.method === "tools/call")
      calls.push({ id: body.id, params: body.params });
    await node(req, res, body);
  });
  await new Promise<void>((done) => httpServer.listen(0, "127.0.0.1", done));
  closers.push(async () => {
    httpServer.closeAllConnections();
    await new Promise<void>((done) => httpServer.close(() => done()));
  });
  return {
    calls,
    url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`,
  };
}

class Suspended extends Error {
  constructor(readonly state: MrtrOperationState) {
    super("suspended");
  }
}

async function connect(url: string, capabilities: Record<string, unknown>) {
  const manager = new MCPClientManager({}, { lazyConnect: true });
  closers.push(() => manager.disconnectAllServers());
  // The owned collector suspends a round for a person to answer; resume is a
  // separate leg, exactly as the durable continuation drives it.
  manager.setMrtrInputCollector(
    "server",
    async ({ state }) => {
      throw new Suspended(state);
    },
    { extensionClaims: ["openai/elicitation"] },
  );
  await manager.connectToServer("server", {
    url,
    capabilities,
    clientCapabilities: capabilities,
    supportedProtocolVersions: ["2026-07-28"],
    timeout: 10_000,
  });
  return manager;
}

const profile = ownedPluginFormProfile(false, "server");
const ownedValidation = {
  supportedElicitationModes: ["form" as const],
  selectFormSchema: (params: Record<string, unknown> | undefined) =>
    ownedPluginFormSchema(params, "server"),
  validateContent: (schema: unknown, content: unknown) =>
    validatePluginFormContent(compilePluginForm(schema, profile), content),
};

async function suspendFirstRound(manager: MCPClientManager) {
  const error = await manager.executeTool("server", "cad.pick", {}).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Suspended);
  return (error as Suspended).state;
}

describe("OpenAI extended forms over MRTR", () => {
  it("shows the _meta schema, validates a URI-array answer against it, and retries with the spec's invariants", async () => {
    const served = await serve();
    const manager = await connect(served.url, ownedMrtrFormCapabilities({}));
    const state = await suspendFirstRound(manager);

    // The request the person sees: an empty core schema, the real one in _meta.
    const request = state.pendingInputRequests.form as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(request.method).toBe("elicitation/create");
    expect(request.params.requestedSchema).toEqual({
      type: "object",
      properties: {},
    });
    expect(ownedPluginFormSchema(request.params, "server")).toEqual(
      referenceSchema,
    );
    expect(state.requestState).toBe("opaque-state-1");

    const leg = await resumeInputRequiredOperation(
      manager.getManagedClient("server")!,
      state,
      {
        form: {
          action: "accept",
          content: { refs: ["fixture://parts/bolt", "fixture://parts/nut"] },
        },
      },
      ownedValidation,
    );
    expect(leg.status).toBe("complete");
    const result = (leg as { result: { content: { text: string }[] } }).result;
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      action: "accept",
      content: { refs: ["fixture://parts/bolt", "fixture://parts/nut"] },
    });

    expect(served.calls).toHaveLength(2);
    const [first, retry] = served.calls;
    // A fresh JSON-RPC request, not a replay of the first id.
    expect(retry!.id).not.toEqual(first!.id);
    // The opaque state is echoed byte for byte.
    expect(retry!.params.requestState).toBe("opaque-state-1");
    // Both form claims travel on the retry itself.
    const envelope = retry!.params._meta as Record<string, unknown>;
    expect(
      envelope["io.modelcontextprotocol/clientCapabilities"],
    ).toMatchObject({
      elicitation: { form: {} },
      extensions: { "openai/elicitation": { form: {} } },
    });
  });

  it("refuses an answer the extension schema rejects before any retry leaves", async () => {
    const served = await serve();
    const manager = await connect(served.url, ownedMrtrFormCapabilities({}));
    const state = await suspendFirstRound(manager);
    await expect(
      resumeInputRequiredOperation(
        manager.getManagedClient("server")!,
        state,
        { form: { action: "accept", content: { refs: "not-an-array" } } },
        ownedValidation,
      ),
    ).rejects.toThrow(/failed schema validation/);
    expect(served.calls).toHaveLength(1);
  });

  it("extension-disabled control: without the extension claim the server refuses the form instead of sending an empty one", async () => {
    const served = await serve();
    // Forms off for this client: only the core claim, as a non-OpenAI host.
    const manager = await connect(served.url, { elicitation: { form: {} } });
    const result = (await manager.executeTool("server", "cad.pick", {})) as {
      isError?: boolean;
      content: { text?: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/openai\/elicitation form support/);
  });

  it("refuses a form whose _meta schema is missing rather than showing the empty core form", () => {
    expect(() =>
      ownedPluginFormSchema(
        {
          mode: "form",
          message: "Broken",
          requestedSchema: { type: "object", properties: {} },
          _meta: { "openai/elicitation": {} },
        },
        "server",
      ),
    ).toThrow("PLUGIN_FORM_SCHEMA_MISSING");
    // A plain MCP form (no extension key) keeps its core schema, even empty.
    expect(
      ownedPluginFormSchema(
        { mode: "form", requestedSchema: { type: "object", properties: {} } },
        "server",
      ),
    ).toEqual({ type: "object", properties: {} });
  });
});
