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
    it("executes tool calls and inserts results after assistant message", async () => {
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

      const newMessages = await executeToolCallsFromMessages(messages, {
        tools,
      });

      expect(mockExecute).toHaveBeenCalledWith(
        { param: "value" },
        expect.objectContaining({
          toolCallId: "call-123",
          messages,
        }),
      );
      expect(messages).toHaveLength(2);
      expect(messages[1].role).toBe("tool");
      expect((messages[1] as any).content[0].type).toBe("tool-result");
      expect((messages[1] as any).content[0].toolCallId).toBe("call-123");
      // Return value contains the newly created messages
      expect(newMessages).toHaveLength(1);
      expect(newMessages[0].role).toBe("tool");
      expect((newMessages[0] as any).content[0].toolCallId).toBe("call-123");
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
        "Tool 'unknown_tool' not found",
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

      expect(mockExecute).toHaveBeenCalledWith(
        { path: "/file.txt" },
        expect.objectContaining({
          toolCallId: "call-prefixed",
          messages,
        }),
      );
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
          execute: vi
            .fn()
            .mockResolvedValue({ big: BigInt(12345678901234567890n) }),
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
        "12345678901234567890",
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

  describe("tool result ordering", () => {
    it("inserts results after correct assistant message when user message is in between", async () => {
      const tools = {
        my_tool: {
          execute: vi.fn().mockResolvedValue({ done: true }),
        },
      };

      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "my_tool",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "text", text: "I approve" }],
        },
      ] as unknown as ModelMessage[];

      await executeToolCallsFromMessages(messages, { tools });

      // Result should be at index 1 (right after assistant), NOT at the end
      expect(messages).toHaveLength(3);
      expect(messages[0].role).toBe("assistant");
      expect(messages[1].role).toBe("tool");
      expect((messages[1] as any).content[0].toolCallId).toBe("call-1");
      expect(messages[2].role).toBe("user");
    });

    it("inserts results after each corresponding assistant message with multiple assistants", async () => {
      const tools = {
        tool_a: {
          execute: vi.fn().mockResolvedValue("result_a"),
        },
        tool_b: {
          execute: vi.fn().mockResolvedValue("result_b"),
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
          ],
        },
        {
          role: "user",
          content: [{ type: "text", text: "message between" }],
        },
        {
          role: "assistant",
          content: [
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

      // Expected order: assistant(a), tool(a), user, assistant(b), tool(b)
      expect(messages).toHaveLength(5);
      expect(messages[0].role).toBe("assistant");
      expect(messages[1].role).toBe("tool");
      expect((messages[1] as any).content[0].toolCallId).toBe("call-a");
      expect(messages[2].role).toBe("user");
      expect(messages[3].role).toBe("assistant");
      expect(messages[4].role).toBe("tool");
      expect((messages[4] as any).content[0].toolCallId).toBe("call-b");
    });

    it("returns newly created tool result messages", async () => {
      const tools = {
        tool_a: {
          execute: vi.fn().mockResolvedValue("a"),
        },
        tool_b: {
          execute: vi.fn().mockResolvedValue("b"),
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
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-b",
              toolName: "tool_b",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      const newMessages = await executeToolCallsFromMessages(messages, {
        tools,
      });

      expect(newMessages).toHaveLength(2);
      expect((newMessages[0] as any).content[0].toolCallId).toBe("call-a");
      expect((newMessages[1] as any).content[0].toolCallId).toBe("call-b");
    });

    it("preserves behavior for single assistant message case", async () => {
      const tools = {
        my_tool: {
          execute: vi.fn().mockResolvedValue("ok"),
        },
      };

      const messages = [
        {
          role: "user",
          content: [{ type: "text", text: "hi" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "my_tool",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await executeToolCallsFromMessages(messages, { tools });

      // user, assistant, tool-result
      expect(messages).toHaveLength(3);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
      expect(messages[2].role).toBe("tool");
      expect((messages[2] as any).content[0].toolCallId).toBe("call-1");
    });
  });

  describe("abort signal", () => {
    it("throws AbortError without calling the tool when the signal is already aborted", async () => {
      const execute = vi.fn();
      const tools = {
        my_tool: { description: "test", execute },
      };
      const controller = new AbortController();
      controller.abort();
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "my_tool",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await expect(
        executeToolCallsFromMessages(messages, {
          tools,
          abortSignal: controller.signal,
        })
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(execute).not.toHaveBeenCalled();
    });

    it("forwards the abort signal into tool.execute", async () => {
      const execute = vi.fn().mockResolvedValue({ ok: true });
      const tools = {
        my_tool: { description: "test", execute },
      };
      const controller = new AbortController();
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "my_tool",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await executeToolCallsFromMessages(messages, {
        tools,
        abortSignal: controller.signal,
      });

      expect(execute).toHaveBeenCalledTimes(1);
      const call = execute.mock.calls[0];
      expect(call[1]?.abortSignal).toBe(controller.signal);
    });

    it("drops tool results that resolve after abort (post-await re-check)", async () => {
      // Regression: if a tool ignores the abort signal and resolves a
      // result after the signal fired, that result must NOT be
      // serialized into history. Building it would persist a phantom
      // "successful tool result" past the cancellation point.
      const controller = new AbortController();
      const execute = vi.fn().mockImplementation(async () => {
        // Tool ignores the signal: aborts mid-flight but still resolves.
        controller.abort();
        return { ok: "this should never be persisted" };
      });
      const tools = {
        my_tool: { description: "test", execute },
      };
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "my_tool",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await expect(
        executeToolCallsFromMessages(messages, {
          tools,
          abortSignal: controller.signal,
        })
      ).rejects.toMatchObject({ name: "AbortError" });

      // Crucially: no tool-result message was inserted into history,
      // even though `execute` resolved successfully.
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("assistant");
    });

    it("rethrows tool aborts instead of storing them as error-text results", async () => {
      const abortError = Object.assign(new Error("aborted"), {
        name: "AbortError",
      });
      const execute = vi.fn().mockRejectedValue(abortError);
      const tools = {
        my_tool: { description: "test", execute },
      };
      const controller = new AbortController();
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "my_tool",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await expect(
        executeToolCallsFromMessages(messages, {
          tools,
          abortSignal: controller.signal,
        })
      ).rejects.toBe(abortError);

      // Crucially: no synthesized tool-result was inserted. Persisting
      // an "AbortError" string into history would poison subsequent turns.
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("assistant");
    });
  });

  // SEP-1865 App-Provided Tools: the MCPJam free-model handler relies on
  // this flag to leave app-aliased tool calls unresolved (so the client's
  // `useChat.onToolCall` can dispatch them into the iframe) instead of
  // crashing the agent loop with "Tool not found" or
  // "tool.execute is not a function".
  describe("skipNonExecutableTools (SEP-1865)", () => {
    it("silently skips registered app aliases whose tool has no execute function", async () => {
      const tools = {
        srv_real: { execute: vi.fn().mockResolvedValue({ ok: true }) },
        app_abcd1234: {
          description: "[Demo] ping",
          // no execute
        },
      };
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-srv",
              toolName: "srv_real",
              input: {},
            },
            {
              type: "tool-call",
              toolCallId: "call-app",
              toolName: "app_abcd1234",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      const newMessages = await executeToolCallsFromMessages(messages, {
        tools,
        skipNonExecutableTools: true,
      });

      expect(tools.srv_real.execute).toHaveBeenCalledTimes(1);
      // One result inserted for the server tool; the app alias remains
      // unresolved in messageHistory so the caller can detect it via
      // hasUnresolvedToolCalls and pause for the client.
      expect(newMessages).toHaveLength(1);
      expect((newMessages[0] as any).content[0].toolCallId).toBe("call-srv");
      // The unresolved app tool call must NOT have produced a synthetic
      // error result (that would corrupt model context).
      const allResults = messages.flatMap((m) =>
        m.role === "tool" ? (m as any).content : [],
      );
      const appResult = allResults.find(
        (c: any) => c.toolCallId === "call-app",
      );
      expect(appResult).toBeUndefined();
    });

    it("does not skip unknown app aliases", async () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-app",
              toolName: "app_abcd1234",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await executeToolCallsFromMessages(messages, {
        tools: {},
        skipNonExecutableTools: true,
      });

      expect(messages).toHaveLength(2);
      expect((messages[1] as any).content[0].output.value).toMatch(
        /not found/i,
      );
    });

    it("silently skips registered app tools without an execute function", async () => {
      // App tools are registered server-side via `tool({...})` with no
      // execute. Without the flag, the helper would TypeError mid-iteration.
      const tools = {
        app_abcd1234: {
          description: "[Demo] ping",
          // no execute
        },
      };
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-app",
              toolName: "app_abcd1234",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      const newMessages = await executeToolCallsFromMessages(messages, {
        tools,
        skipNonExecutableTools: true,
      });

      expect(newMessages).toHaveLength(0);
      expect(messages).toHaveLength(1); // no synthesized tool-result
    });

    it("still throws Tool not found when the flag is OFF (default)", async () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-app",
              toolName: "app_abcd1234",
              input: {},
            },
          ],
        },
      ] as unknown as ModelMessage[];

      await executeToolCallsFromMessages(messages, { tools: {} });

      // Helper catches its own throws and writes them as tool-result with
      // output.type === "error-text" — verify the error string mentions
      // the unknown tool so this regression is loud.
      expect(messages).toHaveLength(2);
      expect((messages[1] as any).content[0].output.value).toMatch(
        /not found/i,
      );
    });
  });
});

