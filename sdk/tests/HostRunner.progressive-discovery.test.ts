import { describe, expect, it } from "vitest";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { extractToolErrors } from "@mcpjam/evaluators/internal/eval-tool-execution";
import { HostRunner } from "../src/HostRunner.js";
import { Host } from "../src/host-config/host.js";
import type { Tool } from "../src/mcp-client-manager/types.js";

/**
 * `HostRunner` follows the host's Progressive tools setting the way hosted
 * runs do: On, and Auto at 30 tools, start the model on the search/load
 * meta-tools. Unset is Auto only where the caller
 * says a saved client or template is behind it; a host built in code that
 * leaves it unset, Off, and a runner without a host send every tool. Before,
 * the runner sent every tool whatever the setting.
 */

type Call = { call: string; input: Record<string, unknown>; id?: string };
type Step = Call | { calls: Call[] } | { text: string };

type SeenCall = { tools: string[]; toolChoice: unknown };

function scriptedModel(steps: Step[]) {
  const seen: SeenCall[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      seen.push({
        tools: (options.tools ?? []).map((tool) => tool.name).sort(),
        toolChoice: options.toolChoice,
      });
      const step = steps[seen.length - 1] ?? { text: "done" };
      const usage = {
        inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 2, text: 2, reasoning: 0 },
      };
      if ("text" in step) {
        return {
          content: [{ type: "text" as const, text: step.text }],
          finishReason: { unified: "stop" as const, raw: "end_turn" },
          usage,
          warnings: [],
        };
      }
      return {
        content: ("calls" in step ? step.calls : [step]).map((call, index) => ({
          type: "tool-call" as const,
          toolCallId: call.id ?? (index === 0 ? `call-${seen.length}` : `call-${seen.length}-${index}`),
          toolName: call.call,
          input: JSON.stringify(call.input),
        })),
        finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
        usage,
        warnings: [],
      };
    },
  });
  return { model, seen };
}

function makeTools(count: number, ran: string[] = []): ToolSet {
  const tools: ToolSet = {};
  for (let i = 0; i < count; i++) {
    const name = `ctrl_tool_${i}`;
    tools[name] = dynamicTool({
      description: `Looks up CTRL record kind ${i}.`,
      inputSchema: jsonSchema({
        type: "object",
        properties: { id: { type: "string" } },
      }),
      execute: async () => {
        ran.push(name);
        return { content: [{ type: "text", text: `record from ${name}` }] };
      },
    });
  }
  return tools;
}

function runner(
  progressiveToolDiscovery: boolean | undefined,
  tools: ToolSet | Tool[],
  model: MockLanguageModelV3,
  progressiveToolDiscoveryWhenUnset?: "auto",
  runUnloadedToolCalls?: boolean,
) {
  const host = new Host({
    style: "claude",
    runUnloadedToolCalls,
    model: "anthropic/claude-haiku-4.5",
    ...(progressiveToolDiscovery === undefined
      ? {}
      : { progressiveToolDiscovery }),
  });
  return new HostRunner({
    host,
    tools,
    apiKey: "test-key",
    createLanguageModel: () => model,
    ...(progressiveToolDiscoveryWhenUnset
      ? { progressiveToolDiscoveryWhenUnset }
      : {}),
  });
}

const SEARCH_LOAD_CALL: Step[] = [
  { call: "search_mcp_tools", input: { query: "record kind 7" } },
  { call: "load_mcp_tools", input: { names: ["ctrl_tool_7"] } },
  { call: "ctrl_tool_7", input: { id: "x" } },
  { text: "Record found." },
];

const META = ["load_mcp_tools", "search_mcp_tools"];

