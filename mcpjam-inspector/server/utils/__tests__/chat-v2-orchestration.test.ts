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
      "answer from this list instead of saying you do not have MCP visibility.",
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
});
