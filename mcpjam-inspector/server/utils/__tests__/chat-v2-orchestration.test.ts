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

import {
  prepareChatV2,
  validateAppToolEntries,
  AppToolValidationError,
  type AppToolEntry,
} from "../chat-v2-orchestration";
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

  it("registers SEP-1865 readonly app tools as no-execute AI SDK entries", async () => {
    // PR 1 hard rule: only readOnlyHint=true tools reach the model.
    // Non-readonly entries are dropped at advertise time (defense in
    // depth — the client snapshotter is the primary filter).
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

    expect(Object.keys(result.allTools).sort()).toEqual(["app_aaaaaaaa"]);
    const readonlyEntry = result.allTools["app_aaaaaaaa"] as {
      execute?: unknown;
      description?: string;
    };
    // No-execute is load-bearing: streamText must stream this to the
    // client for in-iframe dispatch rather than execute server-side.
    expect(readonlyEntry.execute).toBeUndefined();
    expect(readonlyEntry.description).toContain("TicTacToe");
    expect(readonlyEntry.description).toContain("Get current game state");
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
      AppToolValidationError,
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
      validateAppToolEntries([{ ...validEntry, alias: "evil__name" }]),
    ).toThrow(/alias must match/);
  });

  it("rejects duplicate aliases", () => {
    expect(() =>
      validateAppToolEntries([validEntry, { ...validEntry }]),
    ).toThrow(/duplicated/);
  });

  it("rejects description over 512 chars", () => {
    expect(() =>
      validateAppToolEntries([
        { ...validEntry, description: "x".repeat(513) },
      ]),
    ).toThrow(/description exceeds 512/);
  });

  it("rejects inputSchema over 8 KiB", () => {
    const big = { type: "object", properties: { x: { description: "y".repeat(9000) } } };
    expect(() =>
      validateAppToolEntries([{ ...validEntry, inputSchema: big }]),
    ).toThrow(/inputSchema exceeds/);
  });

  it("rejects non-object inputSchema", () => {
    expect(() =>
      validateAppToolEntries([
        { ...validEntry, inputSchema: [1, 2, 3] as unknown },
      ]),
    ).toThrow(/inputSchema must be a JSON object/);
  });

  it("rejects missing readOnly", () => {
    const { readOnly: _omit, ...rest } = validEntry;
    expect(() => validateAppToolEntries([rest])).toThrow(/readOnly must be/);
  });

  it("rejects empty / over-length rawName", () => {
    expect(() =>
      validateAppToolEntries([{ ...validEntry, rawName: "" }]),
    ).toThrow(/rawName must be/);
    expect(() =>
      validateAppToolEntries([{ ...validEntry, rawName: "x".repeat(129) }]),
    ).toThrow(/rawName must be/);
  });
});
