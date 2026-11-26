import { consumeDirectChatTurnFullStream } from "../direct-chat-turn-full-stream";
import { describe, expect, it, vi } from "vitest";
import { tool, jsonSchema, type ModelMessage } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  buildToolCatalog,
  createDiscoveryState,
  createProgressiveMetaTools,
  decideProgressivePlan,
  MCPClientManager,
} from "@mcpjam/sdk";
import {
  extractToolErrors,
  rejectedToolCallIds,
} from "@mcpjam/evaluators/internal/eval-tool-execution";
import {
  runDirectChatTurn,
  consumeDirectChatTurnHeadless,
} from "../direct-chat-turn";
import { runChatEngineLoop } from "../mcpjam-stream-handler";
import { mintToolApprovalId, toolApprovalBindingFor } from "../tool-approval-token";

const calls = [
  { name: "echo", id: "invalid", input: {} },
  { name: "computer", id: "excluded", input: {} },
  { name: "echo", id: "retry", input: { message: "hello" } },
  { name: "echo", id: "invalid", input: { message: "fail" } },
];
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

describe.each(["direct", "direct-stream", "hosted"] as const)(
  "%s Inspector early calls",
  (rail) => {
    it("checks the step gate and schema before dispatch and scores only the actual MCP error", async () => {
      const echoName = rail === "hosted" ? "cart.add" : "echo";
      const receipts: unknown[] = [];
      const handler = createMcpHandler(() => {
        const mcp = new McpServer({ name: "receipt-counter", version: "1" });
        mcp.registerTool("echo", { inputSchema: { message: z.string() } }, async (input) => {
          receipts.push(input);
          const failed = input.message === "fail";
          return {
            isError: failed,
            content: [{ type: "text", text: failed ? "server refused" : "hello" }],
          };
        });
        return mcp;
      });
      const server = createServer(toNodeHandler(handler)).listen(0, "127.0.0.1");
      const manager = new MCPClientManager();
      try {
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw Error("Missing MCP fixture port");
        await manager.connectToServer("echo", { url: `http://127.0.0.1:${address.port}/mcp` });
        const echo = tool({
          inputSchema: jsonSchema<{ message: string }>({
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          }),
          execute: (input) =>
            manager.executeTool("echo", "echo", input),
        });
        const computer = tool({
          inputSchema: jsonSchema({
            type: "object",
            description: "private computer schema",
          }),
          execute: vi.fn(),
        });
        const catalog = buildToolCatalog({ [echoName]: echo });
        const progressivePlan = decideProgressivePlan({
          catalog,
          options: { enabled: true },
        });
        const discoveryState = createDiscoveryState();
        const common = {
          systemPrompt: "Use the available tools",
          modelId: "openai/gpt-5-mini",
          progressivePlan,
          discoveryState,
          tools: {
            [echoName]: echo,
            ...(rail === "hosted" ? { cart_add: { ...echo, execute: vi.fn() } } : {}),
            computer,
            ...createProgressiveMetaTools({
              getCatalog: () => catalog,
              state: discoveryState,
              policy: progressivePlan.policy,
            }),
          },
          prepareAdvertisedTools: ({
            defaultToolNames,
          }: {
            defaultToolNames: string[];
          }) => defaultToolNames.filter((n) => n !== "computer"),
          maxSteps: 8,
        };
        const prompt: ModelMessage[] = [{ role: "user", content: "echo" }];
        const shown: string[][] = [];
        let step = 0;
        let history: ModelMessage[];
        if (rail !== "hosted") {
          const model = new MockLanguageModelV4({
            doStream: async (opts) => {
              shown.push((opts.tools ?? []).map((t) => t.name));
              const call = calls[step++];
              return {
                stream: convertArrayToReadableStream(
                  call
                    ? [
                        {
                          type: "tool-call",
                          toolCallId: call.id,
                          toolName: call.name,
                          input: JSON.stringify(call.input),
                        },
                        {
                          type: "finish",
                          finishReason: {
                            unified: "tool-calls",
                            raw: undefined,
                          },
                          usage,
                        },
                      ]
                    : [
                        { type: "text-start", id: "end" },
                        { type: "text-delta", id: "end", delta: "done" },
                        { type: "text-end", id: "end" },
                        {
                          type: "finish",
                          finishReason: { unified: "stop", raw: undefined },
                          usage,
                        },
                      ],
                ),
              };
            },
          });
          const handle = runDirectChatTurn({
            ...common,
            llmModel: model,
            messageHistory: prompt,
          });
          history = (
            rail === "direct-stream"
              ? await consumeDirectChatTurnFullStream(handle, () => {})
              : await consumeDirectChatTurnHeadless(handle)
          ).messages;
        } else {
          vi.stubEnv("CONVEX_HTTP_URL", "https://stream.test");
          const fetchMcp = globalThis.fetch;
          vi.stubGlobal("fetch", async (request: RequestInfo | URL, init: RequestInit) => {
            const url = request instanceof Request ? request.url : String(request);
            if (new URL(url).origin !== "https://stream.test") return fetchMcp(request, init);
            const body = JSON.parse(String(init.body));
            shown.push(body.tools.map((t: { name: string }) => t.name));
            expect(body.hiddenTools).toEqual([
              expect.objectContaining({ name: "cart_add_2", originalName: "cart.add" }),
            ]);
            const call = calls[step++];
            const events = call
              ? [
                  {
                    type: "tool-input-available",
                    toolName: call.name === "echo" ? "cart_add_2" : call.name,
                    toolCallId: call.id,
                    input: call.input,
                  },
                  { type: "finish", finishReason: "tool-calls" },
                ]
              : [
                  { type: "text-start", id: "end" },
                  { type: "text-delta", id: "end", delta: "done" },
                  { type: "text-end", id: "end" },
                  { type: "finish", finishReason: "stop" },
                ];
            return new Response(
              events
                .map((e) => "data: " + JSON.stringify(e) + "\n\n")
                .join("") + "data: [DONE]\n\n",
            );
          });
          history = (
            await runChatEngineLoop(
              {
                ...common,
                messages: prompt,
                mcpClientManager: new MCPClientManager(),
              },
              "none",
            )
          ).messageHistory;
        }
        expect(receipts).toEqual([{ message: "hello" }, { message: "fail" }]);
        expect(shown.length).toBeGreaterThanOrEqual(4);
        for (const names of shown)
          expect(names.sort()).toEqual(rail === "hosted"
            ? ["cart_add", "load_mcp_tools", "search_mcp_tools"]
            : ["load_mcp_tools", "search_mcp_tools"]);
        expect(computer.execute).not.toHaveBeenCalled();
        expect(rejectedToolCallIds(history).size).toBe(2);
        const errors = extractToolErrors(history);
        expect(errors.map((e) => e.toolName)).toEqual([echoName]);
        expect(JSON.stringify(history)).not.toContain(
          "private computer schema",
        );
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        await manager.disconnectAllServers();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  },
);

it.each(["excluded", "invalid", "allowed", "server-error"])(
  "rechecks a resumed approval before direct dispatch (%s)",
  async (mode) => {
    const execute = vi.fn(async () => {
      if (mode === "server-error") throw new Error("fixture MCP error");
      return "ok";
    });
    const tools = {
      echo: tool({
        inputSchema: jsonSchema({
          type: "object",
          required: ["message"],
          properties: { message: { type: "string" } },
        }),
        execute,
        needsApproval: true,
      }),
    };
    const catalog = buildToolCatalog(tools);
    const input = mode === "invalid" ? {} : { message: "hello" };
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "done" },
          { type: "text-end", id: "t" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage,
          },
        ]),
      }),
    });
    const result = await consumeDirectChatTurnHeadless(
      runDirectChatTurn({
        llmModel: model,
        modelId: "test",
        systemPrompt: "test",
        tools,
        progressivePlan: decideProgressivePlan({
          catalog,
          options: { enabled: true },
        }),
        discoveryState: createDiscoveryState(),
        prepareAdvertisedTools: ({ defaultToolNames }) =>
          mode === "excluded" ? [] : defaultToolNames,
        messageHistory: [
          { role: "user", content: "echo" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolName: "echo",
                toolCallId: "pending",
                input,
              },
              {
                type: "tool-approval-request",
                toolCallId: "pending",
                approvalId: "allow",
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-approval-response",
                approvalId: "allow",
                approved: true,
              },
            ],
          },
        ],
      }),
    );
    expect(execute).toHaveBeenCalledTimes(mode === "allowed" || mode === "server-error" ? 1 : 0);
    expect(rejectedToolCallIds(result.messages).has("pending")).toBe(
      mode === "excluded" || mode === "invalid",
    );
    expect(extractToolErrors(result.messages)).toHaveLength(mode === "server-error" ? 1 : 0);
    expect(result.finishReason).toBe("stop");
  },
);

