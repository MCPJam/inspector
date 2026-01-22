import {
  matchToolCalls,
  matchToolCallsSubset,
  matchAnyToolCall,
  matchToolCallCount,
  matchNoToolCalls,
  matchToolCallWithArgs,
  matchToolCallWithPartialArgs,
  matchToolArgument,
  matchToolArgumentWith,
} from "../src/validators";
import type { ToolCall } from "../src/types";

describe("validators", () => {
  describe("matchToolCalls", () => {
    it("should match exact order and content", () => {
      expect(matchToolCalls(["add", "multiply"], ["add", "multiply"])).toBe(
        true
      );
    });

    it("should fail on wrong order", () => {
      expect(matchToolCalls(["add", "multiply"], ["multiply", "add"])).toBe(
        false
      );
    });

    it("should fail on extra tools", () => {
      expect(matchToolCalls(["add"], ["add", "multiply"])).toBe(false);
    });

    it("should fail on missing tools", () => {
      expect(matchToolCalls(["add", "multiply"], ["add"])).toBe(false);
    });

    it("should match empty arrays", () => {
      expect(matchToolCalls([], [])).toBe(true);
    });

    it("should be case-sensitive", () => {
      expect(matchToolCalls(["Add"], ["add"])).toBe(false);
      expect(matchToolCalls(["ADD"], ["add"])).toBe(false);
    });

    it("should handle duplicate tool names", () => {
      expect(matchToolCalls(["add", "add"], ["add", "add"])).toBe(true);
      expect(matchToolCalls(["add", "add"], ["add"])).toBe(false);
    });
  });

  describe("matchToolCallsSubset", () => {
    it("should match when all expected are present", () => {
      expect(matchToolCallsSubset(["add"], ["add", "multiply"])).toBe(true);
    });

    it("should match regardless of order", () => {
      expect(
        matchToolCallsSubset(["multiply", "add"], ["add", "multiply"])
      ).toBe(true);
    });

    it("should match exact set", () => {
      expect(
        matchToolCallsSubset(["add", "multiply"], ["add", "multiply"])
      ).toBe(true);
    });

    it("should fail when expected tool is missing", () => {
      expect(
        matchToolCallsSubset(["add", "subtract"], ["add", "multiply"])
      ).toBe(false);
    });

    it("should match empty expected against any actual", () => {
      expect(matchToolCallsSubset([], ["add", "multiply"])).toBe(true);
      expect(matchToolCallsSubset([], [])).toBe(true);
    });

    it("should be case-sensitive", () => {
      expect(matchToolCallsSubset(["Add"], ["add"])).toBe(false);
    });

    it("should not require multiple occurrences", () => {
      // Even if expected has duplicate, only checks presence
      expect(matchToolCallsSubset(["add", "add"], ["add", "multiply"])).toBe(
        true
      );
    });
  });

  describe("matchAnyToolCall", () => {
    it("should match when at least one expected is present", () => {
      expect(matchAnyToolCall(["add", "subtract"], ["multiply", "add"])).toBe(
        true
      );
    });

    it("should fail when none of expected are present", () => {
      expect(
        matchAnyToolCall(["add", "subtract"], ["multiply", "divide"])
      ).toBe(false);
    });

    it("should fail with empty expected", () => {
      expect(matchAnyToolCall([], ["add"])).toBe(false);
    });

    it("should fail with empty actual when expected is non-empty", () => {
      expect(matchAnyToolCall(["add"], [])).toBe(false);
    });

    it("should be case-sensitive", () => {
      expect(matchAnyToolCall(["Add"], ["add"])).toBe(false);
    });

    it("should match on first found", () => {
      expect(matchAnyToolCall(["z", "a"], ["a", "b", "c"])).toBe(true);
    });
  });

  describe("matchToolCallCount", () => {
    it("should match exact count", () => {
      expect(matchToolCallCount("add", ["add", "add", "multiply"], 2)).toBe(
        true
      );
    });

    it("should fail on wrong count", () => {
      expect(matchToolCallCount("add", ["add", "multiply"], 2)).toBe(false);
    });

    it("should match zero occurrences", () => {
      expect(matchToolCallCount("subtract", ["add", "multiply"], 0)).toBe(true);
    });

    it("should be case-sensitive", () => {
      expect(matchToolCallCount("Add", ["add", "add"], 2)).toBe(false);
      expect(matchToolCallCount("Add", ["add", "add"], 0)).toBe(true);
    });

    it("should count single occurrence", () => {
      expect(matchToolCallCount("add", ["add", "multiply", "divide"], 1)).toBe(
        true
      );
    });
  });

  describe("matchNoToolCalls", () => {
    it("should return true for empty array", () => {
      expect(matchNoToolCalls([])).toBe(true);
    });

    it("should return false when tools were called", () => {
      expect(matchNoToolCalls(["add"])).toBe(false);
      expect(matchNoToolCalls(["add", "multiply"])).toBe(false);
    });
  });

  // === Argument-based validators (Phase 2.5) ===

  describe("matchToolCallWithArgs", () => {
    const toolCalls: ToolCall[] = [
      { toolName: "add", arguments: { a: 2, b: 3 } },
      { toolName: "multiply", arguments: { x: 5, y: 10 } },
    ];

    it("should return true for exact argument match", () => {
      expect(matchToolCallWithArgs("add", { a: 2, b: 3 }, toolCalls)).toBe(
        true
      );
    });

    it("should return false when extra args in actual", () => {
      expect(matchToolCallWithArgs("add", { a: 2 }, toolCalls)).toBe(false);
    });

    it("should return false when missing args in actual", () => {
      const partialCalls: ToolCall[] = [
        { toolName: "add", arguments: { a: 2 } },
      ];
      expect(matchToolCallWithArgs("add", { a: 2, b: 3 }, partialCalls)).toBe(
        false
      );
    });

    it("should return false when tool not found", () => {
      expect(matchToolCallWithArgs("subtract", { a: 2 }, toolCalls)).toBe(
        false
      );
    });

    it("should handle nested objects", () => {
      const nestedCalls: ToolCall[] = [
        {
          toolName: "config",
          arguments: { settings: { theme: "dark", size: 12 } },
        },
      ];
      expect(
        matchToolCallWithArgs(
          "config",
          { settings: { theme: "dark", size: 12 } },
          nestedCalls
        )
      ).toBe(true);
      expect(
        matchToolCallWithArgs(
          "config",
          { settings: { theme: "light", size: 12 } },
          nestedCalls
        )
      ).toBe(false);
    });

    it("should handle arrays", () => {
      const arrayCalls: ToolCall[] = [
        { toolName: "batch", arguments: { items: [1, 2, 3] } },
      ];
      expect(
        matchToolCallWithArgs("batch", { items: [1, 2, 3] }, arrayCalls)
      ).toBe(true);
      expect(
        matchToolCallWithArgs("batch", { items: [1, 2] }, arrayCalls)
      ).toBe(false);
      expect(
        matchToolCallWithArgs("batch", { items: [3, 2, 1] }, arrayCalls)
      ).toBe(false);
    });

    it("should be case-sensitive for tool names", () => {
      expect(matchToolCallWithArgs("Add", { a: 2, b: 3 }, toolCalls)).toBe(
        false
      );
    });

    it("should return false for empty tool calls", () => {
      expect(matchToolCallWithArgs("add", { a: 2 }, [])).toBe(false);
    });

    it("should match objects regardless of key order", () => {
      // LLMs often return JSON with keys in arbitrary order
      const calls: ToolCall[] = [{ toolName: "add", arguments: { b: 3, a: 2 } }];
      expect(matchToolCallWithArgs("add", { a: 2, b: 3 }, calls)).toBe(true);
      expect(matchToolCallWithArgs("add", { b: 3, a: 2 }, calls)).toBe(true);
    });

    it("should match nested objects regardless of key order", () => {
      const calls: ToolCall[] = [
        {
          toolName: "config",
          arguments: { settings: { size: 12, theme: "dark" }, name: "test" },
        },
      ];
      expect(
        matchToolCallWithArgs(
          "config",
          { name: "test", settings: { theme: "dark", size: 12 } },
          calls
        )
      ).toBe(true);
    });
  });

  describe("matchToolCallWithPartialArgs", () => {
    const toolCalls: ToolCall[] = [
      { toolName: "add", arguments: { a: 2, b: 3, c: 4 } },
      { toolName: "echo", arguments: { message: "hello" } },
    ];

    it("should return true when all expected args present", () => {
      expect(
        matchToolCallWithPartialArgs("add", { a: 2, b: 3 }, toolCalls)
      ).toBe(true);
    });

    it("should return true when actual has extra args", () => {
      expect(matchToolCallWithPartialArgs("add", { a: 2 }, toolCalls)).toBe(
        true
      );
    });

    it("should return false when expected arg missing", () => {
      expect(
        matchToolCallWithPartialArgs("add", { a: 2, d: 5 }, toolCalls)
      ).toBe(false);
    });

    it("should return false when arg value differs", () => {
      expect(matchToolCallWithPartialArgs("add", { a: 99 }, toolCalls)).toBe(
        false
      );
    });

    it("should return true for empty expected args", () => {
      expect(matchToolCallWithPartialArgs("add", {}, toolCalls)).toBe(true);
    });

    it("should be case-sensitive for tool names", () => {
      expect(matchToolCallWithPartialArgs("Add", { a: 2 }, toolCalls)).toBe(
        false
      );
    });

    it("should return false when tool not found", () => {
      expect(
        matchToolCallWithPartialArgs("subtract", { a: 2 }, toolCalls)
      ).toBe(false);
    });

    it("should handle nested objects in partial match", () => {
      const nestedCalls: ToolCall[] = [
        {
          toolName: "config",
          arguments: { settings: { theme: "dark" }, name: "test" },
        },
      ];
      expect(
        matchToolCallWithPartialArgs(
          "config",
          { settings: { theme: "dark" } },
          nestedCalls
        )
      ).toBe(true);
      expect(
        matchToolCallWithPartialArgs("config", { name: "test" }, nestedCalls)
      ).toBe(true);
    });
  });

  describe("matchToolArgument", () => {
    const toolCalls: ToolCall[] = [
      { toolName: "add", arguments: { a: 2, b: 3 } },
      { toolName: "add", arguments: { a: 10, b: 20 } },
      { toolName: "echo", arguments: { message: "hello" } },
    ];

    it("should return true when arg matches", () => {
      expect(matchToolArgument("add", "a", 2, toolCalls)).toBe(true);
    });

    it("should return false when arg value differs", () => {
      expect(matchToolArgument("add", "a", 99, toolCalls)).toBe(false);
    });

    it("should return false when arg key missing", () => {
      expect(matchToolArgument("add", "z", 2, toolCalls)).toBe(false);
    });

    it("should check all calls to the tool", () => {
      expect(matchToolArgument("add", "a", 10, toolCalls)).toBe(true);
      expect(matchToolArgument("add", "b", 20, toolCalls)).toBe(true);
    });

    it("should return false when tool not found", () => {
      expect(matchToolArgument("subtract", "a", 2, toolCalls)).toBe(false);
    });

    it("should be case-sensitive for tool names", () => {
      expect(matchToolArgument("Add", "a", 2, toolCalls)).toBe(false);
    });

    it("should handle string values", () => {
      expect(matchToolArgument("echo", "message", "hello", toolCalls)).toBe(
        true
      );
      expect(matchToolArgument("echo", "message", "world", toolCalls)).toBe(
        false
      );
    });
  });

  describe("matchToolArgumentWith", () => {
    const toolCalls: ToolCall[] = [
      { toolName: "add", arguments: { a: 5, b: 10 } },
      { toolName: "echo", arguments: { message: "hello world" } },
      { toolName: "config", arguments: { count: 100 } },
    ];

    it("should return true when predicate passes", () => {
      expect(matchToolArgumentWith("add", "a", (v) => v === 5, toolCalls)).toBe(
        true
      );
    });

    it("should return false when predicate fails", () => {
      expect(
        matchToolArgumentWith("add", "a", (v) => v === 99, toolCalls)
      ).toBe(false);
    });

    it("should handle type checking predicates", () => {
      expect(
        matchToolArgumentWith(
          "add",
          "a",
          (v) => typeof v === "number",
          toolCalls
        )
      ).toBe(true);
      expect(
        matchToolArgumentWith(
          "echo",
          "message",
          (v) => typeof v === "string",
          toolCalls
        )
      ).toBe(true);
      expect(
        matchToolArgumentWith(
          "add",
          "a",
          (v) => typeof v === "string",
          toolCalls
        )
      ).toBe(false);
    });

    it("should handle string pattern predicates", () => {
      expect(
        matchToolArgumentWith(
          "echo",
          "message",
          (v) => typeof v === "string" && v.includes("hello"),
          toolCalls
        )
      ).toBe(true);
      expect(
        matchToolArgumentWith(
          "echo",
          "message",
          (v) => typeof v === "string" && v.includes("goodbye"),
          toolCalls
        )
      ).toBe(false);
    });

    it("should handle range validation predicates", () => {
      expect(
        matchToolArgumentWith(
          "config",
          "count",
          (v) => typeof v === "number" && v > 50,
          toolCalls
        )
      ).toBe(true);
      expect(
        matchToolArgumentWith(
          "config",
          "count",
          (v) => typeof v === "number" && v < 50,
          toolCalls
        )
      ).toBe(false);
    });

    it("should return false when arg key missing", () => {
      expect(
        matchToolArgumentWith("add", "z", (v) => v !== undefined, toolCalls)
      ).toBe(false);
    });

    it("should return false when tool not found", () => {
      expect(
        matchToolArgumentWith("subtract", "a", (v) => true, toolCalls)
      ).toBe(false);
    });

    it("should be case-sensitive for tool names", () => {
      expect(matchToolArgumentWith("Add", "a", (v) => v === 5, toolCalls)).toBe(
        false
      );
    });
  });
});
