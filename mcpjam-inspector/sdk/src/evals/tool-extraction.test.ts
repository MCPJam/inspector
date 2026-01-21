import { describe, it, expect } from "vitest";
import {
  extractToolCalls,
  extractToolNames,
  extractUniqueToolNames,
  type GenerateTextResult,
} from "./tool-extraction.js";

describe("extractToolCalls", () => {
  describe("extracting from steps", () => {
    it("extracts tool calls from steps with toolName and args", () => {
      const result: GenerateTextResult = {
        steps: [
          {
            toolCalls: [
              { toolName: "create_task", args: { title: "My Task" } },
              { toolName: "update_task", args: { id: "123", status: "done" } },
            ],
          },
        ],
      };

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toEqual([
        { toolName: "create_task", arguments: { title: "My Task" } },
        { toolName: "update_task", arguments: { id: "123", status: "done" } },
      ]);
    });

    it("extracts tool calls from steps with name and input (alternative format)", () => {
      const result: GenerateTextResult = {
        steps: [
          {
            toolCalls: [{ name: "search_tasks", input: { query: "bug" } }],
          },
        ],
      };

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toEqual([
        { toolName: "search_tasks", arguments: { query: "bug" } },
      ]);
    });

    it("extracts tool calls from multiple steps", () => {
      const result: GenerateTextResult = {
        steps: [
          { toolCalls: [{ toolName: "tool_a", args: {} }] },
          { toolCalls: [{ toolName: "tool_b", args: { x: 1 } }] },
          { toolCalls: [{ toolName: "tool_c", args: { y: 2 } }] },
        ],
      };

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toHaveLength(3);
      expect(toolCalls.map((tc) => tc.toolName)).toEqual([
        "tool_a",
        "tool_b",
        "tool_c",
      ]);
    });

    it("handles steps with no toolCalls", () => {
      const result: GenerateTextResult = {
        steps: [{ toolCalls: [] }, { toolCalls: undefined }],
      };

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toEqual([]);
    });

    it("handles empty steps array", () => {
      const result: GenerateTextResult = {
        steps: [],
      };

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toEqual([]);
    });

    it("handles missing steps", () => {
      const result: GenerateTextResult = {};

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toEqual([]);
    });

    it("defaults to empty object for missing args/input", () => {
      const result: GenerateTextResult = {
        steps: [
          {
            toolCalls: [{ toolName: "no_args_tool" }],
          },
        ],
      };

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toEqual([{ toolName: "no_args_tool", arguments: {} }]);
    });
  });

  describe("extracting from messages", () => {
    it("extracts from content array with type: tool-call", () => {
      const result: GenerateTextResult = {
        response: {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolName: "get_user",
                  input: { id: "user-1" },
                },
              ],
            },
          ],
        },
      };

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toEqual([
        { toolName: "get_user", arguments: { id: "user-1" } },
      ]);
    });

    it("extracts from content with name and parameters format", () => {
      const result: GenerateTextResult = {
        response: {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  name: "delete_item",
                  parameters: { itemId: "123" },
                },
              ],
            },
          ],
        },
      };

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toEqual([
        { toolName: "delete_item", arguments: { itemId: "123" } },
      ]);
    });

    it("extracts from legacy toolCalls array on message", () => {
      const result: GenerateTextResult = {
        response: {
          messages: [
            {
              role: "assistant",
              toolCalls: [
                { toolName: "legacy_tool", args: { param: "value" } },
              ],
            },
          ],
        },
      };

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toEqual([
        { toolName: "legacy_tool", arguments: { param: "value" } },
      ]);
    });

    it("ignores user messages", () => {
      const result: GenerateTextResult = {
        response: {
          messages: [
            {
              role: "user",
              content: [
                { type: "tool-call", toolName: "should_be_ignored", input: {} },
              ],
            },
          ],
        },
      };

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toEqual([]);
    });

    it("ignores system messages", () => {
      const result: GenerateTextResult = {
        response: {
          messages: [
            {
              role: "system",
              toolCalls: [{ toolName: "should_be_ignored", args: {} }],
            },
          ],
        },
      };

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toEqual([]);
    });
  });

  describe("deduplication", () => {
    it("does not duplicate tool calls found in both steps and messages", () => {
      const result: GenerateTextResult = {
        steps: [
          { toolCalls: [{ toolName: "shared_tool", args: { key: "value" } }] },
        ],
        response: {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolName: "shared_tool",
                  input: { key: "value" },
                },
              ],
            },
          ],
        },
      };

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toEqual({
        toolName: "shared_tool",
        arguments: { key: "value" },
      });
    });

    it("includes tool calls with same name but different arguments", () => {
      const result: GenerateTextResult = {
        steps: [{ toolCalls: [{ toolName: "repeat_tool", args: { x: 1 } }] }],
        response: {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "tool-call", toolName: "repeat_tool", input: { x: 2 } },
              ],
            },
          ],
        },
      };

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toHaveLength(2);
      expect(toolCalls).toEqual([
        { toolName: "repeat_tool", arguments: { x: 1 } },
        { toolName: "repeat_tool", arguments: { x: 2 } },
      ]);
    });

    it("does not duplicate from content and legacy toolCalls on same message", () => {
      const result: GenerateTextResult = {
        response: {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "tool-call", toolName: "dup_tool", input: { a: 1 } },
              ],
              toolCalls: [{ toolName: "dup_tool", args: { a: 1 } }],
            },
          ],
        },
      };

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toEqual({
        toolName: "dup_tool",
        arguments: { a: 1 },
      });
    });
  });

  describe("complex scenarios", () => {
    it("extracts from multi-step agentic conversation", () => {
      const result: GenerateTextResult = {
        steps: [
          { toolCalls: [{ toolName: "search", args: { query: "tasks" } }] },
          { toolCalls: [{ toolName: "get_task", args: { id: "1" } }] },
          {
            toolCalls: [
              { toolName: "update_task", args: { id: "1", status: "done" } },
            ],
          },
        ],
        response: {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolName: "search",
                  input: { query: "tasks" },
                },
              ],
            },
            {
              role: "assistant",
              content: [
                { type: "tool-call", toolName: "get_task", input: { id: "1" } },
              ],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolName: "update_task",
                  input: { id: "1", status: "done" },
                },
              ],
            },
          ],
        },
      };

      const toolCalls = extractToolCalls(result);

      // Should extract 3 unique tool calls, not 6
      expect(toolCalls).toHaveLength(3);
      expect(toolCalls.map((tc) => tc.toolName)).toEqual([
        "search",
        "get_task",
        "update_task",
      ]);
    });

    it("handles messages passed directly as second argument", () => {
      const result: GenerateTextResult = {
        steps: [{ toolCalls: [{ toolName: "from_steps", args: {} }] }],
      };
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "from_messages",
              input: { extra: true },
            },
          ],
        },
      ];

      const toolCalls = extractToolCalls(result, messages);

      expect(toolCalls).toHaveLength(2);
      expect(toolCalls.map((tc) => tc.toolName)).toEqual([
        "from_steps",
        "from_messages",
      ]);
    });
  });
});

