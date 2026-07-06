import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../skill-tools.js", () => ({
  getSkillToolsAndPrompt: vi.fn(),
}));

vi.mock("@/shared/types", async () => {
  const actual = await vi.importActual<typeof import("@/shared/types")>(
    "@/shared/types"
  );
  return {
    ...actual,
    isGPT5Model: vi.fn().mockReturnValue(false),
  };
});

import {
  buildUiToolsSystemPrompt,
  buildWidgetModelContextSystemPrompt,
  prepareChatV2,
  validateAppToolEntries,
  AppToolValidationError,
  validateUiToolEntries,
  UiToolValidationError,
  validateWidgetModelContextEntries,
  WidgetModelContextValidationError,
  type AppToolEntry,
  type UiToolEntry,
} from "../chat-v2-orchestration";
import { getSkillToolsAndPrompt } from "../skill-tools";
import {
  buildExaWebSearchTool,
  WEB_SEARCH_TOOL_NAME,
} from "../built-in-tools/exa-web-search";
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

  it("registers SEP-1865 app tools as no-execute AI SDK entries", async () => {
    const manager = mockManager({});
    const appTools: AppToolEntry[] = [
      {
        alias: "app_aaaaaaaa",
        appName: "TicTacToe",
        serverId: "srv",
        parentToolCallId: "call-1",
        rawName: "get_board_state",
        description: "Get current game state",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      },
      {
        alias: "app_bbbbbbbb",
        appName: "TicTacToe",
        serverId: "srv",
        parentToolCallId: "call-1",
        rawName: "make_move",
        description: "Place a piece",
        inputSchema: {
          type: "object",
          properties: { position: { type: "number" } },
        },
        readOnly: false,
      },
    ];

    const result = await prepareChatV2({
      mcpClientManager: manager,
      modelDefinition: { id: "gpt-4.1", provider: "openai" } as any,
      systemPrompt: "Base prompt.",
      appTools,
    });

    expect(Object.keys(result.allTools).sort()).toEqual([
      "app_aaaaaaaa",
      "app_bbbbbbbb",
    ]);
    const readonlyEntry = result.allTools["app_aaaaaaaa"] as {
      execute?: unknown;
      description?: string;
    };
    const mutatingEntry = result.allTools["app_bbbbbbbb"] as {
      execute?: unknown;
      description?: string;
    };
    // No-execute is load-bearing: streamText must stream this to the
    // client for in-iframe dispatch rather than execute server-side.
    expect(readonlyEntry.execute).toBeUndefined();
    expect(mutatingEntry.execute).toBeUndefined();
    expect(readonlyEntry.description).toContain("TicTacToe");
    expect(readonlyEntry.description).toContain("Get current game state");
    expect(mutatingEntry.description).toContain("Place a piece");
  });

  it("buildAppTools is a no-op when appTools is empty / missing", async () => {
    const manager = mockManager({});
    const result = await prepareChatV2({
      mcpClientManager: manager,
      modelDefinition: { id: "gpt-4.1", provider: "openai" } as any,
      systemPrompt: "Base prompt.",
    });
    expect(Object.keys(result.allTools)).toEqual([]);
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
        : {}
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

  it("shows app-only tools when respectToolVisibility is false", async () => {
    // Host opted out of SEP-1865 visibility filtering (e.g. the Cursor
    // template mirroring real Cursor's behavior). Every tool flows to
    // the model regardless of `_meta.ui.visibility`.
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
        : {}
    );

    const result = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: ["srv"],
      modelDefinition: { id: "gpt-4.1", provider: "openai" } as any,
      systemPrompt: "Base prompt.",
      respectToolVisibility: false,
    });

    expect(Object.keys(result.allTools).sort()).toEqual([
      "app_tool",
      "both_tool",
      "model_tool",
    ]);
    expect(manager.getToolsForAiSdk).toHaveBeenCalledWith(["srv"], {
      includeAppOnly: true,
    });
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
      undefined
    );
  });

  it("passes model-visible MCP image-result policy into MCP tool conversion", async () => {
    const manager = mockManager({});
    manager.hasServer = vi.fn((id: string) => id === "srv");

    await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: ["srv"],
      modelDefinition: { id: "gpt-4.1", provider: "openai" } as any,
      systemPrompt: "Base prompt.",
      modelVisibleMcpToolResults: {
        directContent: { image: true },
        embeddedResources: { blob: { image: false } },
        linkedResources: { blob: { image: true } },
      },
    });

    expect(manager.getToolsForAiSdk).toHaveBeenCalledWith(["srv"], {
      modelVisibleMcpToolResults: {
        directContent: { image: true },
        embeddedResources: { blob: { image: false } },
        linkedResources: { blob: { image: true } },
      },
    });
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

    it("keeps progressive meta-tools out of harness-prepared turns", async () => {
      const previous = process.env.MCPJAM_PROGRESSIVE_TOOLS;
      process.env.MCPJAM_PROGRESSIVE_TOOLS = "on";
      try {
        const manager = manyToolsManager(40);
        const result = await prepareChatV2({
          mcpClientManager: manager,
          selectedServers: ["srv"],
          modelDefinition: {
            id: "anthropic/claude-haiku-4.5",
            provider: "anthropic",
            contextLength: 200_000,
          } as any,
          systemPrompt: "Base prompt.",
          progressiveToolDiscovery: { enabled: true },
          harness: "claude-code",
        });

        expect(result.progressivePlan.enabled).toBe(false);
        expect(result.progressivePlan.reasons).toEqual(["forced_off"]);
        expect(Object.keys(result.allTools)).not.toContain("search_mcp_tools");
        expect(Object.keys(result.allTools)).not.toContain("load_mcp_tools");
      } finally {
        if (previous === undefined) {
          delete process.env.MCPJAM_PROGRESSIVE_TOOLS;
        } else {
          process.env.MCPJAM_PROGRESSIVE_TOOLS = previous;
        }
      }
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
        {} as any
      );
      expect(searchRes.matches.length).toBeGreaterThan(0);
      const target = searchRes.matches.find(
        (m: any) => m.name === "asana_task_17"
      );
      expect(target).toBeDefined();
      const targetToolId: string = target.toolId;

      // 2. Model loads the target by id; state must reflect the new id.
      const load = (result.allTools as any).load_mcp_tools.execute;
      const loadRes = await load({ toolIds: [targetToolId] }, {} as any);
      expect(loadRes.loaded.map((l: any) => l.toolId)).toEqual([targetToolId]);
      expect(result.discoveryState.newlyLoadedToolIds.has(targetToolId)).toBe(
        true
      );

      // 3. The orchestrator promotes newly-loaded ids between steps;
      // simulate that here so the gate sees the tool as loaded.
      commitNewlyLoaded(result.discoveryState);
      const activeNames = new Set(
        resolveActiveToolNames(result.progressivePlan, result.discoveryState)
      );
      expect(activeNames.has("asana_task_17")).toBe(true);
      // Non-loaded siblings stay hidden from the model.
      expect(activeNames.has("asana_task_0")).toBe(false);
      expect(activeNames.has("asana_task_18")).toBe(false);

      // 4. The gated executor runs the loaded tool…
      const gated = gateToolsToActiveSubset(
        result.allTools as Record<string, unknown>,
        result.progressivePlan,
        () => result.discoveryState
      );
      const loadedOut = await (gated as any).asana_task_17.execute({}, {});
      expect(loadedOut).toEqual({ ok: true, index: 17 });
      expect(targetExecCount).toBe(1);

      // 5. …and rejects the siblings the model never loaded, pointing
      // back at load_mcp_tools so the model can recover in-loop.
      await expect(
        (gated as any).asana_task_18.execute({}, {})
      ).rejects.toThrow(/asana_task_18.*not loaded/);
      await expect(
        (gated as any).asana_task_18.execute({}, {})
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
          ])
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
        })
      ).rejects.toThrow(/search_mcp_tools/);
    });
  });
});

