import {
  extractToolCalls,
  extractToolNames,
  GenerateTextResultLike,
} from "../src/tool-extraction";

describe("tool-extraction", () => {
  describe("extractToolCalls", () => {
    it("should extract tool calls from steps", () => {
      const result: GenerateTextResultLike = {
        text: "Done",
        steps: [
          {
            toolCalls: [
              { toolName: "add", args: { a: 1, b: 2 } },
              { toolName: "multiply", args: { x: 3, y: 4 } },
            ],
          },
        ],
      };

      const toolCalls = extractToolCalls(result);

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
            toolCalls: [{ toolName: "search", args: { query: "test" } }],
          },
          {
            toolCalls: [{ toolName: "read", args: { file: "data.txt" } }],
          },
          {
            toolCalls: [{ toolName: "write", args: { file: "out.txt" } }],
          },
        ],
      };

      const toolCalls = extractToolCalls(result);

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
        toolCalls: [{ toolName: "echo", args: { message: "hello" } }],
      };

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolName).toBe("echo");
    });

    it("should prefer steps over top-level toolCalls", () => {
      const result: GenerateTextResultLike = {
        text: "Done",
        steps: [
          {
            toolCalls: [{ toolName: "fromSteps", args: {} }],
          },
        ],
        toolCalls: [{ toolName: "fromTopLevel", args: {} }],
      };

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolName).toBe("fromSteps");
    });

    it("should return empty array when no tool calls", () => {
      const result: GenerateTextResultLike = {
        text: "Just text response",
      };

      const toolCalls = extractToolCalls(result);

      expect(toolCalls).toEqual([]);
    });

    it("should handle steps with no toolCalls", () => {
      const result: GenerateTextResultLike = {
        text: "Done",
        steps: [
          { toolCalls: undefined },
          { toolCalls: [{ toolName: "test", args: {} }] },
          {},
        ],
      };

      const toolCalls = extractToolCalls(result);

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
                toolName: "noArgs",
                args: undefined as unknown as Record<string, unknown>,
              },
            ],
          },
        ],
      };

      const toolCalls = extractToolCalls(result);

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
              { toolName: "add", args: {} },
              { toolName: "subtract", args: {} },
              { toolName: "multiply", args: {} },
            ],
          },
        ],
      };

      const names = extractToolNames(result);

      expect(names).toEqual(["add", "subtract", "multiply"]);
    });

    it("should return empty array when no tools called", () => {
      const result: GenerateTextResultLike = {
        text: "No tools",
      };

      const names = extractToolNames(result);

      expect(names).toEqual([]);
    });

    it("should preserve order and duplicates", () => {
      const result: GenerateTextResultLike = {
        text: "Done",
        steps: [
          {
            toolCalls: [
              { toolName: "fetch", args: {} },
              { toolName: "process", args: {} },
              { toolName: "fetch", args: {} },
            ],
          },
        ],
      };

      const names = extractToolNames(result);

      expect(names).toEqual(["fetch", "process", "fetch"]);
    });
  });
});