describe("HostRunner progressive tool discovery", () => {
  it("On: searches first, loads one tool, then calls it", async () => {
    const ran: string[] = [];
    const { model, seen } = scriptedModel(SEARCH_LOAD_CALL);
    const result = await runner(true, makeTools(30, ran), model).run(
      "Look up record x"
    );

    expect(result.hasError()).toBe(false);
    expect(seen.map((call) => call.tools)).toEqual([
      META,
      META,
      ["ctrl_tool_7", ...META],
      ["ctrl_tool_7", ...META],
    ]);
    expect(seen[0].toolChoice).toEqual({ type: "auto" });
    expect(ran).toEqual(["ctrl_tool_7"]);
    expect(result.toolsCalled()).toEqual([
      "search_mcp_tools",
      "load_mcp_tools",
      "ctrl_tool_7",
    ]);
    const recorded = result.recordedContext?.toolDefinitions.map(
      (tool) => tool.name
    );
    expect(recorded).toHaveLength(32);
    expect(recorded).toEqual(expect.arrayContaining(META));
  });

  it("unset: a host built in code sends every tool", async () => {
    const { model, seen } = scriptedModel([{ text: "ok" }]);
    await runner(undefined, makeTools(30), model).run("hi");
    expect(seen[0].tools).toHaveLength(30);
  });

  it("unset read as Auto (saved clients, templates): on at 30 tools, kept by clones", async () => {
    const large = scriptedModel([{ text: "ok" }]);
    await runner(undefined, makeTools(30), large.model, "auto")
      .withOptions({})
      .run("hi");
    expect(large.seen[0].tools).toEqual(META);

    const small = scriptedModel([{ text: "ok" }]);
    await runner(undefined, makeTools(5), small.model, "auto").run("hi");
    expect(small.seen[0].tools).toHaveLength(5);
    expect(small.seen[0].toolChoice).not.toEqual({
      type: "tool",
      toolName: "search_mcp_tools",
    });
  });

  it("Off, and a runner without a host, send every tool", async () => {
    const off = scriptedModel([{ text: "ok" }]);
    await runner(false, makeTools(30), off.model).run("hi");
    expect(off.seen[0].tools).toHaveLength(30);

    const bare = scriptedModel([{ text: "ok" }]);
    await new HostRunner({
      model: "anthropic/claude-haiku-4.5",
      tools: makeTools(30),
      apiKey: "test-key",
      createLanguageModel: () => bare.model,
    }).run("hi");
    expect(bare.seen[0].tools).toHaveLength(30);
  });

  it("keeps a tool loaded in an earlier turn of the conversation", async () => {
    const tools = makeTools(30);
    const { model, seen } = scriptedModel([
      ...SEARCH_LOAD_CALL,
      { text: "Second answer." },
    ]);
    const agent = runner(true, tools, model);
    const first = await agent.run("Look up record x");
    await agent.run("And again", { context: first });

    const secondTurnFirstCall = seen[4];
    expect(secondTurnFirstCall.tools).toEqual(["ctrl_tool_7", ...META]);
    expect(secondTurnFirstCall.toolChoice).not.toEqual({
      type: "tool",
      toolName: "search_mcp_tools",
    });
  });

  it("leaves a call to a tool that was not loaded out of the results; it never ran", async () => {
    const ran: string[] = [];
    const { model, seen } = scriptedModel([
      { call: "search_mcp_tools", input: { query: "record kind 7" } },
      { call: "ctrl_tool_7", input: { id: "x" } },
      { call: "load_mcp_tools", input: { names: ["ctrl_tool_7"] } },
      { call: "ctrl_tool_7", input: { id: "x" } },
      { text: "Record found." },
    ]);
    const result = await runner(true, makeTools(30, ran), model, undefined, false).run(
      "Look up record x"
    );

    expect(seen).toHaveLength(5);
    expect(ran).toEqual(["ctrl_tool_7"]);
    expect(result.toolsCalled()).toEqual([
      "search_mcp_tools",
      "load_mcp_tools",
      "ctrl_tool_7",
    ]);
  });

  it("rejects well-formed invalid early arguments before dispatch and preserves a valid retry", async () => {
    const ran: string[] = [];
    const { model, seen } = scriptedModel([
      { call: "ctrl_tool_7", input: { id: 7 } },
      { call: "ctrl_tool_7", input: { id: "x" } },
      { text: "Recovered." },
    ]);
    const result = await runner(true, makeTools(30, ran), model).run("Find record x");
    expect(seen.every(step => !step.tools.includes("ctrl_tool_7"))).toBe(true);
    expect(ran).toEqual(["ctrl_tool_7"]);
    expect(result.toolsCalled()).toEqual(["ctrl_tool_7"]);
    expect(JSON.stringify(result.getMessages())).toContain('"rejectedToolCall":true');
  });

  it.each(["load-first", "call-first"])("preserves both calls in a parallel %s batch", async order => {
    const ran: string[] = [];
    const load = { call: "load_mcp_tools", input: { names: ["ctrl_tool_7"] } };
    const invoke = { call: "ctrl_tool_7", input: { id: "value" } };
    const { model, seen } = scriptedModel([{ calls: order === "load-first" ? [load, invoke] : [invoke, load] }, { text: "done" }]);
    const result = await runner(true, makeTools(30, ran), model).run("Look up a record");
    expect(seen[0].tools).toEqual(META);
    expect(seen[1].tools).toContain("ctrl_tool_7");
    expect(ran).toEqual(["ctrl_tool_7"]);
    expect(result.toolsCalled().sort()).toEqual(["ctrl_tool_7", "load_mcp_tools"]);
  });

  it("keeps the loaded tool's original validation behavior", async () => {
    const ran: string[] = [];
    const { model } = scriptedModel([
      {call: "load_mcp_tools", input: {names: ["ctrl_tool_7"]}},
      {call: "ctrl_tool_7", input: {id: 7}},
      {text: "done"},
    ]);
    await runner(true, makeTools(30, ran), model).run("Load and call a record tool");
    expect(ran).toEqual(["ctrl_tool_7"]);
  });

  it("restores a deferred provider alias even when a safe tool owns the unsuffixed name", async () => {
    const ran: string[] = [];
    const handlers = makeTools(2, ran);
    const {model, seen} = scriptedModel([{call:"cart_add_2",input:{}},{text:"done"}]);
    const result = await runner(true, {"cart.add":handlers.ctrl_tool_0,cart_add:handlers.ctrl_tool_1},model).run("Add to cart");
    expect(seen[0].tools).toEqual(META);
    expect(ran).toEqual(["ctrl_tool_0"]);
    expect(result.toolsCalled()).toEqual(["cart.add"]);
  });
  it("counts MCP receipts and attributes a later server error by call ID", async () => {
    const received: unknown[] = [];
    const server = new Server({ name: "receiver", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(CallToolRequestSchema, async ({params}) => {
      received.push(params.arguments);
      const failed = params.arguments?.message === "fail";
      return { isError: failed, content: [{ type: "text", text: failed ? "receiver failed" : "ok" }] };
    });
    const client = new Client({ name: "host", version: "1" });
    const [hostTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    try {
      await client.connect(hostTransport);
      const schema = jsonSchema<{message: string}>({type: "object", required: ["message"], properties: {message: {type: "string"}}});
      const tools = {echo: dynamicTool({inputSchema: schema,
        execute: async input => client.callTool({name: "echo", arguments: input as {message: string}})})};
      const {model, seen} = scriptedModel([
        {call: "echo", input: {}}, {call: "echo", input: {message: "ok"}},
        {call: "echo", input: {message: "fail"}}, {text: "done"}
      ]);
      const result = await runner(true, tools, model).run("echo");
      expect(received).toEqual([{message: "ok"}, {message: "fail"}]);
      expect(seen.every(step => !step.tools.includes("echo"))).toBe(true);
      expect(result.toolsCalled()).toEqual(["echo", "echo"]);
      expect(extractToolErrors(result.getMessages())).toEqual([
        expect.objectContaining({toolCallId: "call-3", toolName: "echo"}),
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("runs discovery over Tool[] input, as from manager.getTools()", async () => {
    const ran: string[] = [];
    const tools = Array.from({ length: 30 }, (_, i) => ({
      name: `ctrl_tool_${i}`,
      description: `Looks up CTRL record kind ${i}.`,
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      execute: async () => {
        ran.push(`ctrl_tool_${i}`);
        return { content: [{ type: "text", text: "record" }] };
      },
    })) as Tool[];
    const { model, seen } = scriptedModel(SEARCH_LOAD_CALL);
    const result = await runner(true, tools, model).run("Look up record x");

    expect(result.hasError()).toBe(false);
    expect(seen[0].tools).toEqual(META);
    expect(ran).toEqual(["ctrl_tool_7"]);
  });

  it("stopAfterToolCall stops on the loaded tool without running it", async () => {
    const ran: string[] = [];
    const { model, seen } = scriptedModel(SEARCH_LOAD_CALL);
    const result = await runner(true, makeTools(30, ran), model).run(
      "Look up record x",
      { stopAfterToolCall: "ctrl_tool_7" }
    );

    expect(seen).toHaveLength(3);
    expect(ran).toEqual([]);
    expect(result.toolsCalled()).toContain("ctrl_tool_7");
  });

  it("keeps a failed step's search and load calls in the partial result", async () => {
    const tools = makeTools(30);
    // Its result can't be turned into model output, so its step fails before
    // it finishes.
    tools.ctrl_tool_7 = dynamicTool({
      description: "Looks up CTRL record kind 7.",
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () => ({ content: [] }),
      toModelOutput: () => {
        throw new Error("unreadable result");
      },
    });
    let id = 0;
    const call = (toolName: string, input: unknown) => ({
      type: "tool-call" as const,
      toolCallId: `call-${++id}`,
      toolName,
      input: JSON.stringify(input),
    });
    const steps = [
      [call("search_mcp_tools", { query: "kind 7" })],
      [call("load_mcp_tools", { names: ["ctrl_tool_7"] })],
      [
        call("load_mcp_tools", { names: ["ctrl_tool_8"] }),
        call("ctrl_tool_7", {}),
      ],
    ];
    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: steps[step++] ?? [],
        finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 2, reasoning: 0 },
        },
        warnings: [],
      }),
    });
    const result = await runner(true, tools, model).run("Look up record x");

    expect(result.hasError()).toBe(true);
    expect(result.toolsCalled()).toEqual([
      "search_mcp_tools",
      "load_mcp_tools",
      "load_mcp_tools",
      "ctrl_tool_7",
    ]);
  });

  it("returns an error result when a server tool uses a meta-tool's name", async () => {
    const tools = {
      ...makeTools(2),
      search_mcp_tools: makeTools(1).ctrl_tool_0,
    };
    const { model, seen } = scriptedModel([{ text: "unreachable" }]);
    const result = await runner(true, tools, model).run("hi");
    expect(result.hasError()).toBe(true);
    expect(result.getError()).toMatch(
      /collides with the progressive-discovery/
    );
    expect(seen).toHaveLength(0);
  });
});

it("gives a dispatched retry and the next prompt their own IDs", async () => {
  const tools = makeTools(1);
  tools.ctrl_tool_0.execute = async () => {
    throw new Error("fixture server failed");
  };
  const { model } = scriptedModel([
    { call: "invented", input: {}, id: "call_0" },
    { call: "ctrl_tool_0", input: {}, id: "call_0" },
    { text: "Finished" },
    { call: "ctrl_tool_0", input: {}, id: "call_0" },
    { text: "Finished again" },
  ]);
  const host = runner(false, tools, model);
  const first = await host.run("First prompt");
  const next = await host.run("Second prompt", { context: [first] });
  const calls = [...first.getMessages(), ...next.getMessages()].flatMap((msg) =>
    msg.role === "assistant" && Array.isArray(msg.content)
      ? msg.content.filter((part) => part.type === "tool-call")
      : []
  );
  expect(new Set(calls.map((part) => part.toolCallId)).size).toBe(3);
  expect(calls.map((part) => part.providerOptions?.mcpjam?.rejectedToolCall))
    .toEqual([true, undefined, undefined]);
  expect(first.toolsCalled()).toEqual(["ctrl_tool_0"]);
  expect(next.toolsCalled()).toEqual(["ctrl_tool_0"]);
});

it("keeps the hidden catalog out of a typo refusal sent back to the model", async () => {
  const { model, seen } = scriptedModel([
    { call: "typo", input: {} },
    { text: "Finished" },
  ]);
  const result = await runner(true, makeTools(30), model).run("Test a typo");
  expect(seen[0]?.tools).toEqual(META);
  const history = JSON.stringify(result.getMessages());
  expect(history).toContain("The tool is unavailable in this step.");
  expect(history).not.toContain("ctrl_tool_");
});