it("settles a hosted mixed approval batch in order and executes only the eligible call", async () => {
  const execute = vi.fn(async (_input: { message: string }) => "echoed");
  const echo = tool({
    inputSchema: jsonSchema<{ message: string }>({
      type: "object",
      required: ["message"],
      properties: { message: { type: "string" } },
    }),
    execute,
  });
  const catalog = buildToolCatalog({ echo });
  const plan = decideProgressivePlan({ catalog, options: { enabled: true } });
  const state = createDiscoveryState();
  const approvals = [
    { id: "denied", input: { message: "skip" }, approved: false },
    { id: "invalid", input: {}, approved: true },
    { id: "valid", input: { message: "send" }, approved: true },
  ].map((entry) => {
    const approvalId = mintToolApprovalId({
      call: { toolCallId: entry.id, toolName: "echo", input: entry.input },
      binding: toolApprovalBindingFor({}),
    });
    if (!approvalId) throw new Error("Expected an approval signing key in the test");
    return { ...entry, approvalId };
  });
  const messages: ModelMessage[] = [
    ...approvals.map(({ id, input, approvalId }): ModelMessage => ({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: id, toolName: "echo", input },
        { type: "tool-approval-request", toolCallId: id, approvalId },
      ],
    })),
    {
      role: "tool",
      content: approvals.map(({ approvalId, approved }) => ({
        type: "tool-approval-response",
        approvalId,
        approved,
      })),
    },
    { role: "user", content: "Continue the conversation" },
  ];
  const onToolResult = vi.fn();
  const requests: ModelMessage[][] = [];
  vi.stubEnv("CONVEX_HTTP_URL", "https://stream.test");
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(JSON.parse(String(init.body)).messages));
    const events = [
      { type: "text-start", id: "end" },
      { type: "text-delta", id: "end", delta: "done" },
      { type: "text-end", id: "end" },
      { type: "finish", finishReason: "stop" },
    ];
    return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("") + "data: [DONE]\n\n");
  });
  try {
    const result = await runChatEngineLoop({
      messages,
      modelId: "openai/gpt-5-mini",
      systemPrompt: "Fixture",
      mcpClientManager: new MCPClientManager(),
      progressivePlan: plan,
      discoveryState: state,
      tools: { echo, ...createProgressiveMetaTools({ getCatalog: () => catalog, state, policy: plan.policy }) },
      onToolResult,
    }, "none");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ message: "send" });
    const events = onToolResult.mock.calls.map(([event]) => event);
    expect(events.filter((event) => event.toolCallId === "invalid"))
      .toEqual([expect.objectContaining({ isError: true })]);
    expect(rejectedToolCallIds(result.messageHistory).has("invalid")).toBe(true);
    const first = requests[0];
    const index = first.findIndex((message) => message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "tool-call" && part.toolCallId === "invalid"));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(first[index + 1]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "invalid" }],
    });
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
