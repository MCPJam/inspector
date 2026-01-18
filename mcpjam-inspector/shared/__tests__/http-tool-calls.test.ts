import { describe, it, expect, vi } from "vitest";
import {
  hasUnresolvedToolCalls,
  executeToolCallsFromMessages,
} from "../http-tool-calls.js";
import type { ModelMessage } from "@ai-sdk/provider-utils";

describe("hasUnresolvedToolCalls", () => {
  describe("empty/basic cases", () => {
    it("returns false for empty messages array", () => {
      expect(hasUnresolvedToolCalls([])).toBe(false);
    });

    it("returns false for user messages only", () => {
      const messages: ModelMessage[] = [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ];
      expect(hasUnresolvedToolCalls(messages)).toBe(false);
    });

    it("returns false for assistant text messages only", () => {
      const messages: ModelMessage[] = [
        { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
      ];
      expect(hasUnresolvedToolCalls(messages)).toBe(false);
    });
  });

  describe("tool call detection", () => {
    it("returns true when tool call has no result", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "read_file",
              args: { path: "/test.txt" },
            },
          ],
        },
      ] as unknown as ModelMessage[];

      expect(hasUnresolvedToolCalls(messages)).toBe(true);
    });

    it("returns false when tool call has matching result", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "read_file",
              args: { path: "/test.txt" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              result: "file content",
            },
          ],
        },
      ] as unknown as ModelMessage[];

      expect(hasUnresolvedToolCalls(messages)).toBe(false);
    });

    it("returns true when one of multiple tool calls is unresolved", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "read_file",
              args: {},
            },
            {
              type: "tool-call",
              toolCallId: "call-2",
              toolName: "write_file",
              args: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              result: "done",
            },
          ],
        },
      ] as unknown as ModelMessage[];

      expect(hasUnresolvedToolCalls(messages)).toBe(true);
    });

    it("returns false when all multiple tool calls are resolved", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "tool_a",
              args: {},
            },
            {
              type: "tool-call",
              toolCallId: "call-2",
              toolName: "tool_b",
              args: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "call-1", result: "a" },
            { type: "tool-result", toolCallId: "call-2", result: "b" },
          ],
        },
      ] as unknown as ModelMessage[];

      expect(hasUnresolvedToolCalls(messages)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles null messages in array", () => {
      const messages = [null, undefined] as unknown as ModelMessage[];
      expect(hasUnresolvedToolCalls(messages)).toBe(false);
    });

    it("handles messages with non-array content", () => {
      const messages = [
        { role: "assistant", content: "just text" },
      ] as unknown as ModelMessage[];
      expect(hasUnresolvedToolCalls(messages)).toBe(false);
    });

    it("handles tool results arriving before tool calls (order independent)", () => {
      const messages = [
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "call-1", result: "done" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "call-1", toolName: "test" },
          ],
        },
      ] as unknown as ModelMessage[];

      expect(hasUnresolvedToolCalls(messages)).toBe(false);
    });
  });
});

