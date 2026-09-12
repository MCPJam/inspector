/**
 * The transport-independent half of a UI tool call.
 *
 * The point of these tests is that there is exactly ONE answer to "what does
 * this tool do?": Ask MCPJam and a browser-native WebMCP agent resolve the
 * same registry, validate arguments the same way, and get back the same
 * bounded result. Everything that differs between them lives in their
 * adapters and is tested there.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeUiToolCall } from "../ui-tool-execution";
import { MAX_RESULT_CHARS } from "../bounded-size";
import {
  useUiToolsRegistry,
  type UiToolDefinition,
} from "../ui-tools-registry";

function makeTool(extra?: Partial<UiToolDefinition>): UiToolDefinition {
  return {
    name: "ui_navigate",
    description: "Navigate",
    readOnly: false,
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: "navigated" }],
    })),
    ...extra,
  };
}

function resetRegistry() {
  useUiToolsRegistry.setState({
    tools: new Map(),
    globalNames: new Set(),
    ownerTokens: new Map(),
    shippedNames: new Set(),
  });
}

describe("executeUiToolCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRegistry();
  });

  it("resolves the tool, runs it, and reports the outcome", async () => {
    const def = makeTool();
    useUiToolsRegistry.getState().registerUiTool(def);

    const outcome = await executeUiToolCall({
      toolName: "ui_navigate",
      input: { target: "playground" },
      caller: "ask_mcpjam",
      invocationId: "tc-1",
      scope: "session-a",
    });

    expect(outcome).toEqual({
      result: { content: [{ type: "text", text: "navigated" }] },
      status: "ok",
    });
    expect(def.execute).toHaveBeenCalledWith(
      { target: "playground" },
      { toolCallId: "tc-1", caller: "ask_mcpjam", scope: "session-a" },
    );
  });

  it("produces equivalent results for both callers", async () => {
    // The whole premise of the shared seam: an external agent driving
    // ui_navigate gets what Ask MCPJam gets, from the same handler.
    const def = makeTool({
      execute: vi.fn(async (args) => ({
        content: [{ type: "text" as const, text: JSON.stringify(args) }],
      })),
    });
    useUiToolsRegistry.getState().registerUiTool(def);

    const internal = await executeUiToolCall({
      toolName: "ui_navigate",
      input: { target: "evals" },
      caller: "ask_mcpjam",
      invocationId: "tc-internal",
    });
    const native = await executeUiToolCall({
      toolName: "ui_navigate",
      input: { target: "evals" },
      caller: "native_webmcp",
      invocationId: "native-1",
    });

    expect(native.result).toEqual(internal.result);
    expect(native.status).toBe(internal.status);
    // The ONE difference the handler can see: who asked, and whether there is
    // a conversation behind it.
    expect(def.execute).toHaveBeenNthCalledWith(1, expect.anything(), {
      toolCallId: "tc-internal",
      caller: "ask_mcpjam",
    });
    expect(def.execute).toHaveBeenNthCalledWith(2, expect.anything(), {
      toolCallId: "native-1",
      caller: "native_webmcp",
    });
  });

  it("executes the handler exactly once per call", async () => {
    const def = makeTool();
    useUiToolsRegistry.getState().registerUiTool(def);

    await executeUiToolCall({
      toolName: "ui_navigate",
      input: {},
      caller: "native_webmcp",
      invocationId: "native-1",
    });

    expect(def.execute).toHaveBeenCalledTimes(1);
  });

  it("reports an unregistered tool instead of throwing", async () => {
    const outcome = await executeUiToolCall({
      toolName: "ui_navigate",
      input: {},
      caller: "native_webmcp",
      invocationId: "native-1",
    });

    expect(outcome.status).toBe("unavailable");
    expect(outcome.errorCode).toBe("tool_unavailable");
    expect(outcome.result).toEqual({
      content: [
        { type: "text", text: 'UI tool "ui_navigate" is no longer available.' },
      ],
      isError: true,
    });
  });

  it.each([
    ["a string", "garbage", "a string"],
    ["a number", 42, "a number"],
    ["an array", [1, 2], "an array"],
  ])("rejects %s as arguments", async (_label, input, described) => {
    const def = makeTool();
    useUiToolsRegistry.getState().registerUiTool(def);

    const outcome = await executeUiToolCall({
      toolName: "ui_navigate",
      input,
      caller: "native_webmcp",
      invocationId: "native-1",
    });

    expect(outcome.status).toBe("invalid_input");
    expect(outcome.errorCode).toBe("invalid_input");
    expect(outcome.result.content[0]?.text).toBe(
      `ui_navigate: Arguments must be a JSON object, got ${described}.`,
    );
    expect(def.execute).not.toHaveBeenCalled();
  });

  it.each([undefined, null])(
    "treats %s as a no-argument call",
    async (input) => {
      const def = makeTool();
      useUiToolsRegistry.getState().registerUiTool(def);

      const outcome = await executeUiToolCall({
        toolName: "ui_navigate",
        input,
        caller: "native_webmcp",
        invocationId: "native-1",
      });

      expect(outcome.status).toBe("ok");
      expect(def.execute).toHaveBeenCalledWith({}, expect.anything());
    },
  );

  it("turns a throwing handler into an error result", async () => {
    useUiToolsRegistry.getState().registerUiTool(
      makeTool({
        execute: async () => {
          throw new Error("router exploded");
        },
      }),
    );

    const outcome = await executeUiToolCall({
      toolName: "ui_navigate",
      input: {},
      caller: "native_webmcp",
      invocationId: "native-1",
    });

    expect(outcome.status).toBe("threw");
    expect(outcome.errorCode).toBe("tool_threw");
    expect(outcome.result).toEqual({
      content: [{ type: "text", text: "UI tool failed: router exploded" }],
      isError: true,
    });
  });

  it("extracts a structured error code from a command-bus failure", async () => {
    useUiToolsRegistry.getState().registerUiTool(
      makeTool({
        execute: async () => ({
          content: [
            { type: "text" as const, text: "unknown_server: no such server" },
          ],
          isError: true,
        }),
      }),
    );

    const outcome = await executeUiToolCall({
      toolName: "ui_navigate",
      input: {},
      caller: "ask_mcpjam",
      invocationId: "tc-1",
    });

    expect(outcome.status).toBe("error");
    expect(outcome.errorCode).toBe("unknown_server");
  });

  it("never reports a free-text message as an error code", async () => {
    useUiToolsRegistry.getState().registerUiTool(
      makeTool({
        execute: async () => ({
          content: [{ type: "text" as const, text: "Something: went wrong" }],
          isError: true,
        }),
      }),
    );

    const outcome = await executeUiToolCall({
      toolName: "ui_navigate",
      input: {},
      caller: "native_webmcp",
      invocationId: "native-1",
    });

    expect(outcome.status).toBe("error");
    expect(outcome.errorCode).toBeUndefined();
  });

  describe("cancellation", () => {
    it("refuses a call whose signal is already aborted, without running it", async () => {
      const def = makeTool();
      useUiToolsRegistry.getState().registerUiTool(def);
      const controller = new AbortController();
      controller.abort();

      const outcome = await executeUiToolCall({
        toolName: "ui_navigate",
        input: {},
        caller: "native_webmcp",
        invocationId: "native-1",
        signal: controller.signal,
      });

      expect(outcome.status).toBe("cancelled");
      expect(def.execute).not.toHaveBeenCalled();
      // The wording must not suggest anything was rolled back.
      expect(outcome.result.content[0]?.text).toContain("nothing was executed");
    });

    it("hands the signal to the handler and keeps a completed result", async () => {
      // A late abort does not un-navigate a page. Once the handler has run,
      // its result is the truth about the world.
      const controller = new AbortController();
      const def = makeTool({
        execute: vi.fn(async (_args, ctx) => {
          expect(ctx?.signal).toBe(controller.signal);
          controller.abort();
          return { content: [{ type: "text" as const, text: "navigated" }] };
        }),
      });
      useUiToolsRegistry.getState().registerUiTool(def);

      const outcome = await executeUiToolCall({
        toolName: "ui_navigate",
        input: {},
        caller: "native_webmcp",
        invocationId: "native-1",
        signal: controller.signal,
      });

      expect(outcome.status).toBe("ok");
      expect(outcome.result.content[0]?.text).toBe("navigated");
    });
  });

  describe("result bounding", () => {
    it("clamps oversized text", async () => {
      useUiToolsRegistry.getState().registerUiTool(
        makeTool({
          execute: async () => ({
            content: [
              { type: "text" as const, text: "x".repeat(MAX_RESULT_CHARS * 3) },
            ],
          }),
        }),
      );

      const outcome = await executeUiToolCall({
        toolName: "ui_navigate",
        input: {},
        caller: "native_webmcp",
        invocationId: "native-1",
      });

      const text = outcome.result.content[0]?.text ?? "";
      expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 32);
      expect(text.endsWith("[truncated]")).toBe(true);
    });

    it("serializes a foreign result shape rather than shipping it raw", async () => {
      useUiToolsRegistry.getState().registerUiTool(
        makeTool({
          execute: async () =>
            ({
              content: [{ type: "image", data: "abc" }],
            }) as never,
        }),
      );

      const outcome = await executeUiToolCall({
        toolName: "ui_navigate",
        input: {},
        caller: "native_webmcp",
        invocationId: "native-1",
      });

      expect(outcome.result.content).toEqual([
        { type: "text", text: '{"type":"image","data":"abc"}' },
      ]);
    });

    it("says so when a handler returns nothing at all", async () => {
      useUiToolsRegistry
        .getState()
        .registerUiTool(makeTool({ execute: async () => undefined as never }));

      const outcome = await executeUiToolCall({
        toolName: "ui_navigate",
        input: {},
        caller: "native_webmcp",
        invocationId: "native-1",
      });

      expect(outcome.status).toBe("ok");
      expect(outcome.result.content).toEqual([
        { type: "text", text: "The tool returned no content." },
      ]);
    });
  });

  it("keeps the eval-scope restriction on the shared path", async () => {
    // A conversation whose eval scope cannot be read must not execute
    // anything, whichever transport asked. (No native call carries a scope,
    // so this only ever fires for Ask MCPJam — it is the backstop for the
    // gate the chat adapter applies before it claims the call.)
    const def = makeTool();
    useUiToolsRegistry.getState().registerUiTool(def);

    const outcome = await executeUiToolCall({
      toolName: "ui_navigate",
      input: {},
      caller: "ask_mcpjam",
      invocationId: "tc-1",
      scope: "eval-missing-scope",
    });

    expect(outcome.status).toBe("threw");
    expect(def.execute).not.toHaveBeenCalled();
    expect(outcome.result.isError).toBe(true);
  });
});
