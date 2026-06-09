/**
 * PR 9 — End-to-end smoke test for the model-driven Computer Use loop on the
 * STREAMED Anthropic AI-SDK eval path (`streamIterationWithAiSdk`, reached via
 * `streamTestCase`).
 *
 * Sibling to `computer-use-loop.test.ts` (the non-stream PR 8 smoke test). Proves
 * PR 9's port: the streamed path mounts the widget, drives a Computer Use click
 * through the real headless-Chromium harness, and forwards exactly one render
 * observation + one interaction step into the persistence fanout — same as the
 * non-stream path. Uses the same fixture + mock model; only the runner entry and
 * the stream consumer differ.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";

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

const preparedToolsRef = vi.hoisted(() => ({
  tools: {} as Record<string, unknown>,
}));

vi.mock("../../../utils/chat-v2-orchestration", () => ({
  prepareChatV2: vi.fn(async (options: any) => ({
    allTools: preparedToolsRef.tools,
    enhancedSystemPrompt: options?.systemPrompt ?? "",
    resolvedTemperature: options?.temperature,
    scrubMessages: (msgs: unknown[]) => msgs,
    progressivePlan: { enabled: false },
    discoveryState: { loadedToolIds: new Set<string>(), catalogVersion: 0 },
  })),
}));

// Skip persistence — assert in-memory collection via the fanout call args.
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

import { streamTestCase } from "../../evals-runner";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import * as computerUseModule from "../../../utils/computer-use-tool";
import {
  McpAppBrowserHarness,
  DEFAULT_VIEWPORT,
} from "../../../utils/mcp-app-browser-harness";

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
    { type: "tool-call", toolCallId: "tc-show", toolName: "show_seats", input: "{}" },
    { type: "finish", finishReason: "tool-calls", usage: USAGE },
  ]);
}
function streamForComputerLeftClick(
  coordinate: [number, number],
): LanguageModelV3StreamResult {
  return streamPartsAsResult([
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "tc-click", toolName: "computer" },
    { type: "tool-input-end", id: "tc-click" },
    {
      type: "tool-call",
      toolCallId: "tc-click",
      toolName: "computer",
      input: JSON.stringify({ action: "left_click", coordinate }),
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

describe("PR 9 — model-driven Computer Use loop, streamed path (smoke)", () => {
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
        ? { show_seats: { ui: { resourceUri: "ui://widget/seats" } } }
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

  let buildCuToolsSpy: ReturnType<typeof vi.spyOn>;
  let renderWidgetSpy: ReturnType<typeof vi.spyOn>;
  let executeActionSpy: ReturnType<typeof vi.spyOn>;
  let disposeSpy: ReturnType<typeof vi.spyOn>;
  let mockModel: MockLanguageModelV3;

  beforeEach(() => {
    vi.clearAllMocks();
    executeToolCalls.length = 0;
    persistEvalTraceFanoutMock.mockResolvedValue({ turnsWritten: 0, locked: false });
    convexClient.mutation.mockResolvedValue({ iterationId: "iter-1" });
    convexClient.query.mockResolvedValue({ status: "running" });
    convexClient.action.mockResolvedValue(undefined);
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

    const showSeatsTool = tool({
      description: "Show the seat selector widget",
      inputSchema: z.object({}).passthrough(),
      execute: async () => ({ content: [{ type: "text", text: "showing seats" }] }),
    }) as any;
    showSeatsTool._serverId = "flights";
    preparedToolsRef.tools = { show_seats: showSeatsTool };

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

    buildCuToolsSpy = vi.spyOn(computerUseModule, "buildComputerUseTools");
    renderWidgetSpy = vi.spyOn(McpAppBrowserHarness.prototype, "renderWidget");
    executeActionSpy = vi.spyOn(McpAppBrowserHarness.prototype, "executeAction");
    disposeSpy = vi.spyOn(McpAppBrowserHarness.prototype, "dispose");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("streamed path renders, drives a click, collects one obs + one step, disposes", async () => {
    await streamTestCase({
      test: {
        title: "Computer Use stream smoke",
        query: "Reserve seat 12",
        model: "claude-haiku-4-5",
        provider: "anthropic",
        runs: 1,
        expectedToolCalls: [],
        promptTurns: [
          { id: "turn-1", prompt: "Reserve seat 12", expectedToolCalls: [] },
        ],
        testCaseId: "case-smoke",
      } as any,
      tools: {},
      selectedServers: ["flights"],
      mcpClientManager: mcpClientManager as any,
      recorder: null,
      modelApiKeys: { anthropic: "sk-test" },
      convexHttpUrl: "https://example.convex.site",
      convexAuthToken: "token",
      convexClient: convexClient as any,
      testCaseId: "case-smoke",
      runId: null,
      emit: () => {},
    });

    // Harness lifecycle ran on the streamed path.
    expect(buildCuToolsSpy).toHaveBeenCalledTimes(1);
    expect(buildCuToolsSpy.mock.calls[0]![0].viewport).toEqual(DEFAULT_VIEWPORT);
    expect(renderWidgetSpy).toHaveBeenCalledTimes(1);
    expect(renderWidgetSpy.mock.calls[0]![0]).toMatchObject({
      toolCallId: "tc-show",
      serverId: "flights",
      keepMounted: true,
    });
    expect(executeActionSpy).toHaveBeenCalledTimes(1);
    // The fixture widget's tools/call reached executeTool through the harness.
    expect(executeToolCalls).toEqual([
      { sid: "flights", name: "reserve", args: { seat: 12 } },
    ]);
    // Harness disposed in the finally (PR 9's outer try/finally).
    expect(disposeSpy).toHaveBeenCalled();

    // PR 9 deliverable: one render observation + one step forwarded to the
    // fanout from the streamed iteration.
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
    });
  }, 60_000);
});
