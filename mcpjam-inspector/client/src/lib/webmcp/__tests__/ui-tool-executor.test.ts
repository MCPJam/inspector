import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../native-mirror", () => ({
  mirrorUiToolToNative: vi.fn(() => null),
}));

import {
  __resetUiToolExecutorForTests,
  fulfillApprovedUiToolCall,
  handleUiToolCall,
  listDeferredUiToolCalls,
} from "../ui-tool-executor";
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
    __resetUiToolExecutorForTests();
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

  it("defers mutating tools when requireToolApproval is on (no execute, no output)", async () => {
    const def = makeTool();
    useUiToolsRegistry.getState().registerUiTool(def);
    const addToolOutput = vi.fn();

    const handled = await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-defer",
      input: { target: "servers" },
      addToolOutput,
      requireToolApproval: true,
    });

    expect(handled).toBe(true); // claimed — the approval pill resolves it
    expect(def.execute).not.toHaveBeenCalled();
    expect(addToolOutput).not.toHaveBeenCalled();
    expect(listDeferredUiToolCalls()).toEqual([
      {
        toolCallId: "tc-defer",
        toolName: "ui_navigate",
        input: { target: "servers" },
      },
    ]);
  });

  it("read-only tools execute immediately even with the flag on", async () => {
    const def = makeTool({ name: "ui_snapshot_app", readOnly: true });
    useUiToolsRegistry.getState().registerUiTool(def);
    const addToolOutput = vi.fn();

    await handleUiToolCall({
      toolName: "ui_snapshot_app",
      toolCallId: "tc-ro",
      input: {},
      addToolOutput,
      requireToolApproval: true,
    });

    expect(def.execute).toHaveBeenCalled();
    expect(addToolOutput).toHaveBeenCalled();
  });

  it("fulfillApprovedUiToolCall executes the deferred call once (double-click safe)", async () => {
    const def = makeTool();
    useUiToolsRegistry.getState().registerUiTool(def);
    const addToolOutput = vi.fn();

    await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-appr",
      input: { target: "servers" },
      addToolOutput,
      requireToolApproval: true,
    });
    await fulfillApprovedUiToolCall({ toolCallId: "tc-appr", addToolOutput });
    await fulfillApprovedUiToolCall({ toolCallId: "tc-appr", addToolOutput });

    expect(def.execute).toHaveBeenCalledTimes(1);
    expect(def.execute).toHaveBeenCalledWith({ target: "servers" });
    expect(addToolOutput).toHaveBeenCalledTimes(1);
    expect(listDeferredUiToolCalls()).toEqual([]);
  });

  it("fulfillApprovedUiToolCall works from part data alone (reload case)", async () => {
    const def = makeTool();
    useUiToolsRegistry.getState().registerUiTool(def);
    const addToolOutput = vi.fn();

    // No prior defer — the page reloaded and the stash is gone; the caller
    // passes the hydrated part's toolName + input.
    await fulfillApprovedUiToolCall({
      toolCallId: "tc-reload",
      toolName: "ui_navigate",
      input: { target: "evals" },
      addToolOutput,
    });

    expect(def.execute).toHaveBeenCalledWith({ target: "evals" });
    expect(addToolOutput).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "tc-reload" })
    );
  });

  it("re-emitted tool calls for an executed id are claimed without re-executing", async () => {
    const def = makeTool();
    useUiToolsRegistry.getState().registerUiTool(def);
    const addToolOutput = vi.fn();
    const opts = {
      toolName: "ui_navigate",
      toolCallId: "tc-reemit",
      input: {},
      addToolOutput,
    };

    await handleUiToolCall(opts);
    const handledAgain = await handleUiToolCall(opts);

    expect(handledAgain).toBe(true);
    expect(def.execute).toHaveBeenCalledTimes(1);
    expect(addToolOutput).toHaveBeenCalledTimes(1);
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
