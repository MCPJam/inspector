import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../native-mirror", () => ({
  mirrorUiToolToNative: vi.fn(() => null),
}));

import { handleUiToolCall } from "../ui-tool-executor";
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

describe("handleUiToolCall", () => {
  beforeEach(() => {
    useUiToolsRegistry.setState({
      tools: new Map(),
      nativeDisposers: new Map(),
      shippedNames: new Set(),
    });
  });

  it("executes a registered tool and supplies the output", async () => {
    const def = makeTool();
    useUiToolsRegistry.getState().registerUiTool(def);
    const addToolOutput = vi.fn();

    const handled = await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-1",
      input: { target: "playground" },
      addToolOutput,
    });

    expect(handled).toBe(true);
    expect(def.execute).toHaveBeenCalledWith({ target: "playground" });
    expect(addToolOutput).toHaveBeenCalledWith({
      tool: "ui_navigate",
      toolCallId: "tc-1",
      output: { content: [{ type: "text", text: "navigated" }] },
    });
  });

  it("fires onNavigationToolCall BEFORE execute for mayNavigate tools", async () => {
    const order: string[] = [];
    const def = makeTool({
      mayNavigate: true,
      execute: vi.fn(async () => {
        order.push("execute");
        return { content: [{ type: "text" as const, text: "ok" }] };
      }),
    });
    useUiToolsRegistry.getState().registerUiTool(def);

    await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-nav",
      input: {},
      addToolOutput: vi.fn(),
      onNavigationToolCall: (name) => {
        order.push(`handoff:${name}`);
      },
    });

    expect(order).toEqual(["handoff:ui_navigate", "execute"]);
  });

  it("does not fire onNavigationToolCall for unflagged tools", async () => {
    const def = makeTool({ name: "ui_snapshot_app", readOnly: true });
    useUiToolsRegistry.getState().registerUiTool(def);
    const onNavigationToolCall = vi.fn();

    await handleUiToolCall({
      toolName: "ui_snapshot_app",
      toolCallId: "tc-snap",
      input: {},
      addToolOutput: vi.fn(),
      onNavigationToolCall,
    });

    expect(onNavigationToolCall).not.toHaveBeenCalled();
  });

  it("a throwing onNavigationToolCall never blocks the tool output", async () => {
    const def = makeTool({ mayNavigate: true });
    useUiToolsRegistry.getState().registerUiTool(def);
    const addToolOutput = vi.fn();

    const handled = await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-throw",
      input: {},
      addToolOutput,
      onNavigationToolCall: () => {
        throw new Error("handoff exploded");
      },
    });

    expect(handled).toBe(true);
    expect(def.execute).toHaveBeenCalled();
    expect(addToolOutput).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "tc-throw" })
    );
  });

  it("coerces non-object input to empty args", async () => {
    const def = makeTool();
    useUiToolsRegistry.getState().registerUiTool(def);

    await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-1",
      input: "garbage",
      addToolOutput: vi.fn(),
    });
    expect(def.execute).toHaveBeenCalledWith({});
  });

  it("converts execute throws into isError outputs", async () => {
    useUiToolsRegistry.getState().registerUiTool(
      makeTool({
        execute: async () => {
          throw new Error("router exploded");
        },
      }),
    );
    const addToolOutput = vi.fn();

    const handled = await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-1",
      input: {},
      addToolOutput,
    });

    expect(handled).toBe(true);
    expect(addToolOutput).toHaveBeenCalledWith({
      tool: "ui_navigate",
      toolCallId: "tc-1",
      output: {
        content: [{ type: "text", text: "UI tool failed: router exploded" }],
        isError: true,
      },
    });
  });

  it("answers unresolved-but-shipped names with an error so the stream resumes", async () => {
    const registry = useUiToolsRegistry.getState();
    registry.registerUiTool(makeTool());
    registry.snapshotForChatBody();
    registry.unregisterUiTool("ui_navigate");
    const addToolOutput = vi.fn();

    const handled = await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-1",
      input: {},
      addToolOutput,
    });

    expect(handled).toBe(true);
    expect(addToolOutput).toHaveBeenCalledWith({
      tool: "ui_navigate",
      toolCallId: "tc-1",
      output: {
        content: [
          { type: "text", text: 'UI tool "ui_navigate" is no longer available.' },
        ],
        isError: true,
      },
    });
  });

  it("falls through (returns false, no output) for names that are not ours", async () => {
    const addToolOutput = vi.fn();

    // Never registered, never shipped — could be a genuine server tool
    // named ui_something, or any app alias / server tool.
    for (const toolName of ["ui_unknown", "app_abcd1234", "server_tool"]) {
      const handled = await handleUiToolCall({
        toolName,
        toolCallId: "tc-1",
        input: {},
          addToolOutput,
      });
      expect(handled).toBe(false);
    }
    expect(addToolOutput).not.toHaveBeenCalled();
  });
});
