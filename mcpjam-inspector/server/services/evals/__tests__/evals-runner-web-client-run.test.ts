/**
 * A web client's suite iteration that cannot read its run.
 *
 * The run's row names the owner the turns act as and the accounts the run
 * froze, so a web client iteration that cannot read it stops as a setup
 * failure before any turn reaches the vendor. Other runtimes keep the
 * best-effort read. The browser, the chat orchestration and the turn are
 * mocked; the runner's routing and finalize are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../browser-session-context", () => ({
  createBrowserSessionContext: vi.fn(async () => ({
    computerUseSupported: false,
    computerUseVersion: null,
    computerWidgetTools: {},
    viewTools: {},
    viewToolCalls: [],
    setWidgetToolCallPolicy: () => {},
    widgetRenderObservations: [],
    browserInteractionSteps: [],
    prepareAdvertisedTools: undefined,
    scriptedCheckFailures: [],
    mountedWidgetToolName: null,
    drainFollowUps: () => [],
    setActivePromptIndex: () => {},
    setActiveAuthoredStepId: () => {},
    setActiveWidgetChecks: () => {},
    flushActiveWidgetChecks: () => {},
    noteToolCallInput: () => {},
    handleEngineToolResult: async () => {},
    handleDirectToolResultChunk: async () => {},
    renderPinnedToolResult: async () => {},
    replayInteractStep: async () => ({ ok: false }),
    evaluateWidgetAssertion: async () => ({ ok: false }),
    setKeepWidgetsMountedForSteps: () => {},
    drainNewArtifacts: () => ({ observations: [], steps: [] }),
    dismissCarriedWidget: async () => {},
    collectVideo: async () => null,
    dispose: async () => {},
  })),
}));

vi.mock("../../../utils/chat-v2-orchestration", () => ({
  prepareChatV2: vi.fn(async (options: { systemPrompt?: string }) => ({
    allTools: {},
    enhancedSystemPrompt: options?.systemPrompt ?? "",
    scrubMessages: (msgs: unknown[]) => msgs,
    progressivePlan: { enabled: false },
    discoveryState: { loadedToolIds: new Set<string>(), catalogVersion: 0 },
  })),
}));

vi.mock("../../../utils/mcpjam-tool-helpers", () => ({
  serializeToolsForConvex: vi.fn(() => []),
}));

const assistantTurn = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/assistant-turn.js", () => ({
  runAssistantTurn: (...args: unknown[]) => assistantTurn(...args),
}));

import { runEvalSuiteWithAiSdk } from "../../evals-runner";

function manager() {
  return {
    getToolsForAiSdk: vi.fn(async () => ({})),
    listTools: vi.fn(async () => ({ tools: [] })),
    getAllToolAnnotations: vi.fn(() => ({})),
    hasCachedToolAnnotations: vi.fn(() => true),
    getConnectionStatus: vi.fn(() => "connected"),
    listServers: vi.fn(() => ["srv-1"]),
    getAllToolsMetadata: vi.fn(() => ({})),
    executeTool: vi.fn(),
  };
}

/** The run reads fine when the suite starts, then every iteration read fails. */
function convexClient() {
  let runReads = 0;
  return {
    query: vi.fn(async (name: string) => {
      if (name !== "testSuites:getTestSuiteRun") return null;
      runReads += 1;
      if (runReads === 1) return { status: "running", createdBy: "user-owner" };
      throw new Error("fetch failed");
    }),
    mutation: vi.fn(async () => ({})),
    action: vi.fn(async () => undefined),
  };
}

async function runCase(suiteHostConfig: Record<string, unknown>) {
  const finished: Array<Record<string, unknown>> = [];
  await runEvalSuiteWithAiSdk({
    suiteId: "suite-1",
    runId: "run-1",
    recorder: {
      startIteration: vi.fn(async () => "iter-1"),
      beginExecutionAttempt: vi.fn(async () => {}),
      finishIteration: vi.fn(async (args: Record<string, unknown>) => {
        finished.push(args);
      }),
      finalize: vi.fn(async () => {}),
    },
    config: {
      tests: [
        {
          title: "Case",
          query: "Hello",
          model: "anthropic/claude-sonnet-4.5",
          provider: "anthropic",
          runs: 1,
          testCaseId: "case-1",
          expectedToolCalls: [],
          promptTurns: [
            { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
          ],
        },
      ],
      environment: { servers: ["srv-1"] },
    },
    modelApiKeys: {},
    convexClient: convexClient(),
    convexHttpUrl: "https://example.convex.site",
    convexAuthToken: "token",
    mcpClientManager: manager(),
    orgModelConfigTarget: { projectId: "project-1" },
    harnessRuntimeVenue: "hosted",
    suiteHostConfig,
  } as unknown as Parameters<typeof runEvalSuiteWithAiSdk>[0]);
  return finished;
}

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
  assistantTurn.mockReset();
  assistantTurn.mockRejectedValue(new Error("the turn ran"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a web client iteration whose run can't be read", () => {
  it("stops as a setup failure before any turn, never as a pass", async () => {
    const finished = await runCase({ harness: "claude-web" });

    expect(assistantTurn).not.toHaveBeenCalled();
    expect(finished).toEqual([
      expect.objectContaining({
        passed: false,
        status: "setup_failed",
        error:
          "This run's web accounts couldn't be read, so this iteration stopped before any turn. Run it again.",
      }),
    ]);
  });

  it("leaves another runtime's iteration to run on the best-effort read", async () => {
    await runCase({});

    expect(assistantTurn).toHaveBeenCalled();
  });
});
