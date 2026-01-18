import { describe, it, expect } from "vitest";
import {
  argumentsMatch,
  matchToolCalls,
  type ToolCall,
} from "../eval-matching.js";

describe("argumentsMatch", () => {
  it("returns true for empty expected args", () => {
    expect(argumentsMatch({}, { foo: "bar" })).toBe(true);
  });

  it("returns true when all expected keys match", () => {
    expect(
      argumentsMatch(
        { name: "test", value: 123 },
        { name: "test", value: 123, extra: "ignored" }
      )
    ).toBe(true);
  });

  it("returns false when a key value differs", () => {
    expect(argumentsMatch({ name: "test" }, { name: "different" })).toBe(false);
  });

  it("returns false when expected key is missing from actual", () => {
    expect(argumentsMatch({ name: "test" }, {})).toBe(false);
  });

  it("handles nested objects", () => {
    expect(
      argumentsMatch(
        { config: { nested: true } },
        { config: { nested: true } }
      )
    ).toBe(true);

    expect(
      argumentsMatch(
        { config: { nested: true } },
        { config: { nested: false } }
      )
    ).toBe(false);
  });

  it("handles arrays", () => {
    expect(argumentsMatch({ items: [1, 2, 3] }, { items: [1, 2, 3] })).toBe(
      true
    );

    expect(argumentsMatch({ items: [1, 2, 3] }, { items: [1, 2] })).toBe(false);
  });

  it("handles null and undefined", () => {
    expect(argumentsMatch({ value: null }, { value: null })).toBe(true);
    expect(argumentsMatch({ value: null }, { value: undefined })).toBe(false);
  });
});

describe("matchToolCalls", () => {
  describe("negative tests (isNegativeTest=true)", () => {
    it("passes when no tools are called", () => {
      const result = matchToolCalls([], [], true);
      expect(result.passed).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.unexpected).toEqual([]);
      expect(result.argumentMismatches).toEqual([]);
    });

    it("fails when tools are called", () => {
      const actual: ToolCall[] = [{ toolName: "read_file", arguments: {} }];
      const result = matchToolCalls([], actual, true);
      expect(result.passed).toBe(false);
      expect(result.unexpected).toEqual(actual);
    });
  });

  describe("positive tests (default)", () => {
    it("fails when no tools are called but some expected", () => {
      const expected: ToolCall[] = [{ toolName: "read_file", arguments: {} }];
      const result = matchToolCalls(expected, []);
      expect(result.passed).toBe(false);
      expect(result.missing).toEqual(expected);
    });

    it("passes with exact tool match and matching arguments", () => {
      const expected: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/test.txt" } },
      ];
      const actual: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/test.txt" } },
      ];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.unexpected).toEqual([]);
      expect(result.argumentMismatches).toEqual([]);
    });

    it("passes when expected has empty args (matches any)", () => {
      const expected: ToolCall[] = [{ toolName: "read_file", arguments: {} }];
      const actual: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/anything.txt" } },
      ];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(true);
    });

    it("passes when actual has extra args beyond expected", () => {
      const expected: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/test.txt" } },
      ];
      const actual: ToolCall[] = [
        {
          toolName: "read_file",
          arguments: { path: "/test.txt", extra: "value" },
        },
      ];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(true);
    });

    it("reports missing tool calls", () => {
      const expected: ToolCall[] = [
        { toolName: "read_file", arguments: {} },
        { toolName: "write_file", arguments: {} },
      ];
      const actual: ToolCall[] = [{ toolName: "read_file", arguments: {} }];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(false);
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0].toolName).toBe("write_file");
    });

    it("reports unexpected tool calls", () => {
      const expected: ToolCall[] = [{ toolName: "read_file", arguments: {} }];
      const actual: ToolCall[] = [
        { toolName: "read_file", arguments: {} },
        { toolName: "delete_file", arguments: {} },
      ];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(true); // unexpected doesn't fail the test
      expect(result.unexpected).toHaveLength(1);
      expect(result.unexpected[0].toolName).toBe("delete_file");
    });

    it("reports argument mismatches", () => {
      const expected: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/expected.txt" } },
      ];
      const actual: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/actual.txt" } },
      ];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(false);
      expect(result.argumentMismatches).toHaveLength(1);
      expect(result.argumentMismatches[0]).toEqual({
        toolName: "read_file",
        expectedArgs: { path: "/expected.txt" },
        actualArgs: { path: "/actual.txt" },
      });
    });

    it("handles multiple tool calls with some matching", () => {
      const expected: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/a.txt" } },
        { toolName: "write_file", arguments: { path: "/b.txt" } },
      ];
      const actual: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/a.txt" } },
        { toolName: "write_file", arguments: { path: "/c.txt" } }, // wrong path
      ];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(false);
      expect(result.missing).toEqual([]);
      expect(result.argumentMismatches).toHaveLength(1);
      expect(result.argumentMismatches[0].toolName).toBe("write_file");
    });

    it("handles duplicate tool names with different args", () => {
      const expected: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/first.txt" } },
        { toolName: "read_file", arguments: { path: "/second.txt" } },
      ];
      const actual: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/first.txt" } },
        { toolName: "read_file", arguments: { path: "/second.txt" } },
      ];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(true);
    });

    it("handles null/undefined inputs gracefully", () => {
      // @ts-expect-error - testing runtime behavior
      const result1 = matchToolCalls(null, []);
      expect(result1.passed).toBe(false);
      expect(result1.missing).toEqual([]);

      // @ts-expect-error - testing runtime behavior
      const result2 = matchToolCalls([], null);
      expect(result2.passed).toBe(false);
    });

    it("matches tools regardless of order", () => {
      const expected: ToolCall[] = [
        { toolName: "tool_a", arguments: {} },
        { toolName: "tool_b", arguments: {} },
      ];
      const actual: ToolCall[] = [
        { toolName: "tool_b", arguments: {} },
        { toolName: "tool_a", arguments: {} },
      ];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(true);
    });
  });
});