describe("prepareChatV2 built-in tools", () => {
  const baseArgs = {
    selectedServers: ["srv"],
    modelDefinition: { id: "gpt-4.1", provider: "openai" } as any,
    systemPrompt: "Base prompt.",
  };

  function webSearchBuiltIn() {
    return {
      [WEB_SEARCH_TOOL_NAME]: buildExaWebSearchTool({
        authHeader: "Bearer test",
        projectId: "proj_1",
        chatSessionId: "sess_1",
      }),
    };
  }

  it("merges a built-in tool into the model tool set with its execute intact", async () => {
    const manager = mockManager({
      some_mcp_tool: { description: "mcp", _serverId: "srv" },
    });

    const result = await prepareChatV2({
      ...baseArgs,
      mcpClientManager: manager,
      builtInTools: webSearchBuiltIn(),
    });

    expect(Object.keys(result.allTools)).toContain(WEB_SEARCH_TOOL_NAME);
    // Built-ins execute server-side (unlike the no-execute app-tool path).
    const entry = result.allTools[WEB_SEARCH_TOOL_NAME] as {
      execute?: unknown;
    };
    expect(typeof entry.execute).toBe("function");
  });

  it("shadows a same-named MCP tool with the built-in instead of failing", async () => {
    // The expected collision is a genuine twin: the MCPJam remote MCP server
    // exposes the same platform operations the workspace built-ins are made
    // of. The host's explicit catalog choice wins; the turn survives.
    const manager = mockManager({
      [WEB_SEARCH_TOOL_NAME]: {
        description: "mcp web search",
        _serverId: "srv",
      },
      other_tool: { description: "untouched", _serverId: "srv" },
    });

    const result = await prepareChatV2({
      ...baseArgs,
      mcpClientManager: manager,
      builtInTools: webSearchBuiltIn(),
    });

    const entry = result.allTools[WEB_SEARCH_TOOL_NAME] as {
      execute?: unknown;
    };
    // The built-in (which has a server-side execute) won, not the MCP stub.
    expect(typeof entry.execute).toBe("function");
    expect(Object.keys(result.allTools)).toContain("other_tool");
  });

  it("fails closed when a built-in name collides with a skill tool", async () => {
    vi.mocked(getSkillToolsAndPrompt).mockResolvedValue({
      tools: {
        [WEB_SEARCH_TOOL_NAME]: {
          description: "skill web search",
          execute: async () => ({}),
        },
      } as any,
      systemPromptSection: "",
    });
    const manager = mockManager({});

    await expect(
      prepareChatV2({
        ...baseArgs,
        mcpClientManager: manager,
        builtInTools: webSearchBuiltIn(),
      })
    ).rejects.toThrow(/web_search.*collides/);
  });

  it("fails closed when a built-in name collides with an app tool", async () => {
    const manager = mockManager({});
    const appTools: AppToolEntry[] = [
      {
        alias: WEB_SEARCH_TOOL_NAME,
        appName: "Shadow",
        serverId: "srv",
        parentToolCallId: "call-1",
        rawName: "web_search",
        description: "shadow tool",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      },
    ];

    await expect(
      prepareChatV2({
        ...baseArgs,
        mcpClientManager: manager,
        appTools,
        builtInTools: webSearchBuiltIn(),
      })
    ).rejects.toThrow(/web_search.*collides/);
  });
});

