import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { EvalSuite } from "../src/EvalSuite.js";
import { EvalTest } from "../src/EvalTest.js";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import { PlatformApiClient } from "../src/platform/client.js";
import type { PromptResult } from "../src/PromptResult.js";
import {
  serveCountingFixtureOnPort,
  type ServedCountingFixture,
} from "./support/cache-fixture.js";

/**
 * `runWithClient` end to end: a saved client (the platform lookup is mocked)
 * runs against a real MCP server with 30 tools over HTTP. Only the model is
 * scripted, and it acts on what it is actually offered: it searches when it
 * can only search, loads the first match the real search returned, calls the
 * tool once it is offered, then answers.
 */

const scripted = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("../src/model-factory", async () => {
  const actual = await vi.importActual<typeof import("../src/model-factory")>(
    "../src/model-factory"
  );
  return { ...actual, createModelFromString: () => scripted.model };
});

const TOOL_COUNT = 30;
const TARGET = "ctrl_tool_7";

function buildCtrlServer(): McpServer {
  const server = new McpServer(
    { name: "ctrl-fixture", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  for (let i = 0; i < TOOL_COUNT; i++) {
    server.registerTool(
      `ctrl_tool_${i}`,
      {
        description: `Looks up a CTRL record of kind ${i}.`,
        inputSchema: { id: z.string() },
      },
      async ({ id }) => ({
        content: [{ type: "text" as const, text: `kind ${i} record ${id}` }],
      })
    );
  }
  return server;
}

type PromptPart = {
  type: string;
  toolName?: string;
  output?: { type?: string; value?: unknown };
};
type PromptMessage = { role: string; content: string | PromptPart[] };

function toolResults(prompt: PromptMessage[], toolName: string) {
  return prompt
    .filter((message) => message.role === "tool")
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : []
    )
    .filter(
      (part) => part.type === "tool-result" && part.toolName === toolName
    );
}

function adaptiveModel() {
  const offered: string[][] = [];
  const forced: unknown[] = [];
  let calls = 0;
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 2, text: 2, reasoning: 0 },
  };
  const callTool = (toolName: string, input: unknown) => ({
    content: [
      {
        type: "tool-call" as const,
        toolCallId: `call-${++calls}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
    usage,
    warnings: [],
  });
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const names = (options.tools ?? []).map((tool) => tool.name);
      offered.push(names);
      forced.push(options.toolChoice);
      const prompt = options.prompt as unknown as PromptMessage[];
      if (toolResults(prompt, TARGET).length > 0) {
        return {
          content: [{ type: "text" as const, text: "Record found." }],
          finishReason: { unified: "stop" as const, raw: "end_turn" },
          usage,
          warnings: [],
        };
      }
      if (names.includes(TARGET)) return callTool(TARGET, { id: "42" });
      const searches = toolResults(prompt, "search_mcp_tools");
      if (searches.length === 0) {
        return callTool("search_mcp_tools", { query: "record kind 7" });
      }
      const found = searches.at(-1)?.output?.value as {
        matches: Array<{ name: string }>;
      };
      return callTool("load_mcp_tools", { names: [found.matches[0].name] });
    },
  });
  return { model, offered, forced };
}

const savedClient = (progressiveToolDiscovery: boolean | undefined) => ({
  id: "client1",
  name: "CTRL client",
  configId: "config1",
  versionId: "version1",
  versionNumber: 1,
  ownerScope: null,
  config: {
    hostStyle: "claude",
    modelId: "anthropic/claude-haiku-4.5",
    systemPrompt: "",
    temperature: 0.4,
    requireToolApproval: false,
    respectToolVisibility: true,
    serverIds: ["cloud-server"],
    clientCapabilities: {},
    hostContext: {},
    connectionDefaults: {},
    ...(progressiveToolDiscovery === undefined
      ? {}
      : { progressiveToolDiscovery }),
  },
});

describe("runWithClient with progressive tool discovery (real MCP server)", () => {
  let served: ServedCountingFixture;
  let manager: MCPClientManager;

  beforeEach(async () => {
    served = await serveCountingFixtureOnPort(
      createMcpHandler(buildCtrlServer)
    );
    manager = new MCPClientManager();
    await manager.connectToServer("ctrl", { url: served.url, timeout: 10_000 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await manager.disconnectAllServers().catch(() => {});
    await served.close();
  });

  async function runSuite(progressiveToolDiscovery: boolean | undefined) {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue(
      savedClient(progressiveToolDiscovery)
    );
    const { model, offered, forced } = adaptiveModel();
    scripted.model = model;
    const results: PromptResult[] = [];
    const suite = new EvalSuite({
      defaults: { iterations: 1 },
      mcpjam: { enabled: false },
    });
    suite.add(
      new EvalTest({
        id: "ctrl_lookup",
        name: "looks up a kind 7 record",
        test: async (executor) => {
          const result = await executor.run("Look up CTRL record 42 of kind 7");
          results.push(result);
          return result.hasToolCall(TARGET);
        },
      })
    );
    const run = await suite.runWithClient({
      client: "CTRL client",
      projectId: "project1",
      apiKey: "sk_test",
      manager,
    });
    return { run, result: results[0], offered, forced };
  }

  it.each([
    ["On", true],
    ["Auto (unset)", undefined],
  ] as const)(
    "%s: searches, loads the match and calls it on the server",
    async (_label, setting) => {
      const { run, result, offered, forced } = await runSuite(setting);

      expect(run.aggregate.successes).toBe(1);
      expect(served.count("tools/call")).toBe(1);
      expect(result.toolsCalled()).toEqual([
        "search_mcp_tools",
        "load_mcp_tools",
        TARGET,
      ]);
      expect(offered.map((names) => names.length)).toEqual([2, 2, 3, 3]);
      expect(forced[0]).toEqual({ type: "tool", toolName: "search_mcp_tools" });
    }
  );

  it("Off: the model is offered all 30 tools and calls the right one", async () => {
    const { run, result, offered } = await runSuite(false);

    expect(run.aggregate.successes).toBe(1);
    expect(served.count("tools/call")).toBe(1);
    expect(result.toolsCalled()).toEqual([TARGET]);
    expect(offered.map((names) => names.length)).toEqual([
      TOOL_COUNT,
      TOOL_COUNT,
    ]);
  });
});
