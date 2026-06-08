/**
 * PR 8 — End-to-end smoke test for the model-driven Computer Use loop on the
 * local Anthropic AI-SDK eval path (`runIterationWithAiSdk`).
 *
 * Drives a `MockLanguageModelV3` through real headless Chromium running the
 * production host bridge: server tool returns an MCP App widget → harness
 * renders it → mock model emits `computer` left_click → the fixture widget
 * fires `tools/call` back through `mcpClientManager` → mock model emits
 * `finish_widget` → final assistant message. Asserts the harness lifecycle,
 * the Computer Use tool output shape, the widget→host tool-call dispatch,
 * and the prepareAdvertisedTools gate after dismiss.
 *
 * This test is the explicit coverage gap named in the engineering handoff
 * §8 ("no full model-driven Computer Use loop test yet"). Closes the gap
 * without product code changes.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { build } from "esbuild";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";

// ---------------------------------------------------------------------------
// Module-level mocks. Hoisted spies are wired before the runner is imported.
// ---------------------------------------------------------------------------

const createLlmModelMock = vi.hoisted(() => vi.fn());

vi.mock("../../../utils/chat-helpers", async () => {
  const actual =
    await vi.importActual<typeof import("../../../utils/chat-helpers")>(
      "../../../utils/chat-helpers",
    );
  return {
    ...actual,
    createLlmModel: (...args: unknown[]) =>
      createLlmModelMock(...(args as Parameters<typeof createLlmModelMock>)),
  };
});

// Defer to a tool returned by the test setup. Using a hoisted ref so the
// vi.mock factory body can read it without TDZ issues.
const preparedToolsRef = vi.hoisted(() => ({ tools: {} as Record<string, unknown> }));

vi.mock("../../../utils/chat-v2-orchestration", () => ({
  prepareChatV2: vi.fn(async (options: any) => ({
    allTools: preparedToolsRef.tools,
    enhancedSystemPrompt: options?.systemPrompt ?? "",
    resolvedTemperature: options?.temperature,
    scrubMessages: (msgs: unknown[]) => msgs,
    progressivePlan: { enabled: false },
    discoveryState: {
      loadedToolIds: new Set<string>(),
      catalogVersion: 0,
    },
  })),
}));

// Skip persistence — we want to assert in-memory state, not exercise Convex.
// Hoisted so the test can read the serialized artifacts the real
// finalizeEvalIteration forwards into the fanout (PR 6b).
const persistEvalTraceFanoutMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ turnsWritten: 0, locked: false }),
);
vi.mock("../persist-eval-trace", () => ({
  persistEvalTraceFanout: persistEvalTraceFanoutMock,
  lockEvalSessionAfterUpdate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    finalizePassedForEval: ({ matchPassed }: { matchPassed: boolean }) =>
      matchPassed,
  };
});

// Spy targets — imported AFTER the mocks above so the runner picks up the
// stubbed exports, but BEFORE we set spies in `beforeEach`.
import { runEvalSuiteWithAiSdk } from "../../evals-runner";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import * as renderObsModule from "../../../utils/mcp-app-render-observation";
import * as computerUseModule from "../../../utils/computer-use-tool";
import {
  McpAppBrowserHarness,
  DEFAULT_VIEWPORT,
} from "../../../utils/mcp-app-browser-harness";

// ---------------------------------------------------------------------------
// Fixture: a real ext-apps guest widget with one button that fires tools/call.
// Mirrors `BUTTON_GUEST_SRC` from `server/utils/__tests__/mcp-app-browser-harness.test.ts`
// so the real ui/initialize handshake runs against the production host bridge.
// ---------------------------------------------------------------------------

const BUTTON_GUEST_SRC = `
import { App } from "@modelcontextprotocol/ext-apps";
const app = new App({ name: "fixture-button", version: "1.0.0" });
(async () => {
  await app.connect();
  const b = document.createElement("button");
  b.id = "ok";
  b.textContent = "Reserve seat";
  b.style.cssText = "position:absolute;left:540px;top:370px;width:200px;height:60px;font-size:18px";
  b.addEventListener("click", () => {
    app.callServerTool({ name: "reserve", arguments: { seat: 12 } }).catch(() => {});
  });
  document.body.appendChild(b);
})();
`;

async function bundleGuest(source: string): Promise<string> {
  const r = await build({
    stdin: { contents: source, resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  return r.outputFiles[0].text;
}

function guestHtml(js: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${js}</script></body></html>`;
}

let buttonHtml = "";

beforeAll(async () => {
  buttonHtml = guestHtml(await bundleGuest(BUTTON_GUEST_SRC));
}, 60_000);

// ---------------------------------------------------------------------------
// Mock language model: 4 sequential `doStream` calls drive the agentic loop.
// ---------------------------------------------------------------------------

function streamPartsAsResult(
  parts: LanguageModelV3StreamPart[],
): LanguageModelV3StreamResult {
  return {
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        for (const p of parts) controller.enqueue(p);
        controller.close();
      },
    }),
  };
}

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function streamForShowSeatsCall(): LanguageModelV3StreamResult {
  return streamPartsAsResult([
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "tc-show", toolName: "show_seats" },
    { type: "tool-input-end", id: "tc-show" },
    {
      type: "tool-call",
      toolCallId: "tc-show",
      toolName: "show_seats",
      input: "{}",
    },
    { type: "finish", finishReason: "tool-calls", usage: USAGE },
  ]);
}

function streamForComputerLeftClick(
  coordinate: [number, number],
): LanguageModelV3StreamResult {
  const input = JSON.stringify({ action: "left_click", coordinate });
  return streamPartsAsResult([
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "tc-click", toolName: "computer" },
    { type: "tool-input-end", id: "tc-click" },
    {
      type: "tool-call",
      toolCallId: "tc-click",
      toolName: "computer",
      input,
    },
    { type: "finish", finishReason: "tool-calls", usage: USAGE },
  ]);
}

function streamForFinishWidget(): LanguageModelV3StreamResult {
  return streamPartsAsResult([
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "tc-fin", toolName: "finish_widget" },
    { type: "tool-input-end", id: "tc-fin" },
    {
      type: "tool-call",
      toolCallId: "tc-fin",
      toolName: "finish_widget",
      input: JSON.stringify({ toolCallId: "tc-show" }),
    },
    { type: "finish", finishReason: "tool-calls", usage: USAGE },
  ]);
}

function streamForFinalText(): LanguageModelV3StreamResult {
  return streamPartsAsResult([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "Done." },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]);
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("PR 8 — model-driven Computer Use loop (smoke)", () => {
  const executeToolCalls: Array<{
    sid: string;
    name: string;
    args: Record<string, unknown>;
  }> = [];

  const convexClient = {
    mutation: vi.fn().mockResolvedValue({ iterationId: "iter-1" }),
    query: vi.fn().mockResolvedValue({ status: "running" }),
    action: vi.fn().mockResolvedValue(undefined),
  };

  const mcpClientManager = {
    listServers: vi.fn().mockReturnValue(["flights"]),
    getToolsForAiSdk: vi.fn().mockResolvedValue({}),
    getAllToolsMetadata: vi.fn((sid: string) =>
      sid === "flights"
        ? {
            show_seats: {
              ui: {
                resourceUri: "ui://widget/seats",
              },
            },
          }
        : {},
    ),
    readResource: vi.fn(async () => ({
      contents: [{ text: buttonHtml, _meta: { ui: {} } }],
    })),
    executeTool: vi.fn(async (sid: string, name: string, args: any) => {
      executeToolCalls.push({ sid, name, args });
      return { content: [{ type: "text", text: "reserved" }] };
    }),
    hasServer: vi.fn(() => true),
  };

  let renderObsSpy: ReturnType<typeof vi.spyOn>;
  let buildCuToolsSpy: ReturnType<typeof vi.spyOn>;
  let renderWidgetSpy: ReturnType<typeof vi.spyOn>;
  let executeActionSpy: ReturnType<typeof vi.spyOn>;
  let dismissWidgetSpy: ReturnType<typeof vi.spyOn>;
  let mockModel: MockLanguageModelV3;

  beforeEach(() => {
    vi.clearAllMocks();
    executeToolCalls.length = 0;
    // Reset mock manager defaults (vi.clearAllMocks wiped implementations).
    convexClient.mutation.mockResolvedValue({ iterationId: "iter-1" });
    convexClient.query.mockResolvedValue({ status: "running" });
    convexClient.action.mockResolvedValue(undefined);
    mcpClientManager.listServers.mockReturnValue(["flights"]);
    mcpClientManager.getToolsForAiSdk.mockResolvedValue({});
    mcpClientManager.getAllToolsMetadata.mockImplementation((sid: string) =>
      sid === "flights"
        ? { show_seats: { ui: { resourceUri: "ui://widget/seats" } } }
        : {},
    );
    mcpClientManager.readResource.mockResolvedValue({
      contents: [{ text: buttonHtml, _meta: { ui: {} } }],
    });
    mcpClientManager.executeTool.mockImplementation(
      async (sid: string, name: string, args: any) => {
        executeToolCalls.push({ sid, name, args });
        return { content: [{ type: "text", text: "reserved" }] };
      },
    );
    mcpClientManager.hasServer.mockReturnValue(true);

    // The fake server tool the model calls first. The `_serverId` tag is how
    // `direct-chat-turn`'s `readToolServerId` (~:525) routes the tool result
    // back through `onToolResultChunk` with a known serverId.
    const showSeatsTool = tool({
      description: "Show the seat selector widget",
      inputSchema: z.object({}).passthrough(),
      execute: async () => ({
        content: [{ type: "text", text: "showing seats" }],
      }),
    }) as any;
    showSeatsTool._serverId = "flights";
    preparedToolsRef.tools = { show_seats: showSeatsTool };

    // 4-step mock language model: show_seats → computer click → finish_widget → "Done."
    // Click coordinate (640, 400) is the center of the harness viewport and the
    // center of the fixture button (CSS box 540–740 × 370–430).
    const streams = [
      streamForShowSeatsCall(),
      streamForComputerLeftClick([640, 400]),
      streamForFinishWidget(),
      streamForFinalText(),
    ];
    let streamIndex = 0;
    mockModel = new MockLanguageModelV3({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      doStream: async (_opts: LanguageModelV3CallOptions) => {
        const next = streams[streamIndex];
        streamIndex += 1;
        if (!next) {
          throw new Error(
            `MockLanguageModelV3 called more than ${streams.length} times`,
          );
        }
        return next;
      },
    });
    createLlmModelMock.mockReturnValue(mockModel);

    // Spies on the modules the runner imports.
    renderObsSpy = vi.spyOn(renderObsModule, "renderMcpAppToolResult");
    buildCuToolsSpy = vi.spyOn(computerUseModule, "buildComputerUseTools");
    renderWidgetSpy = vi.spyOn(
      McpAppBrowserHarness.prototype,
      "renderWidget",
    );
    executeActionSpy = vi.spyOn(
      McpAppBrowserHarness.prototype,
      "executeAction",
    );
    dismissWidgetSpy = vi.spyOn(
      McpAppBrowserHarness.prototype,
      "dismissWidget",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a widget, drives a click, captures widget→host tools/call, dismisses", async () => {
    await runEvalSuiteWithAiSdk({
      suiteId: "suite-smoke",
      runId: null,
      config: {
        tests: [
          {
            title: "Computer Use smoke",
            query: "Reserve seat 12",
            runs: 1,
            model: "claude-haiku-4-5",
            provider: "anthropic",
            expectedToolCalls: [],
            promptTurns: [
              {
                id: "turn-1",
                prompt: "Reserve seat 12",
                expectedToolCalls: [],
              },
            ],
            testCaseId: "case-smoke",
          },
        ],
        environment: { servers: ["flights"] },
      },
      modelApiKeys: { anthropic: "sk-test" },
      convexClient: convexClient as any,
      convexHttpUrl: "https://example.convex.site",
      convexAuthToken: "token",
      mcpClientManager: mcpClientManager as any,
      testCaseId: "case-smoke",
    });

    // 1. buildComputerUseTools was called once with the default viewport,
    //    confirming the Anthropic provider-native factory was wired (which is
    //    what triggers the AI SDK's beta-header auto-attach).
    expect(buildCuToolsSpy).toHaveBeenCalledTimes(1);
    const buildArgs = buildCuToolsSpy.mock.calls[0]![0];
    expect(buildArgs.viewport).toEqual(DEFAULT_VIEWPORT);
    expect(buildArgs.version).toBe("20250124");

    // 2. The harness rendered exactly one widget for the `show_seats` tool
    //    call, with `serverId: "flights"` resolved via the tool's `_serverId`
    //    tag → `getAllToolsMetadata("flights")` → `isMcpAppTool`.
    expect(renderWidgetSpy).toHaveBeenCalledTimes(1);
    expect(renderWidgetSpy.mock.calls[0]![0]).toMatchObject({
      toolCallId: "tc-show",
      toolName: "show_seats",
      serverId: "flights",
      keepMounted: true,
    });

    // 3. renderMcpAppToolResult reported `status: "rendered"` with a
    //    non-empty screenshot and a successful bridge handshake.
    expect(renderObsSpy).toHaveBeenCalledTimes(1);
    const obs = await renderObsSpy.mock.results[0]!.value;
    expect(obs).toMatchObject({ status: "rendered", bridgeInitialized: true });
    expect(obs.screenshotBase64?.length ?? 0).toBeGreaterThan(0);

    // 4. The `computer` left_click was dispatched once into the harness.
    expect(executeActionSpy).toHaveBeenCalledTimes(1);
    expect(executeActionSpy.mock.calls[0]![0]).toMatchObject({
      toolCallId: "tc-show",
      action: { action: "left_click", coordinate: [640, 400] },
    });

    // 5. The fixture widget's internal `tools/call` reached
    //    `mcpClientManager.executeTool` via the harness's hostRpc binding.
    expect(executeToolCalls).toEqual([
      { sid: "flights", name: "reserve", args: { seat: 12 } },
    ]);

    // 6. The 3rd LM call (after the click) received a `computer` tool result
    //    whose `toModelOutput` carries (a) an image part for the screenshot
    //    and (b) a text part summarizing the widget tools/call.
    expect(mockModel.doStreamCalls.length).toBeGreaterThanOrEqual(3);
    const thirdPrompt = mockModel.doStreamCalls[2]!.prompt as Array<{
      role: string;
      content: any;
    }>;
    const lastMessage = thirdPrompt[thirdPrompt.length - 1]!;
    expect(lastMessage.role).toBe("tool");
    const toolResultParts = Array.isArray(lastMessage.content)
      ? (lastMessage.content as any[])
      : [];
    // Find the tool-result for the click.
    const clickResult = toolResultParts.find(
      (p) =>
        p?.type === "tool-result" &&
        p?.toolCallId === "tc-click" &&
        p?.toolName === "computer",
    );
    expect(clickResult).toBeDefined();
    const outputValue = clickResult.output?.value;
    expect(Array.isArray(outputValue)).toBe(true);
    const hasImage = outputValue.some(
      (part: any) =>
        part?.type === "image-data" ||
        part?.type === "image" ||
        part?.type === "file" /* AI SDK normalizes to file/image in tool outputs */,
    );
    const widgetCallText = outputValue.find(
      (part: any) => part?.type === "text",
    )?.text as string | undefined;
    expect(hasImage).toBe(true);
    expect(widgetCallText ?? "").toMatch(/widget invoked: reserve\(seat=12\)/);

    // 7. `finish_widget` dismissed the widget via the harness; the active
    //    widget id is gone afterward, and the 4th step's advertised tool list
    //    no longer includes Computer Use tools (the prepareAdvertisedTools
    //    gate strips them when no widget is mounted).
    expect(dismissWidgetSpy).toHaveBeenCalled();
    if (mockModel.doStreamCalls[3]) {
      const finalTools = mockModel.doStreamCalls[3]!.tools ?? [];
      const finalToolNames = finalTools.map((t: any) => t.name);
      expect(finalToolNames).not.toContain("computer");
      expect(finalToolNames).not.toContain("finish_widget");
    }

    // 8. PR 6b: the runner collected exactly one render observation and one
    //    interaction step, and finalizeEvalIteration forwarded them (serialized)
    //    into the fanout. The fixture produces exactly one of each: one
    //    show_seats render + one computer left_click.
    expect(persistEvalTraceFanoutMock).toHaveBeenCalledTimes(1);
    const fanoutArgs = persistEvalTraceFanoutMock.mock.calls[0]![0];
    expect(fanoutArgs.widgetRenderObservations).toHaveLength(1);
    expect(fanoutArgs.browserInteractionSteps).toHaveLength(1);
    expect(fanoutArgs.widgetRenderObservations[0]).toMatchObject({
      toolCallId: "tc-show",
      status: "rendered",
      promptIndex: 0,
    });
    expect(fanoutArgs.browserInteractionSteps[0]).toMatchObject({
      toolCallId: "tc-show",
      stepIndex: 0,
      promptIndex: 0,
      action: "left_click",
      coordinateX: 640,
      coordinateY: 400,
    });
    // The widget→host tools/call was captured on the step.
    expect(fanoutArgs.browserInteractionSteps[0].widgetToolCalls).toEqual([
      expect.objectContaining({ name: "reserve", ok: true }),
    ]);
  }, 60_000);
});