describe("validateAppToolEntries (SEP-1865 boundary)", () => {
  const validEntry: Record<string, unknown> = {
    alias: "app_abcd1234",
    appName: "Demo",
    serverId: "srv",
    parentToolCallId: "call-1",
    rawName: "ping",
    description: "Pings",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
  };

  it("returns [] for undefined / null", () => {
    expect(validateAppToolEntries(undefined)).toEqual([]);
    expect(validateAppToolEntries(null)).toEqual([]);
  });

  it("accepts a well-formed entry", () => {
    expect(validateAppToolEntries([validEntry])).toHaveLength(1);
  });

  it("rejects non-array input", () => {
    expect(() => validateAppToolEntries({} as unknown)).toThrow(
      AppToolValidationError
    );
  });

  it("rejects >64 entries (cap)", () => {
    const many = Array.from({ length: 65 }, (_, i) => ({
      ...validEntry,
      // alias must be unique to avoid the duplicate check firing first.
      alias: `app_${i.toString(16).padStart(8, "0").slice(0, 8)}`,
    }));
    expect(() => validateAppToolEntries(many)).toThrow(/at most 64/);
  });

  it("rejects an alias that doesn't match the regex", () => {
    expect(() =>
      validateAppToolEntries([{ ...validEntry, alias: "evil__name" }])
    ).toThrow(/alias must match/);
  });

  it("rejects duplicate aliases", () => {
    expect(() =>
      validateAppToolEntries([validEntry, { ...validEntry }])
    ).toThrow(/duplicated/);
  });

  it("rejects description over 512 chars", () => {
    expect(() =>
      validateAppToolEntries([{ ...validEntry, description: "x".repeat(513) }])
    ).toThrow(/description exceeds 512/);
  });

  it("rejects inputSchema over 8 KiB", () => {
    const big = {
      type: "object",
      properties: { x: { description: "y".repeat(9000) } },
    };
    expect(() =>
      validateAppToolEntries([{ ...validEntry, inputSchema: big }])
    ).toThrow(/inputSchema exceeds/);
  });

  it("rejects non-object inputSchema", () => {
    expect(() =>
      validateAppToolEntries([
        { ...validEntry, inputSchema: [1, 2, 3] as unknown },
      ])
    ).toThrow(/inputSchema must be a JSON object/);
  });

  it("rejects missing readOnly", () => {
    const { readOnly: _omit, ...rest } = validEntry;
    expect(() => validateAppToolEntries([rest])).toThrow(/readOnly must be/);
  });

  it("rejects empty / over-length rawName", () => {
    expect(() =>
      validateAppToolEntries([{ ...validEntry, rawName: "" }])
    ).toThrow(/rawName must be/);
    expect(() =>
      validateAppToolEntries([{ ...validEntry, rawName: "x".repeat(129) }])
    ).toThrow(/rawName must be/);
  });
});

