/**
 * runner.browser.test.ts — browser-rendered MCP App pipeline wiring in the
 * synthetic-session runner.
 *
 * Locks the per-session browser-context lifecycle (create → per-turn
 * setActivePromptIndex + dismissCarriedWidget → dispose-on-every-exit), the
 * Computer Use tool merge + hook threading into `drainAssistantTurn`, the
 * per-turn artifact drain → `chatSessions:recordBrowserArtifacts` persist,
 * and that the inert widget-snapshot capture (Data/Sandbox iframe) still
 * runs alongside.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runAssistantTurnMock = vi.fn();
const resolveSyntheticModelSourceMock = vi.fn();
const personaNextTurnMock = vi.fn();
const updateRunMock = vi.fn();
const persistChatSessionToConvexMock = vi.fn();
const captureMcpAppWidgetSnapshotsMock = vi.fn();
const prepareChatV2Mock = vi.fn();
const convexMutationMock = vi.fn();
const createBrowserSessionContextMock = vi.fn();

vi.mock("../../../utils/assistant-turn.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/assistant-turn.js")
  >("../../../utils/assistant-turn.js");
  return {
    ...actual,
    runAssistantTurn: (...args: unknown[]) => runAssistantTurnMock(...args),
  };
});

vi.mock("../../../utils/org-model-config.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/org-model-config.js")
  >("../../../utils/org-model-config.js");
  return {
    ...actual,
    resolveSyntheticModelSource: (...args: unknown[]) =>
      resolveSyntheticModelSourceMock(...args),
  };
});

vi.mock("../../session-agent.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../session-agent.js")
  >("../../session-agent.js");
  return {
    ...actual,
    personaNextTurn: (...args: unknown[]) => personaNextTurnMock(...args),
    updateRun: (...args: unknown[]) => updateRunMock(...args),
  };
});

vi.mock("../../../utils/chat-ingestion.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-ingestion.js")
  >("../../../utils/chat-ingestion.js");
  return {
    ...actual,
    persistChatSessionToConvex: (...args: unknown[]) =>
      persistChatSessionToConvexMock(...args),
  };
});

vi.mock("../../../utils/mcp-app-widget-capture.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/mcp-app-widget-capture.js")
  >("../../../utils/mcp-app-widget-capture.js");
  return {
    ...actual,
    captureMcpAppWidgetSnapshots: (...args: unknown[]) =>
      captureMcpAppWidgetSnapshotsMock(...args),
  };
});

vi.mock("../../../utils/chat-v2-orchestration.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-v2-orchestration.js")
  >("../../../utils/chat-v2-orchestration.js");
  return {
    ...actual,
    prepareChatV2: (...args: unknown[]) => prepareChatV2Mock(...args),
  };
});

vi.mock("../../browser-session-context.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../browser-session-context.js")
  >("../../browser-session-context.js");
  return {
    ...actual,
    createBrowserSessionContext: (...args: unknown[]) =>
      createBrowserSessionContextMock(...args),
  };
});

// Identity serializers: skip the screenshot blob upload, keep the rows.
vi.mock("../../browser-artifact-serialization.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../browser-artifact-serialization.js")
  >("../../browser-artifact-serialization.js");
  return {
    ...actual,
    serializeRenderObservationsForBackend: async (obs: unknown[] | undefined) =>
      (obs ?? []).map((o) => {
        const { screenshotBase64: _s, ...rest } = o as Record<string, unknown>;
        return rest;
      }),
    serializeBrowserStepsForBackend: async (steps: unknown[] | undefined) =>
      (steps ?? []).map((s) => {
        const { screenshotBase64: _s, ...rest } = s as Record<string, unknown>;
        return rest;
      }),
  };
});

vi.mock("convex/browser", async () => {
  const actual =
    await vi.importActual<typeof import("convex/browser")>("convex/browser");
  return {
    ...actual,
    ConvexHttpClient: class {
      setAuth() {}
      mutation(...args: unknown[]) {
        return convexMutationMock(...args);
      }
    },
  };
});

import { startSimulation } from "../runner.js";

const TURN_TRACE = {
  turnId: "turn-1",
  promptIndex: 0,
  startedAt: 0,
  endedAt: 1,
  spans: [],
};

/** Ordered call log shared by the fake browser context + engine mock. */
let callOrder: string[] = [];

