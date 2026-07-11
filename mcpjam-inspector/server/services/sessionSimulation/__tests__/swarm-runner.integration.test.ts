/**
 * swarm-runner.integration.test.ts — drives the REAL shared host-session core
 * ({@link runSyntheticHostSession}) from the swarm runner, mocking only the
 * leaf engine (`runAssistantTurn`), the model-source resolver, the transcript
 * persist, prepareChatV2 / the browser context, and the swarm backend client.
 *
 * Proves the two swarm invariants end-to-end: (1) transcripts persist with
 * swarm attribution (`sourceType/origin: "swarm"`, `journeyRunId`, `hostId`,
 * persona tags, no chatboxId/synthesisRunId), and (2) the terminal attempt is
 * reported AFTER the transcript is persisted (persist-before-terminal), with
 * the same deterministic chatSessionId used to claim it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runAssistantTurnMock = vi.fn();
const resolveSyntheticModelSourceMock = vi.fn();
const persistChatSessionToConvexMock = vi.fn();
const prepareChatV2Mock = vi.fn();
const createBrowserSessionContextMock = vi.fn();
const reportAttemptMock = vi.fn();
const swarmPersonaNextTurnMock = vi.fn();
const heartbeatJourneyRunMock = vi.fn();

const callOrder: string[] = [];

vi.mock("../../../utils/assistant-turn.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../../utils/assistant-turn.js")>(
      "../../../utils/assistant-turn.js"
    );
  return {
    ...actual,
    runAssistantTurn: (...args: unknown[]) => runAssistantTurnMock(...args),
  };
});

vi.mock("../../../utils/org-model-config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../../utils/org-model-config.js")>(
      "../../../utils/org-model-config.js"
    );
  return {
    ...actual,
    resolveSyntheticModelSource: (...args: unknown[]) =>
      resolveSyntheticModelSourceMock(...args),
  };
});

vi.mock("../../../utils/chat-ingestion.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../../utils/chat-ingestion.js")>(
      "../../../utils/chat-ingestion.js"
    );
  return {
    ...actual,
    persistChatSessionToConvex: (...args: unknown[]) => {
      callOrder.push("persist");
      return persistChatSessionToConvexMock(...args);
    },
  };
});

vi.mock("../../../utils/chat-v2-orchestration.js", async () => {
  const actual =
    await vi.importActual<
      typeof import("../../../utils/chat-v2-orchestration.js")
    >("../../../utils/chat-v2-orchestration.js");
  return {
    ...actual,
    prepareChatV2: (...args: unknown[]) => prepareChatV2Mock(...args),
  };
});

vi.mock("../../browser-session-context.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../browser-session-context.js")>(
      "../../browser-session-context.js"
    );
  return {
    ...actual,
    createBrowserSessionContext: (...args: unknown[]) =>
      createBrowserSessionContextMock(...args),
  };
});

vi.mock("../../swarm-agent.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../swarm-agent.js")>(
      "../../swarm-agent.js"
    );
  return {
    ...actual,
    reportAttempt: (...args: unknown[]) => {
      callOrder.push(`attempt:${(args[2] as any).status}`);
      return reportAttemptMock(...args);
    },
    swarmPersonaNextTurn: (...args: unknown[]) =>
      swarmPersonaNextTurnMock(...args),
    heartbeatJourneyRun: (...args: unknown[]) => heartbeatJourneyRunMock(...args),
  };
});

import { startJourneyRun } from "../swarm-runner.js";

const TURN_TRACE = {
  turnId: "turn-1",
  promptIndex: 0,
  startedAt: 0,
  endedAt: 1,
  spans: [],
};

function fakeBrowserContext() {
  return {
    computerUseSupported: false,
    computerUseVersion: null,
    computerWidgetTools: {},
    widgetRenderObservations: [],
    browserInteractionSteps: [],
    prepareAdvertisedTools: undefined,
    setActivePromptIndex: vi.fn(),
    noteToolCallInput: vi.fn(),
    handleEngineToolResult: vi.fn(),
    handleDirectToolResultChunk: vi.fn(),
    drainNewArtifacts: vi.fn(() => ({ observations: [], steps: [] })),
    dismissCarriedWidget: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

function baseOpts() {
  return {
    runId: "run-1",
    projectId: "proj-1",
    host: {
      hostId: "host-1",
      hostName: "Host One",
      hostConfigId: "hc-1",
      modelId: "anthropic/claude-haiku-4.5",
      systemPrompt: "sys",
      requireToolApproval: false,
      serverIds: ["server-1"],
    },
    personaSnapshot: {
      personaId: "p1",
      name: "Persona One",
      role: "tester",
      notes: "",
    },
    sessionsPerHost: 1,
    maxTurns: 3,
    convexHttpUrl: "https://convex.site",
    bearer: "token",
    authHeader: "Bearer token",
    managerFactory: async () => ({
      manager: {
        hasServer: () => false,
        executeTool: vi.fn(),
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as never,
      connectedServerIds: ["server-1"],
      dispose: async () => {},
    }),
  };
}

beforeEach(() => {
  callOrder.length = 0;
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.site");
  reportAttemptMock.mockReset().mockResolvedValue(undefined);
  heartbeatJourneyRunMock.mockReset().mockResolvedValue(undefined);
  persistChatSessionToConvexMock.mockReset().mockResolvedValue(undefined);
  resolveSyntheticModelSourceMock.mockReset().mockResolvedValue({
    source: "mcpjam",
  });
  prepareChatV2Mock.mockReset().mockResolvedValue({
    allTools: { search: { description: "noop" } },
    enhancedSystemPrompt: "enhanced",
    resolvedTemperature: undefined,
    progressivePlan: undefined,
    discoveryState: undefined,
  });
  createBrowserSessionContextMock
    .mockReset()
    .mockReturnValue(fakeBrowserContext());
  // One persona user turn, then end the session.
  swarmPersonaNextTurnMock
    .mockReset()
    .mockResolvedValueOnce({ message: "hello", endSession: false })
    .mockResolvedValue({ message: "", endSession: true });
  runAssistantTurnMock.mockReset().mockImplementation(async (opts: any) => ({
    messages: [...opts.messages, { role: "assistant", content: "hi back" }],
    assistantMessages: [],
    toolCalls: [],
    toolResults: [],
    turnTrace: TURN_TRACE,
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("swarm runner — real core integration", () => {
  it("persists the transcript with swarm attribution before reporting the terminal", async () => {
    await startJourneyRun(baseOpts());

    // Transcript persisted with swarm attribution + the claim chatSessionId.
    expect(persistChatSessionToConvexMock).toHaveBeenCalled();
    const persistArgs = persistChatSessionToConvexMock.mock.calls.at(-1)![0];
    expect(persistArgs).toMatchObject({
      chatSessionId: "synth_run-1_host-1_0",
      sourceType: "swarm",
      origin: "swarm",
      journeyRunId: "run-1",
      hostId: "host-1",
      personaId: "p1",
      personaLabel: "Persona One",
      synthetic: true,
    });
    // Swarm carries no chatbox surface identifiers.
    expect(persistArgs.chatboxId).toBeUndefined();
    expect(persistArgs.synthesisRunId).toBeUndefined();

    // The hosted turn body forwarded journeyRunId (backend spend attribution).
    const turnOpts = runAssistantTurnMock.mock.calls[0]![0] as any;
    expect(turnOpts.extraBodyFields?.journeyRunId).toBe("run-1");
    expect(turnOpts.synthesisRunId).toBeUndefined();

    // Ordering: claim (running) → persist → terminal (succeeded).
    expect(callOrder).toEqual([
      "attempt:running",
      "persist",
      "attempt:succeeded",
    ]);

    // Terminal reuses the claim chatSessionId.
    const terminal = reportAttemptMock.mock.calls
      .map((c) => c[2] as any)
      .find((a) => a.status === "succeeded")!;
    expect(terminal.chatSessionId).toBe("synth_run-1_host-1_0");
  });
});
