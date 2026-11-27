/**
 * What a check reads when it asks "what did the server DECLARE?".
 *
 * Both cases here are the AI SDK's `ToolSet` being lossy in a way that is
 * invisible at the call site: the schema arrives wrapped, and the annotations
 * do not arrive at all. A check that reads them straight off `allTools` is not
 * merely less informed — it reports a verdict about a declaration it never
 * saw.
 */

import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { jsonSchema } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { InternalError, Server } from "@modelcontextprotocol/server";
import { MCPClientManager } from "@mcpjam/sdk";
import { buildIterationTranscript, evaluatePredicate } from "@mcpjam/sdk/predicates";
import { consumeDirectChatTurnHeadless, runDirectChatTurn } from "../../../utils/direct-chat-turn.js";
import {
  collectToolAnnotations,
  collectToolDeclarations,
  extractTranscriptEvidence,
  toTranscriptToolInventory,
} from "../transcript-evidence.js";

const SCHEMA = {
  type: "object",
  properties: { limit: { type: "number" } },
  required: ["limit"],
  additionalProperties: false,
} as const;

describe("the input schema is unwrapped from the AI SDK's Schema", () => {
  it("stores the JSON Schema, not the { jsonSchema, validate } wrapper", () => {
    // This is what `convertMCPToolsToVercelTools` stores on the automatic
    // path — the one every live eval takes.
    const inventory = toTranscriptToolInventory({
      list_orders: { inputSchema: jsonSchema(SCHEMA as never) },
    });
    expect(inventory?.[0]?.inputSchema).toMatchObject({ type: "object" });
    expect(inventory?.[0]?.inputSchema).not.toHaveProperty("validate");
  });

  it("lets argumentsMatchToolSchema see the violation", () => {
    // Against the WRAPPER this passes: an object with no constraints matches
    // everything, so a call missing a required argument is reported as
    // meeting the server's declared contract.
    const transcript = buildIterationTranscript({
      toolCalls: [{ toolName: "list_orders", arguments: { limit: "ten" } }],
      toolInventory: toTranscriptToolInventory({
        list_orders: { inputSchema: jsonSchema(SCHEMA as never) },
      }),
    });
    const result = evaluatePredicate(transcript, {
      type: "argumentsMatchToolSchema",
    });
    expect(result.passed).toBe(false);
  });

  it("passes a bare schema through untouched", () => {
    // Override-mode tools carry the schema itself.
    const inventory = toTranscriptToolInventory({
      list_orders: { inputSchema: SCHEMA },
    });
    expect(inventory?.[0]?.inputSchema).toEqual(SCHEMA);
  });
});

describe("annotations come from the manager, because the ToolSet drops them", () => {
  const manager = (
    cached: Record<string, Record<string, Record<string, unknown>>>,
  ) => ({
    listServers: () => Object.keys(cached),
    hasCachedToolAnnotations: (id: string) => id in cached,
    getAllToolAnnotations: (id: string) => cached[id] ?? {},
  });

  it("carries destructiveHint onto the inventory", () => {
    const annotations = collectToolAnnotations(
      manager({ srv: { delete_all: { destructiveHint: true } } }),
    );
    const transcript = buildIterationTranscript({
      toolCalls: [{ toolName: "delete_all", arguments: {} }],
      toolInventory: toTranscriptToolInventory(
        // No `annotations` on the tool: `dynamicTool` never sets one.
        { delete_all: { description: "Delete everything." } },
        annotations,
      ),
    });
    const result = evaluatePredicate(transcript, {
      type: "noDestructiveToolCalled",
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("destructiveHint");
  });

  it("distinguishes a cold cache from a server that declared none", () => {
    // Nobody asked ⇒ nothing to read ⇒ the check must not answer.
    expect(collectToolAnnotations(manager({}))).toBeUndefined();
    // Asked, and the server declared none ⇒ an answer, and an empty one.
    expect(
      collectToolAnnotations({
        listServers: () => ["srv"],
        hasCachedToolAnnotations: () => true,
        getAllToolAnnotations: () => ({}),
      }),
    ).toEqual({});
  });

  it("keeps an EMPTY selection distinct from no selection at all", () => {
    const both = {
      listServers: () => ["a", "b"],
      hasCachedToolAnnotations: () => true,
      getAllToolAnnotations: (id: string) =>
        id === "a"
          ? { shared: { destructiveHint: false } }
          : { shared: { destructiveHint: true } },
    };
    // No answer from the caller ⇒ every server, as before.
    expect(collectToolAnnotations(both)).toHaveProperty("shared");
    // "This run selected server a" ⇒ only a's declaration for the shared name.
    expect(collectToolAnnotations(both, ["a"])).toEqual({
      shared: { destructiveHint: false },
    });
    // "This run selected NO server" is an answer too, and it is emphatically
    // not "all of them" — reading it that way is how an unselected server's
    // hint reaches a colliding tool name. It reads no cache at all, so the
    // result is `undefined`: nothing was asked, rather than "asked and none".
    expect(collectToolAnnotations(both, [])).toBeUndefined();
  });

  it("never throws a run down over evidence it cannot read", () => {
    // A manager that predates this surface, or a test double.
    expect(collectToolAnnotations(undefined)).toBeUndefined();
    expect(collectToolAnnotations({} as never)).toBeUndefined();
    expect(
      collectToolAnnotations({
        listServers: () => {
          throw new Error("not connected");
        },
        hasCachedToolAnnotations: () => true,
        getAllToolAnnotations: () => ({}),
      }),
    ).toBeUndefined();
  });
});

describe("a protocol-level tool failure", () => {
  it("is kept separate from a CallToolResult with isError", () => {
    const { toolResults } = extractTranscriptEvidence({
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "get_order",
              output: { type: "error-text", value: "MCP error -32602" },
            },
          ],
        },
      ],
    });
    expect(toolResults[0]).toMatchObject({ callFailure: "protocol" });
    expect(toolResults[0]).not.toHaveProperty("isError");
  });

  it.each([
    [
      'TypeError: Tool "get_order" structured content does not match its output schema: data/limit must be a number.',
      "output_schema_mismatch",
    ],
    [
      'Tool "get_order" has an output schema but did not return structured content.',
      "missing_structured_content",
    ],
  ])("classifies MRTR rejections on account variants: %s", (value, callFailure) => {
    const evidence = extractTranscriptEvidence(
      {
        messages: [{
          role: "tool",
          content: [{
            type: "tool-result",
            toolName: "get_order__work",
            output: { type: "error-text", value },
          }],
        }],
      },
      new Map([["get_order__work", { serverToolName: "get_order", selectsAccount: false }]]),
    );
    expect(evidence.toolResults[0]).toMatchObject({
      toolName: "get_order__work",
      declaredToolName: "get_order",
      callFailure,
    });
    const transcript = buildIterationTranscript({
      ...evidence,
      toolCalls: [{ toolName: "get_order", arguments: {} }],
      toolDeclarations: [{ name: "get_order", serverKey: "fixture", outputSchema: SCHEMA }],
      declarationsCaptured: "complete",
    });
    expect(evaluatePredicate(transcript, {
      type: "toolResultMatchesSchema",
      schema: "declared",
      toolName: "get_order",
    })).toMatchObject({ passed: false });
  });
});