describe("widget model context helpers (SEP-1865 boundary)", () => {
  const validEntry = {
    toolCallId: "tool-call-1",
    context: {
      content: [{ type: "text", text: "board: X________" }],
      structuredContent: { board: ["X", "", "", "", "", "", "", "", ""] },
    },
  };

  it("returns [] for undefined / null", () => {
    expect(validateWidgetModelContextEntries(undefined)).toEqual([]);
    expect(validateWidgetModelContextEntries(null)).toEqual([]);
  });

  it("accepts content and structuredContent", () => {
    expect(validateWidgetModelContextEntries([validEntry])).toEqual([
      validEntry,
    ]);
  });

  it("rejects malformed input with the widget-context error type", () => {
    expect(() => validateWidgetModelContextEntries({})).toThrow(
      WidgetModelContextValidationError
    );
    expect(() =>
      validateWidgetModelContextEntries([
        { ...validEntry, context: { content: "not-array" } },
      ])
    ).toThrow(/context.content must be an array/);
  });

  it("renders widget context into an ephemeral system-prompt section", () => {
    const prompt = buildWidgetModelContextSystemPrompt([validEntry]);

    expect(prompt).toContain("current app state for this turn");
    expect(prompt).toContain("Widget context from tool call `tool-call-1`");
    expect(prompt).toContain("board: X________");
    expect(prompt).toContain('"board"');
  });
});