function buildFakeBrowserContext(opts: { computerUse: boolean }) {
  const artifacts: {
    observations: Array<Record<string, unknown>>;
    steps: Array<Record<string, unknown>>;
  } = { observations: [], steps: [] };
  const ctx = {
    computerUseVersion: opts.computerUse ? ("20250124" as const) : null,
    computerWidgetTools: opts.computerUse
      ? { computer: { fake: true }, finish_widget: { fake: true } }
      : {},
    widgetRenderObservations: [],
    browserInteractionSteps: [],
    prepareAdvertisedTools: opts.computerUse ? vi.fn() : undefined,
    setActivePromptIndex: vi.fn((i: number) => {
      callOrder.push(`setActivePromptIndex:${i}`);
    }),
    noteToolCallInput: vi.fn(),
    handleEngineToolResult: vi.fn(),
    handleDirectToolResultChunk: vi.fn(),
    drainNewArtifacts: vi.fn(() => {
      const out = {
        observations: artifacts.observations,
        steps: artifacts.steps,
      };
      artifacts.observations = [];
      artifacts.steps = [];
      return out;
    }),
    dismissCarriedWidget: vi.fn(async () => {
      callOrder.push("dismissCarriedWidget");
    }),
    dispose: vi.fn(async () => {
      callOrder.push("dispose");
    }),
    /** Test handle: queue artifacts the next drain returns. */
    _queueArtifacts(
      observations: Array<Record<string, unknown>>,
      steps: Array<Record<string, unknown>>,
    ) {
      artifacts.observations = observations;
      artifacts.steps = steps;
    },
  };
  return ctx;
}

