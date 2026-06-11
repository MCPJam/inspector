/**
 * browser-eval-context.test.ts — hosted-path browser eval context (PR 14).
 *
 * Covers the engine-attachment surface the hosted runners
 * (`runIterationViaBackend` / `streamIterationViaBackend`) wire into
 * `runAssistantTurn`: Computer Use tool construction (wire format), the
 * advertised-tool gate, the render hook (engine `onToolResult`), input
 * caching, prompt-index stamping, and disposal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const renderMcpAppToolResult = vi.fn();
const isRenderableMcpAppTool = vi.fn();

vi.mock("../../../utils/mcp-app-render-observation", () => ({
  renderMcpAppToolResult: (...args: unknown[]) =>
    renderMcpAppToolResult(...args),
  isRenderableMcpAppTool: (...args: unknown[]) =>
    isRenderableMcpAppTool(...args),
}));

const harnessInstances: Array<{
  getMountedWidgetId: ReturnType<typeof vi.fn>;
  dismissWidget: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  executeAction: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("../../../utils/mcp-app-browser-harness", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/mcp-app-browser-harness")
  >("../../../utils/mcp-app-browser-harness");
  return {
    ...actual,
    McpAppBrowserHarness: vi.fn().mockImplementation(() => {
      const instance = {
        getMountedWidgetId: vi.fn().mockReturnValue(null),
        dismissWidget: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn().mockResolvedValue(undefined),
        executeAction: vi.fn(),
      };
      harnessInstances.push(instance);
      return instance;
    }),
  };
});

import { createEvalBrowserContext } from "../browser-eval-context";

const CLAUDE_MODEL = "claude-haiku-4-5";
const NON_CLAUDE_MODEL = "gpt-5-mini";

function stubManager() {
  return {
    executeTool: vi.fn(),
    getAllToolsMetadata: vi.fn().mockReturnValue({}),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  harnessInstances.length = 0;
  isRenderableMcpAppTool.mockReturnValue(false);
});

describe("createEvalBrowserContext — Computer Use surface", () => {
  it("builds wire-format computer tools + gate for Claude drivers", () => {
    const ctx = createEvalBrowserContext({
      model: CLAUDE_MODEL,
      mcpClientManager: stubManager(),
    });

    expect(ctx.computerUseVersion).toBe("20250124");
    expect(Object.keys(ctx.computerWidgetTools).sort()).toEqual([
      "computer",
      "finish_widget",
    ]);
    // Wire format: NOT the provider-defined factory output.
    expect(
      (ctx.computerWidgetTools.computer as { id?: string }).id,
    ).toBeUndefined();
    expect(ctx.prepareAdvertisedTools).toBeDefined();
  });

  it("builds no computer tools and no gate for non-Claude drivers", () => {
    const ctx = createEvalBrowserContext({
      model: NON_CLAUDE_MODEL,
      mcpClientManager: stubManager(),
    });

    expect(ctx.computerUseVersion).toBeNull();
    expect(ctx.computerWidgetTools).toEqual({});
    expect(ctx.prepareAdvertisedTools).toBeUndefined();
    // No harness eagerly constructed either.
    expect(harnessInstances).toHaveLength(0);
  });

  it("gate hides computer tools until a widget is mounted, then reveals", () => {
    const ctx = createEvalBrowserContext({
      model: CLAUDE_MODEL,
      mcpClientManager: stubManager(),
    });
    const harness = harnessInstances[0]!;
    const names = ["search", "computer", "finish_widget"];

    expect(
      ctx.prepareAdvertisedTools!({ stepIndex: 0, defaultToolNames: names }),
    ).toEqual(["search"]);

    harness.getMountedWidgetId.mockReturnValue("tc-1");
    expect(
      ctx.prepareAdvertisedTools!({ stepIndex: 1, defaultToolNames: names }),
    ).toEqual(names);
  });
});

describe("createEvalBrowserContext — render hook", () => {
  const baseEvent = {
    toolCallId: "tc-1",
    toolName: "show_widget",
    output: { type: "json", value: { scrubbed: true } },
    rawResult: { content: [], structuredContent: { full: true } },
    isError: false,
    stepIndex: 0,
    promptIndex: 0,
    serverId: "srv-1",
  };

  it("renders renderable MCP App results with the raw output and caches input", async () => {
    const manager = {
      executeTool: vi.fn(),
      getAllToolsMetadata: vi
        .fn()
        .mockReturnValue({ show_widget: { "mcpjam/widget": true } }),
    } as never;
    isRenderableMcpAppTool.mockReturnValue(true);
    renderMcpAppToolResult.mockResolvedValue({
      toolCallId: "tc-1",
      toolName: "show_widget",
      serverId: "srv-1",
      status: "rendered",
      elapsedMs: 5,
      ts: 123,
    });

    const ctx = createEvalBrowserContext({
      model: CLAUDE_MODEL,
      mcpClientManager: manager,
      injectOpenAiCompat: true,
    });
    ctx.setActivePromptIndex(2);
    ctx.noteToolCallInput({ toolCallId: "tc-1", input: { city: "lisbon" } });

    await ctx.handleEngineToolResult(baseEvent);

    expect(renderMcpAppToolResult).toHaveBeenCalledTimes(1);
    const params = renderMcpAppToolResult.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    // Raw result (not the scrubbed LLM view) feeds the widget shim.
    expect(params.output).toBe(baseEvent.rawResult);
    expect(params.toolInput).toEqual({ city: "lisbon" });
    expect(params.injectOpenAiCompat).toBe(true);
    // Claude driver → keep the widget mounted for Computer Use.
    expect(params.keepMounted).toBe(true);

    expect(ctx.widgetRenderObservations).toEqual([
      expect.objectContaining({
        toolCallId: "tc-1",
        status: "rendered",
        // Stamped from setActivePromptIndex, not the engine event.
        promptIndex: 2,
      }),
    ]);
  });

  it("skips events without serverId, error results, and non-renderable tools", async () => {
    const manager = {
      executeTool: vi.fn(),
      getAllToolsMetadata: vi.fn().mockReturnValue({ show_widget: {} }),
    } as never;
    const ctx = createEvalBrowserContext({
      model: CLAUDE_MODEL,
      mcpClientManager: manager,
    });

    await ctx.handleEngineToolResult({ ...baseEvent, serverId: undefined });
    await ctx.handleEngineToolResult({ ...baseEvent, isError: true });
    isRenderableMcpAppTool.mockReturnValue(false);
    await ctx.handleEngineToolResult(baseEvent);

    expect(renderMcpAppToolResult).not.toHaveBeenCalled();
    expect(ctx.widgetRenderObservations).toEqual([]);
  });

  it("a throwing render is contained (no observation, no throw)", async () => {
    const manager = {
      executeTool: vi.fn(),
      getAllToolsMetadata: vi
        .fn()
        .mockReturnValue({ show_widget: { "mcpjam/widget": true } }),
    } as never;
    isRenderableMcpAppTool.mockReturnValue(true);
    renderMcpAppToolResult.mockRejectedValue(new Error("chromium exploded"));

    const ctx = createEvalBrowserContext({
      model: CLAUDE_MODEL,
      mcpClientManager: manager,
    });

    await expect(ctx.handleEngineToolResult(baseEvent)).resolves.toBeUndefined();
    expect(ctx.widgetRenderObservations).toEqual([]);
  });

  it("renders for non-Claude drivers too (observations without Computer Use)", async () => {
    const manager = {
      executeTool: vi.fn(),
      getAllToolsMetadata: vi
        .fn()
        .mockReturnValue({ show_widget: { "mcpjam/widget": true } }),
    } as never;
    isRenderableMcpAppTool.mockReturnValue(true);
    renderMcpAppToolResult.mockResolvedValue({
      toolCallId: "tc-1",
      toolName: "show_widget",
      serverId: "srv-1",
      status: "rendered",
      elapsedMs: 5,
      ts: 123,
    });

    const ctx = createEvalBrowserContext({
      model: NON_CLAUDE_MODEL,
      mcpClientManager: manager,
    });
    await ctx.handleEngineToolResult(baseEvent);

    expect(ctx.widgetRenderObservations).toHaveLength(1);
    // No Computer Use → don't keep the widget mounted.
    expect(
      (renderMcpAppToolResult.mock.calls[0]![0] as { keepMounted?: boolean })
        .keepMounted,
    ).toBe(false);
  });
});

describe("createEvalBrowserContext — interaction steps", () => {
  it("collects browserInteractionSteps from computer-tool actions with per-widget step ordinals", async () => {
    const ctx = createEvalBrowserContext({
      model: CLAUDE_MODEL,
      mcpClientManager: stubManager(),
    });
    const harness = harnessInstances[0]!;
    harness.getMountedWidgetId.mockReturnValue("tc-w");
    harness.executeAction.mockResolvedValue({
      action: { action: "left_click", coordinate: [10, 20] },
      screenshotBase64: "img",
      widgetToolCalls: [],
      elapsedMs: 3,
    });

    ctx.setActivePromptIndex(1);
    const computer = ctx.computerWidgetTools.computer as {
      execute: (input: unknown, opts: unknown) => Promise<unknown>;
    };
    await computer.execute({ action: "left_click", coordinate: [10, 20] }, {});
    await computer.execute({ action: "left_click", coordinate: [10, 20] }, {});

    expect(ctx.browserInteractionSteps).toEqual([
      expect.objectContaining({
        toolCallId: "tc-w",
        stepIndex: 0,
        promptIndex: 1,
        action: "left_click",
        coordinateX: 10,
        coordinateY: 20,
        screenshotBase64: "img",
      }),
      expect.objectContaining({ stepIndex: 1 }),
    ]);
  });

  it("narrows unknown harness notes instead of dropping the step", async () => {
    const ctx = createEvalBrowserContext({
      model: CLAUDE_MODEL,
      mcpClientManager: stubManager(),
    });
    const harness = harnessInstances[0]!;
    harness.getMountedWidgetId.mockReturnValue("tc-w");
    harness.executeAction.mockResolvedValue({
      action: { action: "screenshot" },
      widgetToolCalls: [],
      elapsedMs: 1,
      note: "some_future_note_literal",
    });

    const computer = ctx.computerWidgetTools.computer as {
      execute: (input: unknown, opts: unknown) => Promise<unknown>;
    };
    await computer.execute({ action: "screenshot" }, {});

    expect(ctx.browserInteractionSteps).toHaveLength(1);
    expect(ctx.browserInteractionSteps[0]!.note).toBeUndefined();
  });
});

describe("createEvalBrowserContext — lifecycle", () => {
  it("dismissCarriedWidget dismisses only when a widget is mounted", async () => {
    const ctx = createEvalBrowserContext({
      model: CLAUDE_MODEL,
      mcpClientManager: stubManager(),
    });
    const harness = harnessInstances[0]!;

    await ctx.dismissCarriedWidget();
    expect(harness.dismissWidget).not.toHaveBeenCalled();

    harness.getMountedWidgetId.mockReturnValue("tc-carried");
    await ctx.dismissCarriedWidget();
    expect(harness.dismissWidget).toHaveBeenCalledWith("tc-carried");
  });

  it("dispose tears down the harness; no-op when never constructed", async () => {
    const claudeCtx = createEvalBrowserContext({
      model: CLAUDE_MODEL,
      mcpClientManager: stubManager(),
    });
    await claudeCtx.dispose();
    expect(harnessInstances[0]!.dispose).toHaveBeenCalledTimes(1);

    const plainCtx = createEvalBrowserContext({
      model: NON_CLAUDE_MODEL,
      mcpClientManager: stubManager(),
    });
    await expect(plainCtx.dispose()).resolves.toBeUndefined();
  });

  it("noteToolCallInput ignores non-object inputs", async () => {
    const manager = {
      executeTool: vi.fn(),
      getAllToolsMetadata: vi
        .fn()
        .mockReturnValue({ show_widget: { "mcpjam/widget": true } }),
    } as never;
    isRenderableMcpAppTool.mockReturnValue(true);
    renderMcpAppToolResult.mockResolvedValue({
      toolCallId: "tc-1",
      toolName: "show_widget",
      serverId: "srv-1",
      status: "rendered",
      elapsedMs: 5,
      ts: 1,
    });

    const ctx = createEvalBrowserContext({
      model: CLAUDE_MODEL,
      mcpClientManager: manager,
    });
    ctx.noteToolCallInput({ toolCallId: "tc-1", input: "not-an-object" });

    await ctx.handleEngineToolResult({
      toolCallId: "tc-1",
      toolName: "show_widget",
      output: {},
      rawResult: {},
      isError: false,
      stepIndex: 0,
      promptIndex: 0,
      serverId: "srv-1",
    });

    expect(
      (renderMcpAppToolResult.mock.calls[0]![0] as { toolInput?: unknown })
        .toolInput,
    ).toBeUndefined();
  });
});
