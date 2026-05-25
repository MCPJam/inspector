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

  it("hides SEP-1865 app-only tools from the model tool set", async () => {
    // Three tools: one model-only, one app-only (must be hidden), one
    // with the default both-visibility. The manager exposes _serverId
    // on each tool and getAllToolsMetadata() supplies the _meta.ui.
    const manager = mockManager({
      model_tool: { description: "model only", _serverId: "srv" },
      app_tool: { description: "app only", _serverId: "srv" },
      both_tool: { description: "default both", _serverId: "srv" },
    });
    manager.getAllToolsMetadata = vi.fn((id: string) =>
      id === "srv"
        ? {
            model_tool: { ui: { visibility: ["model"] } },
            app_tool: { ui: { visibility: ["app"] } },
            both_tool: { ui: { visibility: ["model", "app"] } },
          }
        : {},
    );

    const result = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: ["srv"],
      modelDefinition: { id: "gpt-4.1", provider: "openai" } as any,
      systemPrompt: "Base prompt.",
    });

    expect(Object.keys(result.allTools).sort()).toEqual([
      "both_tool",
      "model_tool",
    ]);
  });

  it("hides tools whose visibility array is set but omits 'model'", async () => {
    // SEP-1865: "Host MUST NOT include tools in the agent's tool list
    // when their visibility does not include 'model'." Covers `[]` and
    // any future scope literal that isn't "model" — the upstream
    // `isToolVisibilityAppOnly` helper only matches exactly `["app"]`
    // and would leak these through.
    const manager = mockManager({
      empty_visibility_tool: { description: "empty", _serverId: "srv" },
      future_scope_tool: { description: "future scope", _serverId: "srv" },
      omitted_visibility_tool: { description: "omitted", _serverId: "srv" },
    });
    manager.getAllToolsMetadata = vi.fn((id: string) =>
      id === "srv"
        ? {
            empty_visibility_tool: { ui: { visibility: [] } },
            // Cast through `any` — the typed schema only allows
            // "model"|"app", but the wire shape can carry anything.
            future_scope_tool: {
              ui: { visibility: ["future-scope"] as any },
            },
            // No `_meta.ui.visibility` at all → default `["model","app"]`.
            omitted_visibility_tool: {},
          }
        : {},
    );

    const result = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: ["srv"],
      modelDefinition: { id: "gpt-4.1", provider: "openai" } as any,
      systemPrompt: "Base prompt.",
    });

    expect(Object.keys(result.allTools)).toEqual(["omitted_visibility_tool"]);
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
});