function baseOptions() {
  return {
    runId: "run-1",
    chatboxId: "chatbox-1",
    projectId: "proj-1",
    personas: [{ id: "p1", name: "Persona One", role: "tester" }],
    sessionsPerPersona: 1,
    maxTurns: 3,
    modelId: "anthropic/claude-haiku-4.5",
    systemPrompt: "system",
    requireToolApproval: false,
    convexHttpUrl: "https://convex.site",
    convexAuthToken: "Bearer token",
    authHeader: "Bearer token",
    managerFactory: async () => ({
      manager: {
        hasServer: () => false,
        executeTool: vi.fn(),
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as never,
      connectedServerIds: ["server-1"],
      connectedServerNames: ["Server One"],
      dispose: async () => {},
    }),
  };
}

beforeEach(() => {
  callOrder = [];
  vi.stubEnv("CONVEX_URL", "https://convex.cloud");
  runAssistantTurnMock.mockReset();
  resolveSyntheticModelSourceMock.mockReset();
  personaNextTurnMock.mockReset();
  updateRunMock.mockReset().mockResolvedValue(undefined);
  persistChatSessionToConvexMock.mockReset().mockResolvedValue(undefined);
  captureMcpAppWidgetSnapshotsMock.mockReset().mockResolvedValue([]);
  prepareChatV2Mock.mockReset().mockResolvedValue({
    allTools: { search: { description: "noop" } },
    enhancedSystemPrompt: "enhanced system",
    resolvedTemperature: undefined,
    progressivePlan: undefined,
    discoveryState: undefined,
  });
  convexMutationMock.mockReset().mockResolvedValue(null);
  createBrowserSessionContextMock.mockReset();
  resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });
  // One user turn, then the persona ends the session.
  personaNextTurnMock
    .mockResolvedValueOnce({ message: "draw me a box", endSession: false })
    .mockResolvedValue({ message: "", endSession: true });
  runAssistantTurnMock.mockImplementation(async (opts: any) => {
    callOrder.push("runAssistantTurn");
    return {
      messages: [
        ...opts.messages,
        { role: "assistant", content: "drew a box" },
      ],
      assistantMessages: [],
      toolCalls: [],
      toolResults: [],
      turnTrace: TURN_TRACE,
    };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("synthetic-session runner — browser pipeline wiring", () => {
  it("creates one context per session, runs per-turn hygiene before the engine, merges computer tools, threads hooks, persists artifacts, and disposes", async () => {
    const fake = buildFakeBrowserContext({ computerUse: true });
    fake._queueArtifacts(
      [
        {
          toolCallId: "tc-1",
          toolName: "create_view",
          serverId: "server-1",
          status: "rendered",
          elapsedMs: 50,
          ts: 1,
          promptIndex: 0,
          screenshotBase64: "img",
        },
      ],
      [
        {
          toolCallId: "tc-1",
          stepIndex: 0,
          promptIndex: 0,
          action: "left_click",
          coordinateX: 1,
          coordinateY: 2,
          elapsedMs: 5,
          ts: 2,
          screenshotBase64: "img2",
        },
      ],
    );
    createBrowserSessionContextMock.mockReturnValue(fake);

    await startSimulation(baseOptions());

    // Context per session, surface-scoped logging, the session's manager.
    expect(createBrowserSessionContextMock).toHaveBeenCalledTimes(1);
    expect(createBrowserSessionContextMock.mock.calls[0]![0]).toMatchObject({
      model: "anthropic/claude-haiku-4.5",
      logScope: "sessionSimulation",
    });

    // Per-turn hygiene runs BEFORE the engine; dispose runs at session end.
    expect(callOrder).toEqual([
      "setActivePromptIndex:0",
      "dismissCarriedWidget",
      "runAssistantTurn",
      "dispose",
    ]);

    // Computer tools merged into the advertised set + hooks threaded.
    const engineOpts = runAssistantTurnMock.mock.calls[0]![0] as any;
    expect(Object.keys(engineOpts.tools).sort()).toEqual([
      "computer",
      "finish_widget",
      "search",
    ]);
    expect(engineOpts.prepareAdvertisedTools).toBe(fake.prepareAdvertisedTools);
    expect(typeof engineOpts.onToolCall).toBe("function");
    expect(typeof engineOpts.onToolResult).toBe("function");
    engineOpts.onToolCall({ toolCallId: "tc-1", input: { a: 1 } });
    expect(fake.noteToolCallInput).toHaveBeenCalledWith({
      toolCallId: "tc-1",
      input: { a: 1 },
    });

    // The turn persisted, the inert snapshot capture still ran, and the
    // drained artifacts went to recordBrowserArtifacts with the turn index.
    expect(persistChatSessionToConvexMock).toHaveBeenCalledTimes(1);
    expect(captureMcpAppWidgetSnapshotsMock).toHaveBeenCalledTimes(1);
    const artifactCall = convexMutationMock.mock.calls.find(
      (c) => c[0] === "chatSessions:recordBrowserArtifacts",
    );
    expect(artifactCall).toBeDefined();
    expect(artifactCall![1]).toMatchObject({
      chatboxId: "chatbox-1",
      chatSessionId: "synth_run-1_p1_0",
      promptIndex: 0,
    });
    const payload = artifactCall![1] as any;
    // promptIndex + transient base64 are stripped from rows (the mutation
    // stamps the batch-level promptIndex; validators reject unknown keys).
    expect(payload.widgetRenderObservations).toEqual([
      {
        toolCallId: "tc-1",
        toolName: "create_view",
        serverId: "server-1",
        status: "rendered",
        elapsedMs: 50,
        ts: 1,
      },
    ]);
    expect(payload.browserInteractionSteps).toEqual([
      {
        toolCallId: "tc-1",
        stepIndex: 0,
        action: "left_click",
        coordinateX: 1,
        coordinateY: 2,
        elapsedMs: 5,
        ts: 2,
      },
    ]);
  });

  it("non-Claude drivers get no computer tools but artifacts still persist", async () => {
    const fake = buildFakeBrowserContext({ computerUse: false });
    fake._queueArtifacts(
      [
        {
          toolCallId: "tc-9",
          toolName: "create_view",
          serverId: "server-1",
          status: "bridge_timeout",
          elapsedMs: 9,
          ts: 3,
          promptIndex: 0,
        },
      ],
      [],
    );
    createBrowserSessionContextMock.mockReturnValue(fake);

    await startSimulation({
      ...baseOptions(),
      modelId: "openai/gpt-5-mini",
    });

    const engineOpts = runAssistantTurnMock.mock.calls[0]![0] as any;
    expect(Object.keys(engineOpts.tools)).toEqual(["search"]);
    expect(engineOpts.prepareAdvertisedTools).toBeUndefined();

    const artifactCall = convexMutationMock.mock.calls.find(
      (c) => c[0] === "chatSessions:recordBrowserArtifacts",
    );
    expect(artifactCall).toBeDefined();
    expect((artifactCall![1] as any).widgetRenderObservations).toHaveLength(1);
    expect((artifactCall![1] as any).browserInteractionSteps).toBeUndefined();
  });

  it("disposes the context when the turn throws (session failure path)", async () => {
    const fake = buildFakeBrowserContext({ computerUse: true });
    createBrowserSessionContextMock.mockReturnValue(fake);
    runAssistantTurnMock.mockRejectedValue(new Error("provider exploded"));

    await startSimulation(baseOptions());

    expect(fake.dispose).toHaveBeenCalledTimes(1);
    // The failed session is counted, not thrown out of the batch loop.
    expect(updateRunMock).toHaveBeenCalled();
  });

  it("skips the artifact mutation when a turn drained nothing", async () => {
    const fake = buildFakeBrowserContext({ computerUse: true });
    createBrowserSessionContextMock.mockReturnValue(fake);

    await startSimulation(baseOptions());

    expect(
      convexMutationMock.mock.calls.some(
        (c) => c[0] === "chatSessions:recordBrowserArtifacts",
      ),
    ).toBe(false);
  });
});