it("grades output-schema rejections through the MCP client and AI SDK", async () => {
  const names = ["conforming", "wrong_type", "missing", "rpc_error", "domain_error"];
  const mcp = new Server(
    { name: "declared-output-fixture", version: "1" },
    { capabilities: { tools: {} } },
  );
  mcp.setRequestHandler("tools/list", async () => ({
    tools: names.map((name) => ({
      name,
      inputSchema: { type: "object" },
      outputSchema: SCHEMA,
    })),
  }));
  mcp.setRequestHandler("tools/call", async ({ params: { name } }) => {
    if (name === "rpc_error") {
      throw new InternalError("request interrupted");
    }
    return {
      content: [{ type: "text", text: "fixture result" }],
      ...(name === "domain_error" ? { isError: true } : {}),
      ...(name === "conforming" ? { structuredContent: { limit: 5 } } : {}),
      ...(name === "wrong_type" ? { structuredContent: { limit: "five" } } : {}),
    };
  });
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => "declared-output-fixture",
  });
  await mcp.connect(transport);
  const server = createServer((req, res) => transport.handleRequest(req, res));
  const manager = new MCPClientManager();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    await manager.connectToServer("fixture", {
      url: `http://127.0.0.1:${address.port}/mcp`,
      mcpProtocolVersion: "2025-11-25",
    });
    const tools = await manager.getToolsForAiSdk(["fixture"]);
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          ...names.map((name) => ({
            type: "tool-call" as const,
            toolCallId: name,
            toolName: name,
            input: "{}",
          })),
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ]),
      }),
    });
    const { messages } = await consumeDirectChatTurnHeadless(runDirectChatTurn({
      llmModel: model,
      modelId: "openai/gpt-5-mini",
      systemPrompt: "Use the available tools.",
      messageHistory: [{ role: "user", content: "Call the fixture tools." }],
      tools,
      maxSteps: 1,
    }));
    const evidence = extractTranscriptEvidence({ messages });
    expect(evidence.toolResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: "wrong_type", callFailure: "output_schema_mismatch" }),
        expect.objectContaining({ toolName: "missing", callFailure: "missing_structured_content" }),
        expect.objectContaining({ toolName: "rpc_error", callFailure: "protocol" }),
        expect.objectContaining({ toolName: "domain_error", isError: true }),
      ]),
    );
    const transcript = buildIterationTranscript({
      ...evidence,
      ...collectToolDeclarations(manager, ["fixture"]),
      toolCalls: names.map((name) => ({ toolName: name, toolCallId: name, arguments: {} })),
    });
    const predicate = { type: "toolResultMatchesSchema", schema: "declared" } as const;
    expect(evaluatePredicate(transcript, predicate)).toMatchObject({
      passed: false,
      reason: expect.stringContaining("2/3 result(s)"),
    });
    expect(evaluatePredicate(transcript, { ...predicate, toolName: "rpc_error" })).toMatchObject({
      status: "error",
    });
  } finally {
    await manager.disconnectAllServers();
    await mcp.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
