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
  } as any;
}

beforeEach(() => {
  vi.mocked(getSkillToolsAndPrompt).mockResolvedValue({
    tools: {},
    systemPromptSection: "",
  });
});

describe("prepareChatV2", () => {
  it("adds MCP tool inventory to the prompt for hosted chat", async () => {
    const manager = mockManager({
      fetch_tasks: {
        description: "Fetch tasks from the task service",
        _serverId: "server-b",
      },
      find_users: {
        description: "Find users in the directory",
        _serverId: "server-a",
      },
    });

    const result = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: ["server-a", "server-b"],
      modelDefinition: { id: "gpt-4.1", provider: "openai" } as any,
      systemPrompt: "Base prompt.",
      includeMcpToolInventory: true,
    });

    expect(result.enhancedSystemPrompt).toContain("## Connected MCP Tools");
    expect(result.enhancedSystemPrompt).toContain(
      "Tool availability can change between turns. Only the MCP tools listed in this section are currently callable.",
    );
    expect(result.enhancedSystemPrompt).toContain(
      "answer from this list instead of saying you do not have MCP visibility.",
    );
    expect(result.enhancedSystemPrompt).toContain(
      "If a tool was mentioned earlier in the conversation but is not listed here, do not call it and do not claim it is still available.",
    );
    expect(result.enhancedSystemPrompt).toContain(
      "If the user explicitly asks you to call or use one of these tools by name, call it instead of claiming you do not have it.",
    );
    expect(result.enhancedSystemPrompt).toContain(
      "Server server-a:\n- find_users: Find users in the directory",
    );
    expect(result.enhancedSystemPrompt).toContain(
      "Server server-b:\n- fetch_tasks: Fetch tasks from the task service",
    );
    expect(
      result.enhancedSystemPrompt.indexOf("Server server-a:"),
    ).toBeLessThan(result.enhancedSystemPrompt.indexOf("Server server-b:"));
    expect(manager.getToolsForAiSdk).toHaveBeenCalledWith(
      ["server-a", "server-b"],
      undefined,
    );
  });

  it("does not add MCP tool inventory unless requested", async () => {
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

  it("adds an explicit empty MCP inventory when no MCP tools are connected", async () => {
    const manager = mockManager({});

    const result = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: [],
      modelDefinition: { id: "gpt-4.1", provider: "openai" } as any,
      systemPrompt: "Base prompt.",
      includeMcpToolInventory: true,
    });

    expect(result.enhancedSystemPrompt).toContain("## Connected MCP Tools");
    expect(result.enhancedSystemPrompt).toContain(
      "No MCP tools are currently connected.",
    );
    expect(result.enhancedSystemPrompt).toContain(
      "If a tool was mentioned earlier in the conversation but is not listed here, do not call it and do not claim it is still available.",
    );
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
});