describe("executeToolCallsFromMessages", () => {
  describe("with tools option", () => {
    it("executes tool calls and appends results to messages", async () => {
      const mockExecute = vi.fn().mockResolvedValue({ result: "success" });
      const tools = {
        my_tool: {
          execute: mockExecute,
          description: "A test tool",
        },
      };

      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-123",
              toolName: "my_tool",
              input: { param: "value" },
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await executeToolCallsFromMessages(messages, { tools });

      expect(mockExecute).toHaveBeenCalledWith({ param: "value" });
      expect(messages).toHaveLength(2);
      expect(messages[1].role).toBe("tool");
      expect((messages[1] as any).content[0].type).toBe("tool-result");
      expect((messages[1] as any).content[0].toolCallId).toBe("call-123");
    });

    it("handles tool execution errors", async () => {
      const mockExecute = vi.fn().mockRejectedValue(new Error("Tool failed"));
      const tools = {
        failing_tool: {
          execute: mockExecute,
        },
      };

      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-456",
              toolName: "failing_tool",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await executeToolCallsFromMessages(messages, { tools });

      expect(messages).toHaveLength(2);
      expect((messages[1] as any).content[0].output.type).toBe("error-text");
      expect((messages[1] as any).content[0].output.value).toBe("Tool failed");
    });

    it("skips already resolved tool calls", async () => {
      const mockExecute = vi.fn().mockResolvedValue({ result: "done" });
      const tools = {
        my_tool: { execute: mockExecute },
      };

      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-already-done",
              toolName: "my_tool",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-already-done",
              result: "previously resolved",
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await executeToolCallsFromMessages(messages, { tools });

      expect(mockExecute).not.toHaveBeenCalled();
      expect(messages).toHaveLength(2); // No new messages added
    });

    it("throws error for tool not found", async () => {
      const tools = {};

      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-unknown",
              toolName: "unknown_tool",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await executeToolCallsFromMessages(messages, { tools });

      // Error is captured as tool-result with error output
      expect(messages).toHaveLength(2);
      expect((messages[1] as any).content[0].output.type).toBe("error-text");
      expect((messages[1] as any).content[0].output.value).toContain(
        "Tool 'unknown_tool' not found"
      );
    });
  });

  describe("tool alias resolution", () => {
    it("resolves tool by removing server prefix", async () => {
      const mockExecute = vi.fn().mockResolvedValue({ data: "ok" });
      const tools = {
        server1_read_file: {
          execute: mockExecute,
        },
      };

      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-prefixed",
              toolName: "server1_read_file",
              input: { path: "/file.txt" },
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await executeToolCallsFromMessages(messages, { tools });

      expect(mockExecute).toHaveBeenCalledWith({ path: "/file.txt" });
    });
  });

  describe("result serialization", () => {
    it("handles string results", async () => {
      const tools = {
        string_tool: {
          execute: vi.fn().mockResolvedValue("simple string"),
        },
      };

      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-string",
              toolName: "string_tool",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await executeToolCallsFromMessages(messages, { tools });

      expect((messages[1] as any).content[0].output).toEqual({
        type: "text",
        value: "simple string",
      });
    });

    it("handles null results", async () => {
      const tools = {
        null_tool: {
          execute: vi.fn().mockResolvedValue(null),
        },
      };

      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-null",
              toolName: "null_tool",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await executeToolCallsFromMessages(messages, { tools });

      expect((messages[1] as any).content[0].output).toEqual({
        type: "json",
        value: null,
      });
    });

    it("handles undefined results", async () => {
      const tools = {
        void_tool: {
          execute: vi.fn().mockResolvedValue(undefined),
        },
      };

      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-void",
              toolName: "void_tool",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await executeToolCallsFromMessages(messages, { tools });

      expect((messages[1] as any).content[0].output).toEqual({
        type: "json",
        value: null,
      });
    });

    it("handles object results as JSON", async () => {
      const tools = {
        json_tool: {
          execute: vi.fn().mockResolvedValue({ foo: "bar", count: 42 }),
        },
      };

      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-json",
              toolName: "json_tool",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await executeToolCallsFromMessages(messages, { tools });

      expect((messages[1] as any).content[0].output).toEqual({
        type: "json",
        value: { foo: "bar", count: 42 },
      });
    });

    it("handles bigint in results by converting to string", async () => {
      const tools = {
        bigint_tool: {
          execute: vi.fn().mockResolvedValue({ big: BigInt(12345678901234567890n) }),
        },
      };

      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-bigint",
              toolName: "bigint_tool",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await executeToolCallsFromMessages(messages, { tools });

      expect((messages[1] as any).content[0].output.type).toBe("json");
      expect((messages[1] as any).content[0].output.value.big).toBe(
        "12345678901234567890"
      );
    });
  });

  describe("multiple tool calls", () => {
    it("executes multiple tool calls in sequence", async () => {
      const executionOrder: string[] = [];
      const tools = {
        tool_a: {
          execute: vi.fn().mockImplementation(async () => {
            executionOrder.push("a");
            return "a result";
          }),
        },
        tool_b: {
          execute: vi.fn().mockImplementation(async () => {
            executionOrder.push("b");
            return "b result";
          }),
        },
      };

      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-a",
              toolName: "tool_a",
              input: {},
            },
            {
              type: "tool-call",
              toolCallId: "call-b",
              toolName: "tool_b",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await executeToolCallsFromMessages(messages, { tools });

      expect(executionOrder).toEqual(["a", "b"]);
      expect(messages).toHaveLength(3);
    });
  });
});
