import { GenerateTextResult, ToolSet } from "ai";
import { extractToolCalls, extractToolNames } from "../src/tool-extraction";

// Minimal type for testing - only includes what extractToolCalls actually uses
type GenerateTextResultLike = {
  text?: string;
  steps?: Array<{
    toolCalls?: Array<{
      toolName: string;
      input?: Record<string, unknown>;
      type?: string;
      toolCallId?: string;
    }>;
  }>;
  toolCalls?: Array<{
    toolName: string;
    input?: Record<string, unknown>;
    type?: string;
    toolCallId?: string;
  }>;
};

describe("tool-extraction", () => {
  describe("extractToolCalls", () => {
    it("should extract tool calls from steps", () => {
      const result = {
        text: "Done",
        steps: [
          {
            toolCalls: [
              {
                type: "tool-call",
                toolCallId: "1",
                toolName: "add",
                input: { a: 1, b: 2 },
              },
              {
                type: "tool-call",
                toolCallId: "2",
                toolName: "multiply",
                input: { x: 3, y: 4 },
              },
            ],
          },
        ],
      } as GenerateTextResult<ToolSet, never>;

      const toolCalls = extractToolCalls(
        result as GenerateTextResult<ToolSet, never>
      );

      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0]).toEqual({
        toolName: "add",
        arguments: { a: 1, b: 2 },
      });
      expect(toolCalls[1]).toEqual({
        toolName: "multiply",
        arguments: { x: 3, y: 4 },
      });
    });

    it("should extract tool calls from multiple steps", () => {
      const result: GenerateTextResultLike = {
        text: "Done",
        steps: [
          {
            toolCalls: [
              {
                type: "tool-call",
                toolCallId: "1",
                toolName: "search",
                input: { query: "test" },
              },
            ],
          },
          {
            toolCalls: [
              {
                type: "tool-call",
                toolCallId: "2",
                toolName: "read",
                input: { file: "data.txt" },
              },
            ],
          },
          {
            toolCalls: [
              {
                type: "tool-call",
                toolCallId: "3",
                toolName: "write",
                input: { file: "out.txt" },
              },
            ],
          },
        ],
      };

      const toolCalls = extractToolCalls(
        result as GenerateTextResult<ToolSet, never>
      );

      expect(toolCalls).toHaveLength(3);
      expect(toolCalls.map((tc) => tc.toolName)).toEqual([
        "search",
        "read",
        "write",
      ]);
    });

    it("should extract from top-level toolCalls when no steps", () => {
      const result: GenerateTextResultLike = {
        text: "Done",
        toolCalls: [
          {
            type: "tool-call",
            toolCallId: "1",
            toolName: "echo",
            input: { message: "hello" },
          },
        ],
      };

      const toolCalls = extractToolCalls(
        result as GenerateTextResult<ToolSet, never>
      );

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolName).toBe("echo");
    });

    it("should prefer steps over top-level toolCalls", () => {
      const result: GenerateTextResultLike = {
        text: "Done",
        steps: [
          {
            toolCalls: [
              {
                type: "tool-call",
                toolCallId: "1",
                toolName: "fromSteps",
                input: {},
              },
            ],
          },
        ],
        toolCalls: [
          {
            type: "tool-call",
            toolCallId: "2",
            toolName: "fromTopLevel",
            input: {},
          },
        ],
      };

      const toolCalls = extractToolCalls(
        result as GenerateTextResult<ToolSet, never>
      );

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolName).toBe("fromSteps");
    });

    it("should return empty array when no tool calls", () => {
      const result: GenerateTextResultLike = {
        text: "Just text response",
      };

      const toolCalls = extractToolCalls(
        result as GenerateTextResult<ToolSet, never>
      );

      expect(toolCalls).toEqual([]);
    });

    it("should handle steps with no toolCalls", () => {
      const result: GenerateTextResultLike = {
        text: "Done",
        steps: [
          { toolCalls: undefined },
          {
            toolCalls: [
              {
                type: "tool-call",
                toolCallId: "1",
                toolName: "test",
                input: {},
              },
            ],
          },
          {},
        ],
      };

      const toolCalls = extractToolCalls(
        result as GenerateTextResult<ToolSet, never>
      );

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolName).toBe("test");
    });

    it("should handle undefined args", () => {
      const result: GenerateTextResultLike = {
        text: "Done",
        steps: [
          {
            toolCalls: [
              {
                type: "tool-call",
                toolCallId: "1",
                toolName: "noArgs",
                input: undefined as unknown as Record<string, unknown>,
              },
            ],
          },
        ],
      };

      const toolCalls = extractToolCalls(
        result as GenerateTextResult<ToolSet, never>
      );

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].arguments).toEqual({});
    });
  });

  describe("extractToolNames", () => {
    it("should return array of tool names", () => {
      const result: GenerateTextResultLike = {
        text: "Done",
        steps: [
          {
            toolCalls: [
              {
                type: "tool-call",
                toolCallId: "1",
                toolName: "add",
                input: {},
              },
              {
                type: "tool-call",
                toolCallId: "2",
                toolName: "subtract",
                input: {},
              },
              {
                type: "tool-call",
                toolCallId: "3",
                toolName: "multiply",
                input: {},
              },
            ],
          },
        ],
      };

      const names = extractToolNames(
        result as GenerateTextResult<ToolSet, never>
      );

      expect(names).toEqual(["add", "subtract", "multiply"]);
    });

    it("should return empty array when no tools called", () => {
      const result: GenerateTextResultLike = {
        text: "No tools",
      };

      const names = extractToolNames(
        result as GenerateTextResult<ToolSet, never>
      );

      expect(names).toEqual([]);
    });

    it("should preserve order and duplicates", () => {
      const result = {
        steps: [
          {
            toolCalls: [
              {
                type: "tool-call",
                toolCallId: "1",
                toolName: "fetch",
                input: {},
              },
              {
                type: "tool-call",
                toolCallId: "2",
                toolName: "process",
                input: {},
              },
              {
                type: "tool-call",
                toolCallId: "3",
                toolName: "fetch",
                input: {},
              },
            ],
          },
        ],
      } as GenerateTextResult<ToolSet, never>;

      const names = extractToolNames(
        result as GenerateTextResult<ToolSet, never>
      );

      expect(names).toEqual(["fetch", "process", "fetch"]);
    });
  });
});