describe("executeToolCallsFromMessages — toModelOutput (browser-render PR 14)", () => {
  const callMessage = (toolName: string): ModelMessage[] =>
    [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-cu-1",
            toolName,
            input: { action: "screenshot" },
          },
        ],
      },
    ] as unknown as ModelMessage[];

  it("uses the tool's toModelOutput mapping as the model-facing output", async () => {
    const implResult = {
      screenshotBase64: "aGVsbG8=",
      widgetToolCalls: [],
      elapsedMs: 12,
    };
    const tools = {
      computer: {
        execute: vi.fn().mockResolvedValue(implResult),
        toModelOutput: vi.fn(({ output }: { output: unknown }) => ({
          type: "content",
          value: [
            {
              type: "image-data",
              data: (output as { screenshotBase64: string }).screenshotBase64,
              mediaType: "image/png",
            },
          ],
        })),
      },
    };

    const messages = callMessage("computer");
    const newMessages = await executeToolCallsFromMessages(messages, {
      tools,
    });

    expect(tools.computer.toModelOutput).toHaveBeenCalledWith({
      output: implResult,
    });
    expect(newMessages).toHaveLength(1);
    const part = (newMessages[0] as any).content[0];
    expect(part.type).toBe("tool-result");
    expect(part.toolCallId).toBe("call-cu-1");
    expect(part.output).toEqual({
      type: "content",
      value: [
        { type: "image-data", data: "aGVsbG8=", mediaType: "image/png" },
      ],
    });
  });

  it("does NOT duplicate the raw implementation result onto the part", async () => {
    // Content outputs carry the full model-facing payload (screenshots);
    // duplicating the raw result would double-ship the screenshot in every
    // subsequent per-step request body on the hosted path.
    const tools = {
      computer: {
        execute: async () => ({ screenshotBase64: "eA==" }),
        toModelOutput: () => ({ type: "text", value: "ok" }),
      },
    };

    const messages = callMessage("computer");
    const newMessages = await executeToolCallsFromMessages(messages, {
      tools,
    });

    const part = (newMessages[0] as any).content[0];
    expect(part.output).toEqual({ type: "text", value: "ok" });
    expect("result" in part).toBe(false);
  });

  it("awaits an async toModelOutput", async () => {
    const tools = {
      computer: {
        execute: async () => ({ n: 1 }),
        toModelOutput: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { type: "text", value: "async-mapped" };
        },
      },
    };

    const messages = callMessage("computer");
    const newMessages = await executeToolCallsFromMessages(messages, {
      tools,
    });

    expect((newMessages[0] as any).content[0].output).toEqual({
      type: "text",
      value: "async-mapped",
    });
  });

  it("a throwing toModelOutput records an error tool-result (not a crash)", async () => {
    const tools = {
      computer: {
        execute: async () => ({ n: 1 }),
        toModelOutput: () => {
          throw new Error("mapping failed");
        },
      },
    };

    const messages = callMessage("computer");
    const newMessages = await executeToolCallsFromMessages(messages, {
      tools,
    });

    const part = (newMessages[0] as any).content[0];
    expect(part.output.type).toBe("error-text");
    expect(part.output.value).toMatch(/mapping failed/);
  });

  it("tools without toModelOutput keep the JSON serialization path", async () => {
    const tools = {
      regular: {
        execute: async () => ({ ok: true }),
      },
    };

    const messages = callMessage("regular");
    const newMessages = await executeToolCallsFromMessages(messages, {
      tools,
    });

    const part = (newMessages[0] as any).content[0];
    expect(part.output).toEqual({ type: "json", value: { ok: true } });
    expect(part.result).toEqual({ ok: true });
  });
});
