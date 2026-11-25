import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../skill-tools.js", () => ({
  getSkillToolsAndPrompt: vi.fn(),
}));

import { prepareChatV2 } from "../chat-v2-orchestration";
import { getSkillToolsAndPrompt } from "../skill-tools";
import { eventToolsFromBody } from "../../services/chat-turn/event-tools-body";
import { WebRouteError } from "../../routes/web/errors";
import { EVENT_AGENT_TOOL_NAMES } from "@/shared/event-agent-tools";

function mockManager(tools: Record<string, unknown>) {
  return {
    getToolsForAiSdk: vi.fn().mockResolvedValue(tools),
    getAllToolAnnotations: vi.fn(() => ({})),
    getAllToolsMetadata: vi.fn().mockReturnValue({}),
    listServers: vi.fn().mockReturnValue([]),
    hasServer: vi.fn().mockReturnValue(true),
  } as any;
}

const model = {
  id: "gpt-4.1",
  provider: "openai",
  contextLength: 200_000,
} as any;
const eventTools = {
  servers: [{ name: "flights", events: ["flight.status_changed"] }],
};
const allNames: string[] = Object.values(EVENT_AGENT_TOOL_NAMES).sort();

beforeEach(() => {
  vi.mocked(getSkillToolsAndPrompt).mockResolvedValue({
    tools: {},
    systemPromptSection: "",
  });
});

describe("prepareChatV2 — MCP Events agent tools", () => {
  it("advertises them as no-execute, approval-free tools scoped to the snapshot's servers", async () => {
    const result = await prepareChatV2({
      mcpClientManager: mockManager({}),
      modelDefinition: model,
      systemPrompt: "Base prompt.",
      requireToolApproval: true,
      eventTools,
    });

    expect(Object.keys(result.allTools).sort()).toEqual(allNames);
    const subscribe = result.allTools[
      EVENT_AGENT_TOOL_NAMES.subscribe
    ] as unknown as {
      execute?: unknown;
      needsApproval?: unknown;
      description?: string;
      inputSchema: {
        jsonSchema: { properties: { server: { enum: string[] } } };
      };
    };
    // The browser fulfils it through Connect event's path; no approval card.
    expect(subscribe.execute).toBeUndefined();
    expect(subscribe.needsApproval).toBeUndefined();
    expect(subscribe.description).toContain("flight.status_changed");
    expect(subscribe.inputSchema.jsonSchema.properties.server.enum).toEqual([
      "flights",
    ]);
  });

  it("advertises nothing without a snapshot, and nothing on a harness turn", async () => {
    const without = await prepareChatV2({
      mcpClientManager: mockManager({}),
      modelDefinition: model,
      systemPrompt: "Base prompt.",
    });
    expect(Object.keys(without.allTools)).toEqual([]);

    const harness = await prepareChatV2({
      mcpClientManager: mockManager({}),
      modelDefinition: model,
      systemPrompt: "Base prompt.",
      harness: "claude-code" as any,
      eventTools,
    });
    expect(
      Object.keys(harness.allTools).some((name) => allNames.includes(name)),
    ).toBe(false);
  });

  it("keeps a same-named server tool executable", async () => {
    const serverExecute = vi.fn();
    const result = await prepareChatV2({
      mcpClientManager: mockManager({
        [EVENT_AGENT_TOOL_NAMES.listEventTypes]: {
          description: "A server tool that took the name",
          _serverId: "srv",
          execute: serverExecute,
        },
      }),
      selectedServers: ["srv"],
      modelDefinition: model,
      systemPrompt: "Base prompt.",
      eventTools,
    });
    const entry = result.allTools[EVENT_AGENT_TOOL_NAMES.listEventTypes] as {
      execute?: unknown;
    };
    expect(entry.execute).toBe(serverExecute);
    expect(result.allTools[EVENT_AGENT_TOOL_NAMES.subscribe]).toBeDefined();
  });

  it("exempts them from progressive discovery, so the model can always subscribe", async () => {
    const tools: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) {
      tools[`srv_tool_${i}`] = {
        description: `server tool ${i}`,
        _serverId: "srv",
        execute: async () => ({ ok: true }),
      };
    }
    const result = await prepareChatV2({
      mcpClientManager: mockManager(tools),
      selectedServers: ["srv"],
      modelDefinition: model,
      systemPrompt: "Base prompt.",
      progressiveToolDiscovery: { enabled: true },
      eventTools,
    });
    expect(result.progressivePlan.enabled).toBe(true);
    const catalogNames = result.progressivePlan.catalog.map(
      (entry) => entry.modelName,
    );
    expect(catalogNames).toContain("srv_tool_0");
    expect(catalogNames).not.toContain(EVENT_AGENT_TOOL_NAMES.subscribe);
    expect(Object.keys(result.allTools)).toContain(
      EVENT_AGENT_TOOL_NAMES.subscribe,
    );
  });
});

describe("eventToolsFromBody", () => {
  it("returns undefined for an absent snapshot and refuses a malformed one with a 400", () => {
    expect(eventToolsFromBody(undefined)).toBeUndefined();
    expect(eventToolsFromBody({ servers: [] })).toBeUndefined();
    expect(eventToolsFromBody(eventTools)).toEqual(eventTools);
    let caught: unknown;
    try {
      eventToolsFromBody({ servers: [{ name: "", events: [] }] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WebRouteError);
    expect((caught as WebRouteError).status).toBe(400);
  });
});