describe("extractToolNames", () => {
  it("returns array of tool names", () => {
    const result: GenerateTextResult = {
      steps: [
        { toolCalls: [{ toolName: "tool_a", args: {} }] },
        { toolCalls: [{ toolName: "tool_b", args: {} }] },
        { toolCalls: [{ toolName: "tool_a", args: {} }] },
      ],
    };

    const names = extractToolNames(result);

    expect(names).toEqual(["tool_a", "tool_b", "tool_a"]);
  });

  it("returns empty array when no tool calls", () => {
    const result: GenerateTextResult = {};

    const names = extractToolNames(result);

    expect(names).toEqual([]);
  });
});

describe("extractUniqueToolNames", () => {
  it("returns unique tool names only", () => {
    const result: GenerateTextResult = {
      steps: [
        { toolCalls: [{ toolName: "tool_a", args: {} }] },
        { toolCalls: [{ toolName: "tool_b", args: {} }] },
        { toolCalls: [{ toolName: "tool_a", args: {} }] },
        { toolCalls: [{ toolName: "tool_c", args: {} }] },
        { toolCalls: [{ toolName: "tool_b", args: {} }] },
      ],
    };

    const names = extractUniqueToolNames(result);

    expect(names).toEqual(["tool_a", "tool_b", "tool_c"]);
  });

  it("returns empty array when no tool calls", () => {
    const result: GenerateTextResult = {};

    const names = extractUniqueToolNames(result);

    expect(names).toEqual([]);
  });
});
