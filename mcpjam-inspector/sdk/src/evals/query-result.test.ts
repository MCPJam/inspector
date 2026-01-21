import { describe, it, expect } from "vitest";
import { QueryResult } from "./query-result.js";
import type { ToolCallWithMetadata } from "./types.js";

function createQueryResult(
  toolCalls: ToolCallWithMetadata[] = [],
  options: Partial<
    Parameters<(typeof QueryResult.prototype)["toJSON"]>[0]
  > = {},
) {
  return new QueryResult({
    query: options.query ?? "test query",
    response: options.response ?? "test response",
    toolCalls,
    usage: options.usage ?? {
      totalTokens: 100,
      inputTokens: 50,
      outputTokens: 50,
    },
    e2eLatencyMs: options.e2eLatencyMs ?? 1000,
    llmLatencyMs: options.llmLatencyMs,
    mcpLatencyMs: options.mcpLatencyMs,
    success: options.success ?? true,
    error: options.error,
  });
}

describe("QueryResult", () => {
  describe("constructor", () => {
    it("creates instance with all properties", () => {
      const toolCalls: ToolCallWithMetadata[] = [
        { toolName: "create_task", arguments: { title: "Test" } },
      ];

      const result = new QueryResult({
        query: "Create a task",
        response: "I created a task for you.",
        toolCalls,
        usage: { totalTokens: 500, inputTokens: 100, outputTokens: 400 },
        e2eLatencyMs: 2000,
        llmLatencyMs: 1500,
        mcpLatencyMs: 300,
        success: true,
      });

      expect(result.query).toBe("Create a task");
      expect(result.response).toBe("I created a task for you.");
      expect(result.toolCalls).toEqual(toolCalls);
      expect(result.usage).toEqual({
        totalTokens: 500,
        inputTokens: 100,
        outputTokens: 400,
      });
      expect(result.e2eLatencyMs).toBe(2000);
      expect(result.llmLatencyMs).toBe(1500);
      expect(result.mcpLatencyMs).toBe(300);
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("calculates mcpLatencyMs from tool call durations when not provided", () => {
      const toolCalls: ToolCallWithMetadata[] = [
        { toolName: "tool_a", arguments: {}, durationMs: 100 },
        { toolName: "tool_b", arguments: {}, durationMs: 150 },
        { toolName: "tool_c", arguments: {}, durationMs: 50 },
      ];

      const result = createQueryResult(toolCalls);

      expect(result.mcpLatencyMs).toBe(300);
    });

    it("defaults to 0 for llmLatencyMs when not provided", () => {
      const result = createQueryResult([]);

      expect(result.llmLatencyMs).toBe(0);
    });
  });

  describe("toolsCalled", () => {
    it("returns array of tool names in order", () => {
      const result = createQueryResult([
        { toolName: "search", arguments: {} },
        { toolName: "update", arguments: {} },
        { toolName: "search", arguments: {} },
      ]);

      expect(result.toolsCalled()).toEqual(["search", "update", "search"]);
    });

    it("returns empty array when no tools called", () => {
      const result = createQueryResult([]);

      expect(result.toolsCalled()).toEqual([]);
    });
  });

  describe("uniqueToolsCalled", () => {
    it("returns unique tool names", () => {
      const result = createQueryResult([
        { toolName: "search", arguments: {} },
        { toolName: "update", arguments: {} },
        { toolName: "search", arguments: {} },
        { toolName: "delete", arguments: {} },
      ]);

      expect(result.uniqueToolsCalled()).toEqual([
        "search",
        "update",
        "delete",
      ]);
    });

    it("returns empty array when no tools called", () => {
      const result = createQueryResult([]);

      expect(result.uniqueToolsCalled()).toEqual([]);
    });
  });

  describe("hasToolCall", () => {
    it("returns true when tool was called", () => {
      const result = createQueryResult([
        { toolName: "create_project", arguments: { name: "Test" } },
      ]);

      expect(result.hasToolCall("create_project")).toBe(true);
    });

    it("returns false when tool was not called", () => {
      const result = createQueryResult([
        { toolName: "create_project", arguments: {} },
      ]);

      expect(result.hasToolCall("delete_project")).toBe(false);
    });

    it("returns false when no tools called", () => {
      const result = createQueryResult([]);

      expect(result.hasToolCall("any_tool")).toBe(false);
    });
  });

  describe("hasToolCalls", () => {
    it("returns true when all expected tools were called with matching args", () => {
      const result = createQueryResult([
        {
          toolName: "create_task",
          arguments: { title: "My Task", priority: "high" },
        },
        { toolName: "assign_task", arguments: { userId: "123" } },
      ]);

      const passed = result.hasToolCalls([
        { toolName: "create_task", arguments: { title: "My Task" } },
        { toolName: "assign_task", arguments: { userId: "123" } },
      ]);

      expect(passed).toBe(true);
    });

    it("returns true when actual has extra tools (subset check)", () => {
      const result = createQueryResult([
        { toolName: "search", arguments: {} },
        { toolName: "create", arguments: {} },
        { toolName: "update", arguments: {} },
      ]);

      const passed = result.hasToolCalls([
        { toolName: "create", arguments: {} },
      ]);

      expect(passed).toBe(true);
    });

    it("returns false when expected tool is missing", () => {
      const result = createQueryResult([{ toolName: "search", arguments: {} }]);

      const passed = result.hasToolCalls([
        { toolName: "search", arguments: {} },
        { toolName: "create", arguments: {} },
      ]);

      expect(passed).toBe(false);
    });

    it("returns false when arguments don't match", () => {
      const result = createQueryResult([
        { toolName: "create", arguments: { name: "Wrong Name" } },
      ]);

      const passed = result.hasToolCalls([
        { toolName: "create", arguments: { name: "Expected Name" } },
      ]);

      expect(passed).toBe(false);
    });

    it("returns true for empty expected array", () => {
      const result = createQueryResult([
        { toolName: "some_tool", arguments: {} },
      ]);

      expect(result.hasToolCalls([])).toBe(true);
    });
  });

  describe("hasExactToolCalls", () => {
    it("returns true when exactly these tools were called", () => {
      const result = createQueryResult([
        { toolName: "search", arguments: {} },
        { toolName: "update", arguments: {} },
      ]);

      expect(result.hasExactToolCalls(["search", "update"])).toBe(true);
      expect(result.hasExactToolCalls(["update", "search"])).toBe(true);
    });

    it("returns false when extra tools were called", () => {
      const result = createQueryResult([
        { toolName: "search", arguments: {} },
        { toolName: "update", arguments: {} },
        { toolName: "delete", arguments: {} },
      ]);

      expect(result.hasExactToolCalls(["search", "update"])).toBe(false);
    });

    it("returns false when expected tools are missing", () => {
      const result = createQueryResult([{ toolName: "search", arguments: {} }]);

      expect(result.hasExactToolCalls(["search", "update"])).toBe(false);
    });

    it("handles duplicate tool calls correctly (uses unique names)", () => {
      const result = createQueryResult([
        { toolName: "search", arguments: { query: "a" } },
        { toolName: "search", arguments: { query: "b" } },
        { toolName: "update", arguments: {} },
      ]);

      expect(result.hasExactToolCalls(["search", "update"])).toBe(true);
    });
  });

  describe("getToolCallsByName", () => {
    it("returns all tool calls matching the name", () => {
      const result = createQueryResult([
        { toolName: "search", arguments: { query: "a" } },
        { toolName: "update", arguments: {} },
        { toolName: "search", arguments: { query: "b" } },
      ]);

      const searchCalls = result.getToolCallsByName("search");

      expect(searchCalls).toHaveLength(2);
      expect(searchCalls[0].arguments).toEqual({ query: "a" });
      expect(searchCalls[1].arguments).toEqual({ query: "b" });
    });

    it("returns empty array when no matches", () => {
      const result = createQueryResult([{ toolName: "search", arguments: {} }]);

      expect(result.getToolCallsByName("nonexistent")).toEqual([]);
    });
  });

  describe("getFirstToolCall", () => {
    it("returns first matching tool call", () => {
      const result = createQueryResult([
        { toolName: "search", arguments: { query: "first" } },
        { toolName: "search", arguments: { query: "second" } },
      ]);

      const first = result.getFirstToolCall("search");

      expect(first?.arguments).toEqual({ query: "first" });
    });

    it("returns undefined when no match", () => {
      const result = createQueryResult([{ toolName: "search", arguments: {} }]);

      expect(result.getFirstToolCall("nonexistent")).toBeUndefined();
    });
  });

  describe("tool call count methods", () => {
    it("toolCallCount returns correct count", () => {
      const result = createQueryResult([
        { toolName: "a", arguments: {} },
        { toolName: "b", arguments: {} },
        { toolName: "c", arguments: {} },
      ]);

      expect(result.toolCallCount()).toBe(3);
    });

    it("hasAnyToolCalls returns true when tools were called", () => {
      const result = createQueryResult([{ toolName: "a", arguments: {} }]);

      expect(result.hasAnyToolCalls()).toBe(true);
    });

    it("hasAnyToolCalls returns false when no tools called", () => {
      const result = createQueryResult([]);

      expect(result.hasAnyToolCalls()).toBe(false);
    });

    it("hasNoToolCalls returns true when no tools called", () => {
      const result = createQueryResult([]);

      expect(result.hasNoToolCalls()).toBe(true);
    });

    it("hasNoToolCalls returns false when tools were called", () => {
      const result = createQueryResult([{ toolName: "a", arguments: {} }]);

      expect(result.hasNoToolCalls()).toBe(false);
    });
  });

  describe("token methods", () => {
    it("returns token counts from usage", () => {
      const result = new QueryResult({
        query: "test",
        response: "test",
        toolCalls: [],
        usage: { totalTokens: 1000, inputTokens: 300, outputTokens: 700 },
        e2eLatencyMs: 100,
        success: true,
      });

      expect(result.totalTokens()).toBe(1000);
      expect(result.inputTokens()).toBe(300);
      expect(result.outputTokens()).toBe(700);
    });

    it("returns 0 for undefined token counts", () => {
      const result = new QueryResult({
        query: "test",
        response: "test",
        toolCalls: [],
        usage: {},
        e2eLatencyMs: 100,
        success: true,
      });

      expect(result.totalTokens()).toBe(0);
      expect(result.inputTokens()).toBe(0);
      expect(result.outputTokens()).toBe(0);
    });
  });

  describe("toJSON", () => {
    it("returns plain object representation", () => {
      const toolCalls: ToolCallWithMetadata[] = [
        { toolName: "test", arguments: { key: "value" } },
      ];

      const result = new QueryResult({
        query: "my query",
        response: "my response",
        toolCalls,
        usage: { totalTokens: 50 },
        e2eLatencyMs: 500,
        llmLatencyMs: 300,
        mcpLatencyMs: 100,
        success: true,
        error: undefined,
      });

      const json = result.toJSON();

      expect(json).toEqual({
        query: "my query",
        response: "my response",
        toolCalls,
        usage: { totalTokens: 50 },
        e2eLatencyMs: 500,
        llmLatencyMs: 300,
        mcpLatencyMs: 100,
        success: true,
        error: undefined,
      });
    });
  });

  describe("argument matching", () => {
    it("matches nested objects", () => {
      const result = createQueryResult([
        {
          toolName: "create",
          arguments: {
            config: { nested: { deep: true }, other: "value" },
          },
        },
      ]);

      expect(
        result.hasToolCalls([
          {
            toolName: "create",
            arguments: { config: { nested: { deep: true } } },
          },
        ]),
      ).toBe(true);
    });

    it("matches arrays", () => {
      const result = createQueryResult([
        {
          toolName: "batch",
          arguments: { ids: [1, 2, 3] },
        },
      ]);

      expect(
        result.hasToolCalls([
          { toolName: "batch", arguments: { ids: [1, 2, 3] } },
        ]),
      ).toBe(true);
    });

    it("fails on array length mismatch", () => {
      const result = createQueryResult([
        {
          toolName: "batch",
          arguments: { ids: [1, 2, 3] },
        },
      ]);

      expect(
        result.hasToolCalls([
          { toolName: "batch", arguments: { ids: [1, 2] } },
        ]),
      ).toBe(false);
    });

    it("handles null values correctly", () => {
      const result = createQueryResult([
        { toolName: "test", arguments: { value: null } },
      ]);

      expect(
        result.hasToolCalls([{ toolName: "test", arguments: { value: null } }]),
      ).toBe(true);
    });
  });
});