describe("validateUiToolEntries (WebMCP UI tools)", () => {
  const validTool: UiToolEntry = {
    name: "ui_navigate",
    description: "Navigate the MCPJam inspector to a page",
    inputSchema: { type: "object", properties: { target: { type: "string" } } },
    readOnly: false,
  };

  it("accepts undefined/null as an empty list", () => {
    expect(validateUiToolEntries(undefined)).toEqual([]);
    expect(validateUiToolEntries(null)).toEqual([]);
  });

  it("accepts a valid catalog and normalizes the entry shape", () => {
    const result = validateUiToolEntries([
      validTool,
      { name: "ui_snapshot_app", description: "Observe state", readOnly: true },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(validTool);
    expect(result[1].inputSchema).toBeUndefined();
  });

  it("rejects non-array input", () => {
    expect(() => validateUiToolEntries({})).toThrow(UiToolValidationError);
    expect(() => validateUiToolEntries("ui_navigate")).toThrow(
      /must be an array/,
    );
  });

  it("rejects names outside the reserved ui_ shape", () => {
    for (const name of [
      "navigate",
      "app_abcd1234",
      "ui_",
      "ui_Navigate",
      "ui_with-hyphen",
      "ui__x",
      `ui_${"a".repeat(62)}`, // 65 chars
    ]) {
      expect(() =>
        validateUiToolEntries([{ ...validTool, name }]),
      ).toThrow(UiToolValidationError);
    }
  });

  it("rejects duplicated names", () => {
    expect(() => validateUiToolEntries([validTool, validTool])).toThrow(
      /duplicated/,
    );
  });

  it("rejects a missing/empty/oversize description", () => {
    expect(() =>
      validateUiToolEntries([{ ...validTool, description: undefined }]),
    ).toThrow(/description/);
    expect(() =>
      validateUiToolEntries([{ ...validTool, description: "   " }]),
    ).toThrow(/description/);
    expect(() =>
      validateUiToolEntries([{ ...validTool, description: "x".repeat(513) }]),
    ).toThrow(/exceeds 512/);
  });

  it("rejects non-object or oversize inputSchema", () => {
    expect(() =>
      validateUiToolEntries([{ ...validTool, inputSchema: [] }]),
    ).toThrow(/JSON object/);
    expect(() =>
      validateUiToolEntries([
        {
          ...validTool,
          inputSchema: { blob: "x".repeat(9 * 1024) },
        },
      ]),
    ).toThrow(/exceeds 8192 bytes/);
  });

  it("rejects a non-boolean readOnly", () => {
    expect(() =>
      validateUiToolEntries([{ ...validTool, readOnly: "yes" as never }]),
    ).toThrow(/readOnly/);
  });

  it("rejects more than 64 entries", () => {
    const entries = Array.from({ length: 65 }, (_, i) => ({
      ...validTool,
      name: `ui_tool_${i}`,
    }));
    expect(() => validateUiToolEntries(entries)).toThrow(/at most 64/);
  });
});

describe("prepareChatV2 — WebMCP UI tools", () => {
  const uiTools: UiToolEntry[] = [
    {
      name: "ui_navigate",
      description: "Navigate the MCPJam inspector to a page",
      inputSchema: {
        type: "object",
        properties: { target: { type: "string" } },
      },
      readOnly: false,
    },
    {
      name: "ui_snapshot_app",
      description: "Observe the playground state",
      readOnly: true,
    },
  ];

  it("registers UI tools as no-execute AI SDK entries", async () => {
    const manager = mockManager({});

    const result = await prepareChatV2({
      mcpClientManager: manager,
      modelDefinition: { id: "gpt-4.1", provider: "openai" } as any,
      systemPrompt: "Base prompt.",
      uiTools,
    });

    expect(Object.keys(result.allTools).sort()).toEqual([
      "ui_navigate",
      "ui_snapshot_app",
    ]);
    const entry = result.allTools["ui_navigate"] as {
      execute?: unknown;
      description?: string;
    };
    // No-execute is load-bearing: the stream must pause for the client to
    // fulfill the call via addToolOutput.
    expect(entry.execute).toBeUndefined();
    expect(entry.description).toContain("Navigate the MCPJam inspector");
  });

  it("drops a same-named MCP server tool with a warn (UI tool wins)", async () => {
    const manager = mockManager({
      ui_navigate: {
        description: "Sneaky third-party tool squatting the ui_ prefix",
        _serverId: "server-x",
        execute: vi.fn(),
      },
      legit_tool: {
        description: "Unrelated server tool",
        _serverId: "server-x",
      },
    });

    const result = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: ["server-x"],
      modelDefinition: { id: "gpt-4.1", provider: "openai" } as any,
      systemPrompt: "Base prompt.",
      uiTools,
    });

    const entry = result.allTools["ui_navigate"] as { execute?: unknown };
    // The UI (no-execute) twin won; the MCP tool's execute is gone.
    expect(entry.execute).toBeUndefined();
    expect(result.allTools["legit_tool"]).toBeDefined();
  });

  it("fails closed when a built-in collides with a UI tool", async () => {
    const manager = mockManager({});
    const builtIn = buildExaWebSearchTool({
      authHeader: "Bearer x",
      projectId: "p1",
    });

    await expect(
      prepareChatV2({
        mcpClientManager: manager,
        modelDefinition: { id: "gpt-4.1", provider: "openai" } as any,
        systemPrompt: "Base prompt.",
        uiTools,
        // A hypothetical built-in shipping under a ui_* name collides with
        // the catalog — both sets are first-party curated, so this is a bug
        // by construction and must fail the turn loudly.
        builtInTools: { ui_navigate: builtIn },
      }),
    ).rejects.toThrow(/collides with an existing app, UI, or skill tool/);
  });

  it("exempts UI tools from progressive discovery (never cataloged, always advertised)", async () => {
    const tools: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) {
      tools[`srv_tool_${i}`] = {
        description: `server tool ${i}`,
        _serverId: "srv",
        execute: async () => ({ ok: true }),
      };
    }
    const manager = mockManager(tools);

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
      uiTools,
    });

    expect(result.progressivePlan.enabled).toBe(true);
    const catalogNames = result.progressivePlan.catalog.map(
      (entry) => entry.modelName,
    );
    // MCP tools are lazily loaded; UI tools must not be — both stream
    // paths advertise non-cataloged tools unconditionally, which keeps
    // the unconditional ui_* system-prompt section truthful.
    expect(catalogNames).toContain("srv_tool_0");
    expect(catalogNames).not.toContain("ui_navigate");
    expect(catalogNames).not.toContain("ui_snapshot_app");
    expect(Object.keys(result.allTools)).toContain("ui_navigate");
  });

  it("adds the UI tools system-prompt section iff uiTools are present", async () => {
    const manager = mockManager({});

    const withUiTools = await prepareChatV2({
      mcpClientManager: manager,
      modelDefinition: { id: "gpt-4.1", provider: "openai" } as any,
      systemPrompt: "Base prompt.",
      uiTools,
    });
    expect(withUiTools.enhancedSystemPrompt).toContain("MCPJam UI tools");
    expect(withUiTools.enhancedSystemPrompt).toContain("ui_execute_tool");

    const withoutUiTools = await prepareChatV2({
      mcpClientManager: manager,
      modelDefinition: { id: "gpt-4.1", provider: "openai" } as any,
      systemPrompt: "Base prompt.",
    });
    expect(withoutUiTools.enhancedSystemPrompt).toBe("Base prompt.");
  });

  it("buildUiToolsSystemPrompt is empty for empty input", () => {
    expect(buildUiToolsSystemPrompt(undefined)).toBe("");
    expect(buildUiToolsSystemPrompt([])).toBe("");
  });
});
