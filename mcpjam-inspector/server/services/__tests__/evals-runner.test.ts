import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GenerateTextResult } from "@/sdk/evals";

// Import extractToolCalls directly to test the integration
import { extractToolCalls } from "@/sdk/evals";

// Mock AI SDK
vi.mock("ai", () => ({
  generateText: vi.fn(),
  stepCountIs: vi.fn().mockReturnValue(() => false),
}));

// Mock chat-helpers
vi.mock("../../utils/chat-helpers", () => ({
  createLlmModel: vi.fn().mockReturnValue({}),
}));

// Mock logger
vi.mock("../../utils/logger", () => ({
  logger: {
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("evals-runner extractToolCalls integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("extractToolCalls from SDK", () => {
    it("extracts tool calls from generateText result steps", () => {
      // This simulates what generateText returns
      const result: GenerateTextResult = {
        steps: [
          {
            toolCalls: [
              { toolName: "create_task", args: { title: "My Task" } },
            ],
          },
          {
            toolCalls: [
              { toolName: "update_task", args: { id: "123", status: "done" } },
            ],
          },
        ],
      };

      const toolsCalled = extractToolCalls(result);

      expect(toolsCalled).toHaveLength(2);
      expect(toolsCalled[0]).toEqual({
        toolName: "create_task",
        arguments: { title: "My Task" },
      });
      expect(toolsCalled[1]).toEqual({
        toolName: "update_task",
        arguments: { id: "123", status: "done" },
      });
    });

    it("extracts tool calls from response messages", () => {
      const result: GenerateTextResult = {
        response: {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolName: "search_tasks",
                  input: { query: "urgent" },
                },
              ],
            },
          ],
        },
      };

      const toolsCalled = extractToolCalls(result);

      expect(toolsCalled).toHaveLength(1);
      expect(toolsCalled[0]).toEqual({
        toolName: "search_tasks",
        arguments: { query: "urgent" },
      });
    });

    it("handles multi-step agentic conversation correctly", () => {
      // This is the key scenario for evals - multi-turn tool calling
      const result: GenerateTextResult = {
        steps: [
          { toolCalls: [{ toolName: "list_projects", args: {} }] },
          { toolCalls: [{ toolName: "get_project", args: { id: "proj-1" } }] },
          {
            toolCalls: [
              {
                toolName: "create_task",
                args: { projectId: "proj-1", title: "New Task" },
              },
            ],
          },
        ],
        response: {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "tool-call", toolName: "list_projects", input: {} },
              ],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolName: "get_project",
                  input: { id: "proj-1" },
                },
              ],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolName: "create_task",
                  input: { projectId: "proj-1", title: "New Task" },
                },
              ],
            },
          ],
        },
      };

      const toolsCalled = extractToolCalls(result);

      // Should deduplicate - same tools in steps and messages
      expect(toolsCalled).toHaveLength(3);
      expect(toolsCalled.map((tc) => tc.toolName)).toEqual([
        "list_projects",
        "get_project",
        "create_task",
      ]);
    });

    it("handles empty result gracefully", () => {
      const result: GenerateTextResult = {};

      const toolsCalled = extractToolCalls(result);

      expect(toolsCalled).toEqual([]);
    });

    it("handles result with no tool calls", () => {
      const result: GenerateTextResult = {
        steps: [{ toolCalls: [] }],
        response: {
          messages: [{ role: "assistant", content: "Just a text response" }],
        },
      };

      const toolsCalled = extractToolCalls(result);

      expect(toolsCalled).toEqual([]);
    });

    it("handles alternative tool call formats (name/input)", () => {
      const result: GenerateTextResult = {
        steps: [
          {
            toolCalls: [{ name: "legacy_tool", input: { param: "value" } }],
          },
        ],
      };

      const toolsCalled = extractToolCalls(result);

      expect(toolsCalled).toHaveLength(1);
      expect(toolsCalled[0]).toEqual({
        toolName: "legacy_tool",
        arguments: { param: "value" },
      });
    });

    it("handles legacy toolCalls array on messages", () => {
      const result: GenerateTextResult = {
        response: {
          messages: [
            {
              role: "assistant",
              toolCalls: [{ toolName: "old_format_tool", args: { x: 1 } }],
            },
          ],
        },
      };

      const toolsCalled = extractToolCalls(result);

      expect(toolsCalled).toHaveLength(1);
      expect(toolsCalled[0]).toEqual({
        toolName: "old_format_tool",
        arguments: { x: 1 },
      });
    });

    it("preserves argument values exactly", () => {
      const complexArgs = {
        stringField: "test",
        numberField: 42,
        boolField: true,
        nullField: null,
        arrayField: [1, 2, 3],
        nestedObject: { a: { b: { c: "deep" } } },
      };

      const result: GenerateTextResult = {
        steps: [
          {
            toolCalls: [{ toolName: "complex_tool", args: complexArgs }],
          },
        ],
      };

      const toolsCalled = extractToolCalls(result);

      expect(toolsCalled[0].arguments).toEqual(complexArgs);
    });

    it("handles tools with no arguments", () => {
      const result: GenerateTextResult = {
        steps: [
          {
            toolCalls: [{ toolName: "no_args_tool" }],
          },
        ],
      };

      const toolsCalled = extractToolCalls(result);

      expect(toolsCalled[0]).toEqual({
        toolName: "no_args_tool",
        arguments: {},
      });
    });

    it("handles same tool called multiple times with different arguments", () => {
      const result: GenerateTextResult = {
        steps: [
          { toolCalls: [{ toolName: "add_item", args: { name: "Item 1" } }] },
          { toolCalls: [{ toolName: "add_item", args: { name: "Item 2" } }] },
          { toolCalls: [{ toolName: "add_item", args: { name: "Item 3" } }] },
        ],
      };

      const toolsCalled = extractToolCalls(result);

      expect(toolsCalled).toHaveLength(3);
      expect(toolsCalled.every((tc) => tc.toolName === "add_item")).toBe(true);
      expect(toolsCalled.map((tc) => tc.arguments.name)).toEqual([
        "Item 1",
        "Item 2",
        "Item 3",
      ]);
    });
  });

  describe("tool call format compatibility", () => {
    it("handles content array with parameters format", () => {
      const result: GenerateTextResult = {
        response: {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  name: "tool_with_parameters",
                  parameters: { foo: "bar" },
                },
              ],
            },
          ],
        },
      };

      const toolsCalled = extractToolCalls(result);

      expect(toolsCalled[0]).toEqual({
        toolName: "tool_with_parameters",
        arguments: { foo: "bar" },
      });
    });

    it("handles content array with args format", () => {
      const result: GenerateTextResult = {
        response: {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolName: "tool_with_args",
                  args: { baz: "qux" },
                },
              ],
            },
          ],
        },
      };

      const toolsCalled = extractToolCalls(result);

      expect(toolsCalled[0]).toEqual({
        toolName: "tool_with_args",
        arguments: { baz: "qux" },
      });
    });

    it("ignores non-assistant messages", () => {
      const result: GenerateTextResult = {
        response: {
          messages: [
            {
              role: "user",
              content: [
                { type: "tool-call", toolName: "user_tool", input: {} },
              ],
            },
            {
              role: "system",
              content: [
                { type: "tool-call", toolName: "system_tool", input: {} },
              ],
            },
            {
              role: "assistant",
              content: [
                { type: "tool-call", toolName: "assistant_tool", input: {} },
              ],
            },
          ],
        },
      };

      const toolsCalled = extractToolCalls(result);

      // Only assistant tool calls should be extracted
      expect(toolsCalled).toHaveLength(1);
      expect(toolsCalled[0].toolName).toBe("assistant_tool");
    });
  });

  describe("deduplication behavior", () => {
    it("deduplicates identical tool calls from steps and messages", () => {
      const result: GenerateTextResult = {
        steps: [
          { toolCalls: [{ toolName: "duplicate_tool", args: { x: 1 } }] },
        ],
        response: {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolName: "duplicate_tool",
                  input: { x: 1 },
                },
              ],
            },
          ],
        },
      };

      const toolsCalled = extractToolCalls(result);

      expect(toolsCalled).toHaveLength(1);
    });

    it("keeps tool calls with same name but different arguments", () => {
      const result: GenerateTextResult = {
        steps: [
          { toolCalls: [{ toolName: "same_tool", args: { version: 1 } }] },
        ],
        response: {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolName: "same_tool",
                  input: { version: 2 },
                },
              ],
            },
          ],
        },
      };

      const toolsCalled = extractToolCalls(result);

      expect(toolsCalled).toHaveLength(2);
    });
  });
});
