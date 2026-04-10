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
});
