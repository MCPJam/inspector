/**
 * A web client's suite iteration on the hosted runner.
 *
 * Its turn acts as the run's owner on the accounts the run froze, both read
 * from the run's row. An iteration that can't read the row, or whose row
 * names no frozen accounts, stops as a setup failure before any turn reaches
 * the vendor; one that can starts its turn
 * with no box, since a web client never has one. Other runtimes keep the
 * best-effort read. The browser, the chat orchestration and the vendor's page
 * are mocked; the runner's routing and finalize are real, and so are the turn
 * engine and the web client turn when a test lets them run.
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

// The vendor's page: everything up to it runs for real.
const vendorTurn = vi.hoisted(() => vi.fn());
vi.mock("../../web-clients/run-web-client-turn.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../web-clients/run-web-client-turn.js")
  >()),
  runWebClientTurn: (...args: unknown[]) => vendorTurn(...args),
}));

import { runEvalSuiteWithAiSdk } from "../../evals-runner";
import {
  setWebClientEnvironment,
  type WebClientEnvironment,
  type WebTurnContext,
} from "../../web-clients/web-client-environment";

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

/** The run's row: its owner and the accounts it froze at start. */
const RUN = {
  status: "running",
  createdBy: "user-owner",
  webAccountsAtRun: [
    { webAccountId: "acct-1", vendor: "claude" },
    { webAccountId: "acct-gpt", vendor: "chatgpt" },
    { webAccountId: "acct-2", vendor: "claude" },
  ],
};

/** The run reads fine when the suite starts; `failIterationReads` fails the rest. */
function convexClient(failIterationReads: boolean, run: unknown) {
  let runReads = 0;
  return {
    query: vi.fn(async (name: string) => {
      if (name !== "testSuites:getTestSuiteRun") return null;
      runReads += 1;
      if (failIterationReads && runReads > 1) throw new Error("fetch failed");
      return run;
    }),
    mutation: vi.fn(async () => ({})),
    action: vi.fn(async () => undefined),
  };
}

async function runCase(
  suiteHostConfig: Record<string, unknown>,
  {
    failIterationReads,
    run = RUN,
  }: { failIterationReads: boolean; run?: unknown },
) {
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
    convexClient: convexClient(failIterationReads, run),
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
  vendorTurn.mockReset();
});

afterEach(() => {
  setWebClientEnvironment(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a web client iteration whose run can't be read", () => {
  it("stops as a setup failure before any turn, never as a pass", async () => {
    const finished = await runCase(
      { harness: "claude-web" },
      { failIterationReads: true },
    );

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

  it("stops as a setup failure when the run froze no accounts, never on the project's default", async () => {
    const finished = await runCase(
      { harness: "claude-web" },
      {
        failIterationReads: false,
        run: { status: "running", createdBy: "user-owner" },
      },
    );

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
    await runCase({}, { failIterationReads: true });

    expect(assistantTurn).toHaveBeenCalled();
  });
});

describe("a web client iteration on the hosted runner", () => {
  it("starts its turn with no box, as the run's owner on the accounts it froze", async () => {
    const { runAssistantTurn } = await vi.importActual<
      typeof import("../../../utils/assistant-turn.js")
    >("../../../utils/assistant-turn.js");
    assistantTurn.mockImplementation(runAssistantTurn);
    const turns: WebTurnContext[] = [];
    const environment = {} as WebClientEnvironment;
    setWebClientEnvironment(async (turn) => {
      turns.push(turn);
      return environment;
    });
    vendorTurn.mockResolvedValue({
      ok: true,
      turnId: "turn-1",
      startedAt: 1,
      endedAt: 2,
      page: {
        account: { email: "owner@example.com" },
        conversation: {
          conversationId: "chat-1",
          url: "https://claude.ai/chat/chat-1",
          replyText: "Hello back",
          toolCalls: [],
        },
        approvalsAnswered: 0,
        finishedSignals: [],
        resumed: false,
      },
      toolCalls: [],
    });

    const finished = await runCase(
      { harness: "claude-web" },
      { failIterationReads: false },
    );

    expect(turns).toEqual([
      expect.objectContaining({
        runtimeId: "claude-web",
        projectId: "project-1",
        iterationId: "iter-1",
        actor: { actorUserId: "user-owner" },
        runWebAccountIds: ["acct-1", "acct-2"],
      }),
    ]);
    expect(vendorTurn).toHaveBeenCalledTimes(1);
    expect(vendorTurn.mock.calls[0]![0]).toMatchObject({
      runtimeId: "claude-web",
      projectId: "project-1",
      serverIds: ["srv-1"],
      prompt: "Hello",
      environment,
    });
    expect(finished).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
  });
});
