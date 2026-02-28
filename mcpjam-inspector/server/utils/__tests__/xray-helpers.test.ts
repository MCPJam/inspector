import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock skill-tools before importing the module under test
vi.mock("../skill-tools.js", () => ({
  getSkillToolsAndPrompt: vi.fn(),
}));

import { buildXRayPayload } from "../xray-helpers";
import { getSkillToolsAndPrompt } from "../skill-tools";
import type { MCPClientManager } from "@mcpjam/sdk";

// Helper to create a mock MCPClientManager with a given tool map
function mockManager(tools: Record<string, unknown> = {}): MCPClientManager {
  return {
    getToolsForAiSdk: vi.fn().mockResolvedValue(tools),
  } as unknown as MCPClientManager;
}

beforeEach(() => {
  vi.mocked(getSkillToolsAndPrompt).mockResolvedValue({
    tools: {},
    systemPromptSection: "",
  });
});

describe("buildXRayPayload", () => {
  it("returns empty tools and messages when no servers are connected", async () => {
    const result = await buildXRayPayload(mockManager(), [], [], undefined);

    expect(result).toEqual({
      system: "",
      tools: {},
      messages: [],
    });
  });

  it("passes through messages unchanged", async () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    const result = await buildXRayPayload(
      mockManager(),
      [],
      messages,
      undefined,
    );

    expect(result.messages).toEqual(messages);
  });

  it("uses systemPrompt when provided", async () => {
    const result = await buildXRayPayload(
      mockManager(),
      [],
      [],
      "You are helpful.",
    );

    expect(result.system).toBe("You are helpful.");
  });

  it("appends skill prompt section to system prompt", async () => {
    vi.mocked(getSkillToolsAndPrompt).mockResolvedValue({
      tools: {},
      systemPromptSection: "\n\n## Skills\n- foo",
    });

    const result = await buildXRayPayload(
      mockManager(),
      [],
      [],
      "Base prompt.",
    );

    expect(result.system).toBe("Base prompt.\n\n## Skills\n- foo");
  });

  it("uses only skill prompt section when no system prompt given", async () => {
    vi.mocked(getSkillToolsAndPrompt).mockResolvedValue({
      tools: {},
      systemPromptSection: "\n\n## Skills\n- bar",
    });

    const result = await buildXRayPayload(mockManager(), [], [], undefined);

    expect(result.system).toBe("\n\n## Skills\n- bar");
  });

  it("falls back to empty schema for MCP tools with plain inputSchema (known bug)", async () => {
    // Known issue: MCP tools carry `inputSchema` as raw JSON Schema, but the
    // serializer tries to run it through `z.toJSONSchema()` (which expects a
    // Zod schema), so it throws and falls back to the empty object schema.
    // This test documents the current (buggy) behavior.
    const jsonSchema = {
      type: "object",
      properties: { query: { type: "string" } },
    };

    const manager = mockManager({
      search: {
        description: "Search things",
        inputSchema: jsonSchema,
      },
    });

    const result = await buildXRayPayload(manager, ["server1"], [], undefined);

    expect(result.tools.search).toEqual({
      name: "search",
      description: "Search things",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
  });

  it("serializes AI SDK tools that use the jsonSchema wrapper", async () => {
    // AI SDK wraps Zod schemas with a `jsonSchema` property containing the
    // already-converted JSON Schema representation.
    const innerJsonSchema = {
      type: "object",
      properties: { name: { type: "string" } },
    };

    const manager = mockManager({
      greet: {
        description: "Greet someone",
        parameters: { jsonSchema: innerJsonSchema },
      },
    });

    const result = await buildXRayPayload(manager, ["s1"], [], undefined);

    expect(result.tools.greet).toEqual({
      name: "greet",
      description: "Greet someone",
      inputSchema: innerJsonSchema,
    });
  });

  it("falls back to empty object schema when serialization throws", async () => {
    // A schema that isn't a jsonSchema wrapper and isn't a valid Zod schema —
    // the z.toJSONSchema() call will throw.
    const manager = mockManager({
      broken: {
        description: "Broken tool",
        parameters: { notZod: true },
      },
    });

    const result = await buildXRayPayload(manager, ["s1"], [], undefined);

    expect(result.tools.broken).toEqual({
      name: "broken",
      description: "Broken tool",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
  });

  it("defaults to empty object schema when tool has no schema at all", async () => {
    const manager = mockManager({
      noSchema: {
        description: "No schema tool",
      },
    });

    const result = await buildXRayPayload(manager, ["s1"], [], undefined);

    expect(result.tools.noSchema).toEqual({
      name: "noSchema",
      description: "No schema tool",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
  });

  it("skips falsy tools", async () => {
    const manager = mockManager({
      real: { description: "Real tool" },
      empty: null,
      gone: undefined,
    });

    const result = await buildXRayPayload(manager, ["s1"], [], undefined);

    expect(Object.keys(result.tools)).toEqual(["real"]);
  });

  it("merges MCP tools with skill tools", async () => {
    const skillJsonSchema = {
      type: "object",
      properties: { name: { type: "string" } },
    };

    vi.mocked(getSkillToolsAndPrompt).mockResolvedValue({
      tools: {
        loadSkill: {
          description: "Load a skill",
          parameters: { jsonSchema: skillJsonSchema },
        },
      } as any,
      systemPromptSection: "",
    });

    const manager = mockManager({
      mcpTool: {
        description: "An MCP tool",
        inputSchema: { type: "object", properties: {} },
      },
    });

    const result = await buildXRayPayload(manager, ["s1"], [], undefined);

    expect(result.tools).toHaveProperty("mcpTool");
    expect(result.tools).toHaveProperty("loadSkill");
  });

  it("forwards serverIds to manager.getToolsForAiSdk", async () => {
    const manager = mockManager();

    await buildXRayPayload(manager, ["a", "b", "c"], [], undefined);

    expect(manager.getToolsForAiSdk).toHaveBeenCalledWith(["a", "b", "c"]);
  });
});
