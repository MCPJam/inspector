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
import {
  commitNewlyLoaded,
  gateToolsToActiveSubset,
  resolveActiveToolNames,
} from "@/shared/progressive-tool-discovery";

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

    it("supports the full search → load → real-tool-call loop end to end", async () => {
      // End-to-end exercise of the progressive flow on a large
      // catalog: the model uses `search_mcp_tools` to locate the
      // target, `load_mcp_tools` to activate it, and the gated
      // executor accepts the now-loaded call while still rejecting
      // siblings that were never loaded. This catches wiring
      // regressions the unit tests in isolation would miss (e.g.
      // active-name resolution drift, state-mutation ordering, or
      // gate visibility of the model-name vs tool-id).
      const TOOL_COUNT = 40;
      const tools: Record<string, unknown> = {};
      let targetExecCount = 0;
      for (let i = 0; i < TOOL_COUNT; i++) {
        const isTarget = i === 17;
        tools[`asana_task_${i}`] = {
          description: isTarget
            ? "Create a new task in Asana with title and assignee"
            : `dummy tool ${i}`,
          parameters: { jsonSchema: { type: "object", properties: {} } },
          _serverId: "asana",
          execute: async () => {
            if (isTarget) targetExecCount += 1;
            return { ok: true, index: i };
          },
        };
      }
      const manager = mockManager(tools);
      const result = await prepareChatV2({
        mcpClientManager: manager,
        selectedServers: ["asana"],
        modelDefinition: {
          id: "gpt-4.1",
          provider: "openai",
          contextLength: 200_000,
        } as any,
        systemPrompt: "Base prompt.",
      });
      expect(result.progressivePlan.enabled).toBe(true);

      // 1. Model calls search_mcp_tools to find the target.
      const search = (result.allTools as any).search_mcp_tools.execute;
      const searchRes = await search(
        { query: "create task assignee" },
        {} as any,
      );
      expect(searchRes.matches.length).toBeGreaterThan(0);
      const target = searchRes.matches.find(
        (m: any) => m.name === "asana_task_17",
      );
      expect(target).toBeDefined();
      const targetToolId: string = target.toolId;

      // 2. Model loads the target by id; state must reflect the new id.
      const load = (result.allTools as any).load_mcp_tools.execute;
      const loadRes = await load({ toolIds: [targetToolId] }, {} as any);
      expect(loadRes.loaded.map((l: any) => l.toolId)).toEqual([targetToolId]);
      expect(result.discoveryState.newlyLoadedToolIds.has(targetToolId)).toBe(
        true,
      );

      // 3. The orchestrator promotes newly-loaded ids between steps;
      // simulate that here so the gate sees the tool as loaded.
      commitNewlyLoaded(result.discoveryState);
      const activeNames = new Set(
        resolveActiveToolNames(result.progressivePlan, result.discoveryState),
      );
      expect(activeNames.has("asana_task_17")).toBe(true);
      // Non-loaded siblings stay hidden from the model.
      expect(activeNames.has("asana_task_0")).toBe(false);
      expect(activeNames.has("asana_task_18")).toBe(false);

      // 4. The gated executor runs the loaded tool…
      const gated = gateToolsToActiveSubset(
        result.allTools as Record<string, unknown>,
        result.progressivePlan,
        () => result.discoveryState,
      );
      const loadedOut = await (gated as any).asana_task_17.execute({}, {});
      expect(loadedOut).toEqual({ ok: true, index: 17 });
      expect(targetExecCount).toBe(1);

      // 5. …and rejects the siblings the model never loaded, pointing
      // back at load_mcp_tools so the model can recover in-loop.
      await expect(
        (gated as any).asana_task_18.execute({}, {}),
      ).rejects.toThrow(/asana_task_18.*not loaded/);
      await expect(
        (gated as any).asana_task_18.execute({}, {}),
      ).rejects.toThrow(/load_mcp_tools/);
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
