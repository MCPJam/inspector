/**
 * browser-session-context.test.ts — shared browser session context.
 *
 * Covers the attachment surface every "mock a user session" runner (eval
 * iterations, synthetic chatbox sessions) wires into its turn driver:
 * Computer Use tool construction (wire format), the advertised-tool gate,
 * both render hooks (engine `onToolResult` + local AI-SDK
 * `onToolResultChunk`), input caching, prompt-index stamping, incremental
 * artifact draining, and disposal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const renderMcpAppToolResult = vi.fn();
const isRenderableMcpAppTool = vi.fn();

vi.mock("../../utils/mcp-app-render-observation", () => ({
  renderMcpAppToolResult: (...args: unknown[]) =>
    renderMcpAppToolResult(...args),
  isRenderableMcpAppTool: (...args: unknown[]) =>
    isRenderableMcpAppTool(...args),
}));

// Capability lookup is network-backed (OpenRouter catalog) — stub it. Claude
// ids never reach it (offline fast path); the default `false` preserves the
// "no computer tools" behavior for unknown drivers.
const modelSupportsComputerUse = vi.fn();

vi.mock("../../utils/model-capabilities", () => ({
  modelSupportsComputerUse: (...args: unknown[]) =>
    modelSupportsComputerUse(...args),
}));

const harnessInstances: Array<{
  getMountedWidgetId: ReturnType<typeof vi.fn>;
  dismissWidget: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  executeAction: ReturnType<typeof vi.fn>;
  // Delegates to the shared `runScriptedStepImpl` rather than being its own
  // mock, so a test can set a scripted verdict BEFORE the render that creates
  // this instance.
  runScriptedStep: (...args: unknown[]) => unknown;
  getRecordingStartedAt: ReturnType<typeof vi.fn>;
  captureLiveThumbnail?: ReturnType<typeof vi.fn>;
}> = [];

// Shared across all (lazily-created) harness instances so a test can control a
// scripted step's pass/fail BEFORE the render that creates the harness.
const runScriptedStepImpl = vi.fn();

vi.mock("../../utils/mcp-app-browser-harness", async () => {
  const actual = await vi.importActual<
    typeof import("../../utils/mcp-app-browser-harness")
  >("../../utils/mcp-app-browser-harness");
  return {
    ...actual,
    McpAppBrowserHarness: vi.fn().mockImplementation(() => {
      const instance = {
        getMountedWidgetId: vi.fn().mockReturnValue(null),
        dismissWidget: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn().mockResolvedValue(undefined),
        executeAction: vi.fn(),
        runScriptedStep: (...args: unknown[]) => runScriptedStepImpl(...args),
        // Recording-start origin for `videoOffsetMs`. Null (no recording) is
        // the default, matching a harness that never launched Chromium.
        getRecordingStartedAt: vi.fn().mockReturnValue(null),
      };
      harnessInstances.push(instance);
      return instance;
    }),
  };
});

import {
  createBrowserSessionContext,
  boundFollowUpsForArtifact,
} from "../browser-session-context";
import type { LiveBrowserFrame } from "@/shared/browser-live-frame";

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
  modelSupportsComputerUse.mockResolvedValue(false);
  // Default: every scripted step passes; failure tests override.
  runScriptedStepImpl.mockResolvedValue({
    ok: true,
    widgetToolCalls: [],
    followUps: [],
    elapsedMs: 1,
  });
});

describe("boundFollowUpsForArtifact (R1 durable-artifact bounds)", () => {
  it("passes short follow-ups through unchanged", () => {
    expect(boundFollowUpsForArtifact(["Show my cart"])).toEqual([
      "Show my cart",
    ]);
  });

  it("caps the number of follow-ups per step at 10", () => {
    const many = Array.from({ length: 25 }, (_, i) => `msg ${i}`);
    expect(boundFollowUpsForArtifact(many)).toHaveLength(10);
  });

  it("truncates an over-long follow-up string", () => {
    const huge = "x".repeat(10_000);
    const [bounded] = boundFollowUpsForArtifact([huge]);
    expect(bounded.length).toBe(5_000);
  });
});

describe("createBrowserSessionContext — Computer Use surface", () => {
  // Computer Use is OPT-IN (default off, reserved for session simulation). These
  // tests pass `enableComputerUse: true` to exercise the capability machinery.
  it("stays off by default (no opt-in) even for a capable driver", async () => {
    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      mcpClientManager: stubManager(),
    });

    expect(ctx.computerUseSupported).toBe(false);
    expect(ctx.computerUseVersion).toBeNull();
    expect(ctx.computerWidgetTools).toEqual({});
    expect(ctx.prepareAdvertisedTools).toBeUndefined();
  });

  it("builds wire-format computer tools + gate for Claude drivers", async () => {
    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
      mcpClientManager: stubManager(),
    });

    expect(ctx.computerUseSupported).toBe(true);
    expect(ctx.computerUseVersion).toBe("20250124");
    // Claude ids resolve offline — the catalog lookup is never consulted.
    expect(modelSupportsComputerUse).not.toHaveBeenCalled();
    expect(Object.keys(ctx.computerWidgetTools).sort()).toEqual([
      "computer",
      "finish_widget",
    ]);
    // Wire format: NOT the provider-defined factory output.
    expect(
      (ctx.computerWidgetTools.computer as { id?: string }).id
    ).toBeUndefined();
    expect(ctx.prepareAdvertisedTools).toBeDefined();
  });

  it("builds no computer tools and no gate for capability-less drivers", async () => {
    const ctx = await createBrowserSessionContext({
      model: NON_CLAUDE_MODEL,
      enableComputerUse: true,
      mcpClientManager: stubManager(),
    });

    expect(ctx.computerUseSupported).toBe(false);
    expect(ctx.computerUseVersion).toBeNull();
    expect(ctx.computerWidgetTools).toEqual({});
    expect(ctx.prepareAdvertisedTools).toBeUndefined();
    // No harness eagerly constructed either.
    expect(harnessInstances).toHaveLength(0);
  });

  it("builds computer tools for non-Claude drivers with vision + tool calling", async () => {
    modelSupportsComputerUse.mockResolvedValue(true);
    const ctx = await createBrowserSessionContext({
      model: NON_CLAUDE_MODEL,
      enableComputerUse: true,
      mcpClientManager: stubManager(),
    });

    expect(modelSupportsComputerUse).toHaveBeenCalledWith(NON_CLAUDE_MODEL);
    expect(ctx.computerUseSupported).toBe(true);
    // No provider-native version — wire format doesn't need one.
    expect(ctx.computerUseVersion).toBeNull();
    expect(Object.keys(ctx.computerWidgetTools).sort()).toEqual([
      "computer",
      "finish_widget",
    ]);
    expect(ctx.prepareAdvertisedTools).toBeDefined();
    expect(harnessInstances).toHaveLength(1);
  });

  it("gate hides computer tools until a widget is mounted, then reveals", async () => {
    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
      mcpClientManager: stubManager(),
    });
    const harness = harnessInstances[0]!;
    const names = ["search", "computer", "finish_widget"];

    expect(
      ctx.prepareAdvertisedTools!({ stepIndex: 0, defaultToolNames: names })
    ).toEqual(["search"]);

    harness.getMountedWidgetId.mockReturnValue("tc-1");
    expect(
      ctx.prepareAdvertisedTools!({ stepIndex: 1, defaultToolNames: names })
    ).toEqual(names);
  });
});

describe("createBrowserSessionContext — render hook", () => {
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

    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
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
    const ctx = await createBrowserSessionContext({
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

    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      mcpClientManager: manager,
    });

    await expect(
      ctx.handleEngineToolResult(baseEvent)
    ).resolves.toBeUndefined();
    expect(ctx.widgetRenderObservations).toEqual([]);
  });

  it("releases the cached tool input once the call's result has been handled", async () => {
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

    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      mcpClientManager: manager,
    });
    ctx.noteToolCallInput({ toolCallId: "tc-1", input: { city: "lisbon" } });

    await ctx.handleEngineToolResult(baseEvent);
    expect(
      (renderMcpAppToolResult.mock.calls[0]![0] as { toolInput?: unknown })
        .toolInput
    ).toEqual({ city: "lisbon" });

    // The entry was consumed; a second result for the same id no longer
    // sees the input (cache stays bounded over long sessions).
    await ctx.handleEngineToolResult(baseEvent);
    expect(
      (renderMcpAppToolResult.mock.calls[1]![0] as { toolInput?: unknown })
        .toolInput
    ).toBeUndefined();
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

    const ctx = await createBrowserSessionContext({
      model: NON_CLAUDE_MODEL,
      mcpClientManager: manager,
    });
    await ctx.handleEngineToolResult(baseEvent);

    expect(ctx.widgetRenderObservations).toHaveLength(1);
    // No Computer Use → don't keep the widget mounted.
    expect(
      (renderMcpAppToolResult.mock.calls[0]![0] as { keepMounted?: boolean })
        .keepMounted
    ).toBe(false);
  });
});

describe("createBrowserSessionContext — interaction steps", () => {
  it("collects browserInteractionSteps from computer-tool actions with per-widget step ordinals", async () => {
    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
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
    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
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

  it("stamps videoOffsetMs on a Computer Use step once recording is live", async () => {
    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
      mcpClientManager: stubManager(),
    });
    const harness = harnessInstances[0]!;
    harness.getMountedWidgetId.mockReturnValue("tc-w");
    harness.executeAction.mockResolvedValue({
      action: { action: "left_click", coordinate: [1, 2] },
      screenshotBase64: "img",
      widgetToolCalls: [],
      elapsedMs: 3,
    });
    // Recording started 5s before this step lands.
    const now = Date.now();
    harness.getRecordingStartedAt.mockReturnValue(now - 5_000);

    const computer = ctx.computerWidgetTools.computer as {
      execute: (input: unknown, opts: unknown) => Promise<unknown>;
    };
    await computer.execute({ action: "left_click", coordinate: [1, 2] }, {});

    // Computer Use is the SWARM mode, and only the scripted path used to get
    // this — without it the replay filmstrip can't seek the `.webm` to the
    // frame a click produced.
    const step = ctx.browserInteractionSteps[0]!;
    expect(step.videoOffsetMs).toBeGreaterThanOrEqual(5_000);
    // Derived from the SAME `ts` the row carries, so the two can't drift.
    expect(step.videoOffsetMs).toBe(step.ts - (now - 5_000));
  });

  it("leaves videoOffsetMs absent when nothing is recording", async () => {
    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
      mcpClientManager: stubManager(),
    });
    const harness = harnessInstances[0]!;
    harness.getMountedWidgetId.mockReturnValue("tc-w");
    harness.executeAction.mockResolvedValue({
      action: { action: "screenshot" },
      widgetToolCalls: [],
      elapsedMs: 1,
    });

    const computer = ctx.computerWidgetTools.computer as {
      execute: (input: unknown, opts: unknown) => Promise<unknown>;
    };
    await computer.execute({ action: "screenshot" }, {});

    expect(ctx.browserInteractionSteps[0]!.videoOffsetMs).toBeUndefined();
  });
});

describe("createBrowserSessionContext — live browser frames", () => {
  function armedHarness(screenshotBase64?: string) {
    const harness = harnessInstances[0]!;
    harness.getMountedWidgetId.mockReturnValue("tc-w");
    harness.executeAction.mockResolvedValue({
      action: { action: "left_click", coordinate: [7, 9] },
      ...(screenshotBase64 ? { screenshotBase64 } : {}),
      widgetToolCalls: [],
      elapsedMs: 4,
    });
    return harness;
  }

  it("emits a frame as each action COMPLETES, not at drain time", async () => {
    const frames: LiveBrowserFrame[] = [];
    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
      mcpClientManager: stubManager(),
      onBrowserAction: (frame) => frames.push(frame),
    });
    // A tiny screenshot: already under the live cap, so it is reused as-is and
    // no second capture is taken.
    const harness = armedHarness("iVBORw0KGgo=");
    ctx.setActivePromptIndex(2);

    const computer = ctx.computerWidgetTools.computer as {
      execute: (input: unknown, opts: unknown) => Promise<unknown>;
    };
    await computer.execute({ action: "left_click", coordinate: [7, 9] }, {});

    // The frame is here BEFORE any drain — that's the whole point.
    expect(ctx.drainNewArtifacts().steps).toHaveLength(1);
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toMatchObject({
      sequence: 1,
      promptIndex: 2,
      toolCallId: "tc-w",
      stepIndex: 0,
      action: "left_click",
      coordinateX: 7,
      coordinateY: 9,
      thumbnailBase64: "iVBORw0KGgo=",
      thumbnailMediaType: "image/png",
    });
  });

  it("numbers frames monotonically so a consumer can drop stale ones", async () => {
    const frames: LiveBrowserFrame[] = [];
    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
      mcpClientManager: stubManager(),
      onBrowserAction: (frame) => frames.push(frame),
    });
    armedHarness("iVBORw0KGgo=");
    const computer = ctx.computerWidgetTools.computer as {
      execute: (input: unknown, opts: unknown) => Promise<unknown>;
    };
    await computer.execute({ action: "left_click", coordinate: [7, 9] }, {});
    await computer.execute({ action: "left_click", coordinate: [7, 9] }, {});
    // Ordered by ACTION, not by whichever thumbnail finished encoding first: the
    // sequence is taken synchronously, at the moment the action completed.
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames.map((f) => f.sequence)).toEqual([1, 2]);
  });

  it("coalesces a burst to the latest frame instead of queueing every encode", async () => {
    const frames: LiveBrowserFrame[] = [];
    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
      mcpClientManager: stubManager(),
      onBrowserAction: (frame) => frames.push(frame),
    });
    const harness = armedHarness("A".repeat(200_000));
    // Hold every re-encode open so three actions land while one is in flight.
    let releaseCaptures!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCaptures = resolve;
    });
    const captureLiveThumbnail = vi.fn(async () => {
      await gate;
      return "jpeg";
    });
    harness.captureLiveThumbnail = captureLiveThumbnail;

    const computer = ctx.computerWidgetTools.computer as {
      execute: (input: unknown, opts: unknown) => Promise<unknown>;
    };
    await computer.execute({ action: "left_click", coordinate: [7, 9] }, {});
    await computer.execute({ action: "left_click", coordinate: [7, 9] }, {});
    await computer.execute({ action: "left_click", coordinate: [7, 9] }, {});
    releaseCaptures();

    // Frames 1 and 3 — the one already encoding and the newest. Frame 2 is
    // deliberately dropped: the channel is latest-wins at every hop, so making a
    // burst of clicks queue up encodes would only push the viewer further behind
    // the agent. Every durable step is still persisted; this is the live preview.
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames.map((f) => f.sequence)).toEqual([1, 3]);
    expect(captureLiveThumbnail).toHaveBeenCalledTimes(2);
    // All three actions are still on the record the replay is built from.
    expect(ctx.browserInteractionSteps).toHaveLength(3);
  });

  it("re-encodes a thumbnail when the step screenshot is over the live cap", async () => {
    const frames: LiveBrowserFrame[] = [];
    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
      mcpClientManager: stubManager(),
      onBrowserAction: (frame) => frames.push(frame),
    });
    const harness = armedHarness("A".repeat(200_000));
    harness.captureLiveThumbnail = vi
      .fn()
      .mockResolvedValue("small-jpeg");

    const computer = ctx.computerWidgetTools.computer as {
      execute: (input: unknown, opts: unknown) => Promise<unknown>;
    };
    await computer.execute({ action: "left_click", coordinate: [7, 9] }, {});

    // A 200 KB base64 must never go on the wire per click.
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0].thumbnailBase64).toBe("small-jpeg");
    expect(frames[0].thumbnailMediaType).toBe("image/jpeg");
  });

  it("still emits the action when no thumbnail can be produced", async () => {
    const frames: LiveBrowserFrame[] = [];
    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
      mcpClientManager: stubManager(),
      onBrowserAction: (frame) => frames.push(frame),
    });
    const harness = armedHarness();
    harness.captureLiveThumbnail = vi.fn().mockResolvedValue(null);

    const computer = ctx.computerWidgetTools.computer as {
      execute: (input: unknown, opts: unknown) => Promise<unknown>;
    };
    await computer.execute({ action: "left_click", coordinate: [7, 9] }, {});

    // Metadata is still worth delivering; the viewer keeps its last image.
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0].thumbnailBase64).toBeUndefined();
  });

  it("a throwing sink can never break the action it previews", async () => {
    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
      mcpClientManager: stubManager(),
      onBrowserAction: () => {
        throw new Error("sink exploded");
      },
    });
    armedHarness("iVBORw0KGgo=");
    const computer = ctx.computerWidgetTools.computer as {
      execute: (input: unknown, opts: unknown) => Promise<unknown>;
    };
    await expect(
      computer.execute({ action: "left_click", coordinate: [7, 9] }, {}),
    ).resolves.toBeDefined();
    expect(ctx.browserInteractionSteps).toHaveLength(1);
    // The queued emission rejects into the context's own containment, never out.
    await vi.waitFor(() => expect(ctx.browserInteractionSteps).toHaveLength(1));
  });

  it("does no thumbnail work at all without a sink (flag off)", async () => {
    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
      mcpClientManager: stubManager(),
    });
    const harness = armedHarness("A".repeat(200_000));
    const captureLiveThumbnail = vi.fn().mockResolvedValue("x");
    harness.captureLiveThumbnail = captureLiveThumbnail;

    const computer = ctx.computerWidgetTools.computer as {
      execute: (input: unknown, opts: unknown) => Promise<unknown>;
    };
    await computer.execute({ action: "left_click", coordinate: [7, 9] }, {});

    // A true no-op: not even the extra JPEG shot the live path would take.
    await vi.waitFor(() => expect(ctx.browserInteractionSteps).toHaveLength(1));
    expect(captureLiveThumbnail).not.toHaveBeenCalled();
    expect(ctx.browserInteractionSteps).toHaveLength(1);
  });
});

describe("createBrowserSessionContext — lifecycle", () => {
  it("dismissCarriedWidget dismisses only when a widget is mounted", async () => {
    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
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
    const claudeCtx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
      mcpClientManager: stubManager(),
    });
    await claudeCtx.dispose();
    expect(harnessInstances[0]!.dispose).toHaveBeenCalledTimes(1);

    const plainCtx = await createBrowserSessionContext({
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

    const ctx = await createBrowserSessionContext({
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
        .toolInput
    ).toBeUndefined();
  });
});

describe("createBrowserSessionContext — direct (local AI-SDK) render hook", () => {
  const baseChunk = {
    toolCallId: "tc-1",
    toolName: "show_widget",
    input: { city: "porto" },
    output: { content: [], structuredContent: { full: true } },
    serverId: "srv-1",
  };

  it("renders renderable results with the chunk's inline input (no cache)", async () => {
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

    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
      mcpClientManager: manager,
    });
    ctx.setActivePromptIndex(3);

    await ctx.handleDirectToolResultChunk(baseChunk);

    expect(renderMcpAppToolResult).toHaveBeenCalledTimes(1);
    const params = renderMcpAppToolResult.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(params.toolInput).toEqual({ city: "porto" });
    expect(params.output).toBe(baseChunk.output);
    expect(params.keepMounted).toBe(true);
    expect(ctx.widgetRenderObservations).toEqual([
      expect.objectContaining({ toolCallId: "tc-1", promptIndex: 3 }),
    ]);
  });

  it("skips chunks without serverId and contains a throwing render", async () => {
    const manager = {
      executeTool: vi.fn(),
      getAllToolsMetadata: vi
        .fn()
        .mockReturnValue({ show_widget: { "mcpjam/widget": true } }),
    } as never;
    isRenderableMcpAppTool.mockReturnValue(true);
    renderMcpAppToolResult.mockRejectedValue(new Error("chromium exploded"));

    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      mcpClientManager: manager,
    });

    await ctx.handleDirectToolResultChunk({
      ...baseChunk,
      serverId: undefined,
    });
    expect(renderMcpAppToolResult).not.toHaveBeenCalled();

    await expect(
      ctx.handleDirectToolResultChunk(baseChunk)
    ).resolves.toBeUndefined();
    expect(ctx.widgetRenderObservations).toEqual([]);
  });
});

describe("createBrowserSessionContext — drainNewArtifacts", () => {
  it("returns only rows appended since the previous drain; arrays stay intact", async () => {
    const manager = {
      executeTool: vi.fn(),
      getAllToolsMetadata: vi
        .fn()
        .mockReturnValue({ show_widget: { "mcpjam/widget": true } }),
    } as never;
    isRenderableMcpAppTool.mockReturnValue(true);
    renderMcpAppToolResult.mockImplementation(
      async (args: { toolCallId: string }) => ({
        toolCallId: args.toolCallId,
        toolName: "show_widget",
        serverId: "srv-1",
        status: "rendered",
        elapsedMs: 5,
        ts: 123,
      })
    );

    const ctx = await createBrowserSessionContext({
      model: CLAUDE_MODEL,
      enableComputerUse: true,
      mcpClientManager: manager,
    });
    const harness = harnessInstances[0]!;
    harness.getMountedWidgetId.mockReturnValue("tc-a");
    harness.executeAction.mockResolvedValue({
      action: { action: "screenshot" },
      widgetToolCalls: [],
      elapsedMs: 1,
    });
    const computer = ctx.computerWidgetTools.computer as {
      execute: (input: unknown, opts: unknown) => Promise<unknown>;
    };

    // Nothing yet.
    expect(ctx.drainNewArtifacts()).toEqual({ observations: [], steps: [] });

    await ctx.handleDirectToolResultChunk({
      toolCallId: "tc-a",
      toolName: "show_widget",
      input: {},
      output: {},
      serverId: "srv-1",
    });
    await computer.execute({ action: "screenshot" }, {});

    const first = ctx.drainNewArtifacts();
    expect(first.observations.map((o) => o.toolCallId)).toEqual(["tc-a"]);
    expect(first.steps.map((s) => s.stepIndex)).toEqual([0]);

    // A second drain with nothing new is empty.
    expect(ctx.drainNewArtifacts()).toEqual({ observations: [], steps: [] });

    await computer.execute({ action: "screenshot" }, {});
    const second = ctx.drainNewArtifacts();
    expect(second.observations).toEqual([]);
    expect(second.steps.map((s) => s.stepIndex)).toEqual([1]);

    // End-of-run consumers still see everything.
    expect(ctx.widgetRenderObservations).toHaveLength(1);
    expect(ctx.browserInteractionSteps).toHaveLength(2);
  });
});

describe("createBrowserSessionContext — widget interaction checks", () => {
  function managerWithWidget() {
    return {
      executeTool: vi.fn(),
      getAllToolsMetadata: vi
        .fn()
        .mockReturnValue({ create_view: { "mcpjam/widget": true } }),
    } as never;
  }
  function rendered(status = "rendered") {
    isRenderableMcpAppTool.mockReturnValue(true);
    renderMcpAppToolResult.mockResolvedValue({
      toolCallId: "tc-1",
      toolName: "create_view",
      serverId: "srv-1",
      status,
      elapsedMs: 5,
      ts: 1,
    });
  }
  const renderArgs = {
    toolCallId: "tc-1",
    toolName: "create_view",
    serverId: "srv-1",
    toolInput: {},
    output: {},
  };

  it("runs a group when its widget renders and records scripted steps", async () => {
    rendered();
    const ctx = await createBrowserSessionContext({
      mcpClientManager: managerWithWidget(),
    });
    ctx.setActiveWidgetChecks([
      {
        toolName: "create_view",
        steps: [{ kind: "assert", assertion: { type: "textVisible", text: "Hi" } }],
      },
    ]);
    await ctx.renderPinnedToolResult(renderArgs);

    const scripted = ctx.browserInteractionSteps.filter(
      (s) => s.source === "scripted",
    );
    expect(scripted).toHaveLength(1);
    expect(scripted[0]!.assertion).toMatchObject({
      type: "textVisible",
      passed: true,
    });
    expect(ctx.scriptedCheckFailures).toHaveLength(0);
  });

  it("forwards prior widget tool calls across separate unified steps (widgetToolCalled sees an earlier interact's call)", async () => {
    rendered();
    const ctx = await createBrowserSessionContext({
      mcpClientManager: managerWithWidget(),
    });
    // Keep the widget mounted across render so the unified replay path is
    // eligible (otherwise the widget is dismissed after render).
    ctx.setKeepWidgetsMountedForSteps(true);
    await ctx.renderPinnedToolResult(renderArgs);
    harnessInstances[0]!.getMountedWidgetId.mockReturnValue("tc-1");

    const checkoutCall = {
      name: "checkout",
      args: { cartId: "c1" },
      ok: true,
      elapsedMs: 1,
    };
    // Step 1 (interact: a click) triggers a widget→host call...
    runScriptedStepImpl.mockResolvedValueOnce({
      ok: true,
      widgetToolCalls: [checkoutCall],
      followUps: [],
      elapsedMs: 1,
    });
    await ctx.replayInteractStep("create_view", {
      kind: "click",
      target: { role: { role: "button", name: "Checkout" } },
    });
    // Step 2 (a SEPARATE assert) must see the call the click triggered.
    await ctx.evaluateWidgetAssertion("create_view", {
      kind: "widgetToolCalled",
      toolName: "create_view",
      calledToolName: "checkout",
    });

    // The assert's runScriptedStep call must receive the accumulated calls.
    const assertCallArg = runScriptedStepImpl.mock.calls.at(-1)?.[0];
    expect(assertCallArg.priorWidgetToolCalls).toEqual([checkoutCall]);
  });

  it("drains a widget's render-time ui/message follow-up as a model turn", async () => {
    // Auto-send-on-render: a widget that emits ui/message during its initial
    // render must continue the model turn, not be silently dropped.
    rendered();
    renderMcpAppToolResult.mockResolvedValue({
      toolCallId: "tc-1",
      toolName: "create_view",
      serverId: "srv-1",
      status: "rendered",
      elapsedMs: 5,
      ts: 1,
      followUps: ["auto-sent on render"],
    });
    const ctx = await createBrowserSessionContext({
      mcpClientManager: managerWithWidget(),
    });
    ctx.setKeepWidgetsMountedForSteps(true);
    await ctx.renderPinnedToolResult(renderArgs);

    expect(ctx.drainFollowUps()).toEqual(["auto-sent on render"]);
    // The trace observation stays a pure render record (no followUps leak).
    const obs = ctx.widgetRenderObservations.find(
      (o) => o.toolCallId === "tc-1",
    );
    expect(obs).toBeDefined();
    expect((obs as Record<string, unknown>).followUps).toBeUndefined();
  });

  it("truncates an oversized render follow-up before it drives a model turn", async () => {
    rendered();
    const huge = "x".repeat(200_000);
    renderMcpAppToolResult.mockResolvedValue({
      toolCallId: "tc-1",
      toolName: "create_view",
      serverId: "srv-1",
      status: "rendered",
      elapsedMs: 5,
      ts: 1,
      followUps: [huge],
    });
    const ctx = await createBrowserSessionContext({
      mcpClientManager: managerWithWidget(),
    });
    ctx.setKeepWidgetsMountedForSteps(true);
    await ctx.renderPinnedToolResult(renderArgs);

    const drained = ctx.drainFollowUps();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.length).toBeLessThan(huge.length);
  });

  it("records a failure when a scripted assertion fails", async () => {
    rendered();
    runScriptedStepImpl.mockResolvedValue({
      ok: false,
      reason: 'text not visible: "Hi"',
      widgetToolCalls: [],
      elapsedMs: 1,
    });
    const ctx = await createBrowserSessionContext({
      mcpClientManager: managerWithWidget(),
    });
    ctx.setActiveWidgetChecks([
      {
        toolName: "create_view",
        steps: [{ kind: "assert", assertion: { type: "textVisible", text: "Hi" } }],
      },
    ]);
    await ctx.renderPinnedToolResult(renderArgs);

    expect(ctx.scriptedCheckFailures).toHaveLength(1);
    expect(ctx.scriptedCheckFailures[0]).toMatchObject({
      toolName: "create_view",
    });
  });

  it("stamps ok=true on a successful pure action step (no assertion field)", async () => {
    rendered();
    const ctx = await createBrowserSessionContext({
      mcpClientManager: managerWithWidget(),
    });
    ctx.setActiveWidgetChecks([
      {
        toolName: "create_view",
        steps: [
          {
            kind: "click",
            target: { role: { role: "button", name: "Add to cart" } },
          },
        ],
      },
    ]);
    await ctx.renderPinnedToolResult(renderArgs);

    const scripted = ctx.browserInteractionSteps.filter(
      (s) => s.source === "scripted",
    );
    expect(scripted).toHaveLength(1);
    expect(scripted[0]!.ok).toBe(true);
    expect(scripted[0]!.assertion).toBeUndefined();
    expect(ctx.scriptedCheckFailures).toHaveLength(0);
  });

  it("stamps ok=false on a failed action and still fails closed", async () => {
    rendered();
    runScriptedStepImpl.mockResolvedValue({
      ok: false,
      reason: 'locator not found: button "Add to cart"',
      widgetToolCalls: [],
      elapsedMs: 1,
    });
    const ctx = await createBrowserSessionContext({
      mcpClientManager: managerWithWidget(),
    });
    ctx.setActiveWidgetChecks([
      {
        toolName: "create_view",
        steps: [
          {
            kind: "click",
            target: { role: { role: "button", name: "Add to cart" } },
          },
        ],
      },
    ]);
    await ctx.renderPinnedToolResult(renderArgs);

    const scripted = ctx.browserInteractionSteps.filter(
      (s) => s.source === "scripted",
    );
    expect(scripted[0]!.ok).toBe(false);
    expect(ctx.scriptedCheckFailures).toHaveLength(1);
  });

  it("fails closed when a group's widget never renders (flush)", async () => {
    const ctx = await createBrowserSessionContext({
      mcpClientManager: managerWithWidget(),
    });
    // A group for a tool that the turn never renders.
    ctx.setActiveWidgetChecks([
      {
        toolName: "never_rendered",
        steps: [{ kind: "assert", assertion: { type: "textVisible", text: "x" } }],
      },
    ]);
    ctx.flushActiveWidgetChecks();
    expect(ctx.scriptedCheckFailures).toHaveLength(1);
    expect(ctx.scriptedCheckFailures[0]!.toolName).toBe("never_rendered");
  });

  it("fails closed when a tool renders a second widget in one turn (v1 invariant)", async () => {
    rendered();
    const ctx = await createBrowserSessionContext({
      mcpClientManager: managerWithWidget(),
    });
    ctx.setActiveWidgetChecks([
      {
        toolName: "create_view",
        steps: [{ kind: "assert", assertion: { type: "textVisible", text: "Hi" } }],
      },
    ]);
    // First render runs the group; a second render of the same tool can't be
    // targeted by toolName → fail closed (not a silent re-run).
    await ctx.renderPinnedToolResult({ ...renderArgs, toolCallId: "tc-a" });
    await ctx.renderPinnedToolResult({ ...renderArgs, toolCallId: "tc-b" });

    expect(
      ctx.scriptedCheckFailures.some((f) =>
        /multiple widgets for tool/i.test(f.reason),
      ),
    ).toBe(true);
  });
});
