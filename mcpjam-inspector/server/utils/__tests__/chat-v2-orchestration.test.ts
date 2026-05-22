import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../skill-tools.js", () => ({
  getSkillToolsAndPrompt: vi.fn(),
}));

vi.mock("@/shared/types", async () => {
  const actual =
    await vi.importActual<typeof import("@/shared/types")>("@/shared/types");
  return {
    ...actual,
    isGPT5Model: vi.fn().mockReturnValue(false),
  };
});

import { prepareChatV2 } from "../chat-v2-orchestration";
import { getSkillToolsAndPrompt } from "../skill-tools";

function mockManager(tools: Record<string, unknown>) {
  return {
    getToolsForAiSdk: vi.fn().mockResolvedValue(tools),
    getAllToolsMetadata: vi.fn().mockReturnValue({}),
    listServers: vi.fn().mockReturnValue([]),
    hasServer: vi.fn().mockReturnValue(true),
  } as any;
}

beforeEach(() => {
  vi.mocked(getSkillToolsAndPrompt).mockResolvedValue({
    tools: {},
    systemPromptSection: "",
  });
});

describe("prepareChatV2", () => {
  it("does not add MCP tool inventory to the system prompt", async () => {
    const manager = mockManager({
      fetch_tasks: {
        description: "Fetch tasks from the task service",
        _serverId: "server-b",
      },
    });

    const result = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: ["server-b"],
      modelDefinition: { id: "gpt-4.1", provider: "openai" } as any,
      systemPrompt: "Base prompt.",
    });

    expect(result.enhancedSystemPrompt).toBe("Base prompt.");
  });

  it("scrubs unavailable historical tool calls and results from outbound messages", async () => {
    const manager = mockManager({
      current_tool: {
        description: "Currently available tool",
        _serverId: "server-a",
      },
    });

    const result = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: ["server-a"],
      modelDefinition: { id: "gpt-4.1", provider: "openai" } as any,
      systemPrompt: "Base prompt.",
    });

    const scrubbed = result.scrubMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "stale-call",
            toolName: "stale_tool",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "stale-call",
            toolName: "stale_tool",
            output: { type: "json", value: { ok: false } },
          },
        ],
      },
      {
        role: "user",
        content: "Draw a dog.",
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "current-call",
            toolName: "current_tool",
            input: {},
          },
        ],
      },
    ] as any);

    expect(scrubbed).toEqual([
      {
        role: "user",
        content: "Draw a dog.",
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "current-call",
            toolName: "current_tool",
            input: {},
          },
        ],
      },
    ]);
  });

  it("filters selectedServers down to ids the manager has registered", async () => {
    const manager = mockManager({});
    manager.hasServer = vi.fn((id: string) => id === "live-server");

    await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: ["live-server", "stale-server"],
      modelDefinition: { id: "gpt-4.1", provider: "openai" } as any,
      systemPrompt: "Base prompt.",
    });

    expect(manager.getToolsForAiSdk).toHaveBeenCalledWith(
      ["live-server"],
      undefined,
    );
  });

  describe("progressive discovery", () => {
    function manyToolsManager(count: number) {
      const tools: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        tools[`tool_${i}`] = {
          description: `tool ${i}`,
          parameters: { jsonSchema: { type: "object", properties: {} } },
          _serverId: "srv",
          execute: async () => ({}),
        };
      }
      return mockManager(tools);
    }

    it("leaves the plan disabled below thresholds and does not inject meta-tools", async () => {
      const manager = manyToolsManager(5);
      const result = await prepareChatV2({
        mcpClientManager: manager,
        selectedServers: ["srv"],
        modelDefinition: {
          id: "gpt-4.1",
          provider: "openai",
          contextLength: 200_000,
        } as any,
        systemPrompt: "Base prompt.",
      });
      expect(result.progressivePlan.enabled).toBe(false);
      expect(Object.keys(result.allTools)).not.toContain("search_mcp_tools");
      expect(Object.keys(result.allTools)).not.toContain("load_mcp_tools");
    });

    it("flips the plan on past the tool-count threshold and adds meta-tools", async () => {
      const manager = manyToolsManager(40);
      const result = await prepareChatV2({
        mcpClientManager: manager,
        selectedServers: ["srv"],
        modelDefinition: {
          id: "gpt-4.1",
          provider: "openai",
          contextLength: 200_000,
        } as any,
        systemPrompt: "Base prompt.",
      });
      expect(result.progressivePlan.enabled).toBe(true);
      expect(Object.keys(result.allTools)).toContain("search_mcp_tools");
      expect(Object.keys(result.allTools)).toContain("load_mcp_tools");
      expect(result.discoveryState.loadedToolIds.size).toBe(0);
    });

    it("respects the explicit options.enabled override", async () => {
      const manager = manyToolsManager(2);
      const result = await prepareChatV2({
        mcpClientManager: manager,
        selectedServers: ["srv"],
        modelDefinition: {
          id: "gpt-4.1",
          provider: "openai",
          contextLength: 200_000,
        } as any,
        systemPrompt: "Base prompt.",
        progressiveToolDiscovery: { enabled: true },
      });
      expect(result.progressivePlan.enabled).toBe(true);
      expect(result.progressivePlan.reasons).toEqual(["forced_on"]);
    });

    it("rejects MCP tools that collide with meta-tool names", async () => {
      const manager = manyToolsManager(40);
      manager.getToolsForAiSdk = vi.fn().mockResolvedValue({
        search_mcp_tools: {
          description: "fake tool",
          parameters: { jsonSchema: { type: "object", properties: {} } },
          _serverId: "srv",
          execute: async () => ({}),
        },
        // pad with extra tools so progressive trips and meta-tools are
        // actually merged in (collision check is enabled-only).
        ...Object.fromEntries(
          Array.from({ length: 40 }, (_, i) => [
            `pad_${i}`,
            {
              description: `pad ${i}`,
              parameters: { jsonSchema: { type: "object", properties: {} } },
              _serverId: "srv",
              execute: async () => ({}),
            },
          ]),
        ),
      });
      await expect(
        prepareChatV2({
          mcpClientManager: manager,
          selectedServers: ["srv"],
          modelDefinition: {
            id: "gpt-4.1",
            provider: "openai",
            contextLength: 200_000,
          } as any,
          systemPrompt: "Base prompt.",
        }),
      ).rejects.toThrow(/search_mcp_tools/);
    });
  });
});
