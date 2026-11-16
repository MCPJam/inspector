/**
 * A harness eval case whose organization has used its native harness trial.
 *
 * The backend refuses the iteration's box before a computer boots, with the
 * trial's code. The run view opens the limit dialog from that code, so the
 * setup row has to keep it beside the sentence; a refusal with no code keeps
 * none. The browser, the chat orchestration, the box and the turn are
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

const SENTENCE =
  "This organization has used its 20 free native harness turns. Upgrade your plan to keep using them, or switch to MCPJam Harness.";

// The box: the backend's pre-check refuses it, as `evalSandboxes` does.
const provisionBox = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/harness/harness-box.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../utils/harness/harness-box.js")
    >();
  return {
    ...actual,
    acquireHarnessBox: (
      options: Parameters<typeof actual.acquireHarnessBox>[0],
    ) =>
      actual.acquireHarnessBox({
        ...options,
        provision: provisionBox,
        release: async () => {},
        touch: async () => "touched" as const,
      }),
  };
});

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

function convexClient() {
  let iterations = 0;
  return {
    query: vi.fn(async () => ({ status: "running" })),
    mutation: vi.fn(async () => ({ iterationId: "iter-1" })),
    action: vi.fn(async (name: string, _args?: unknown) =>
      name === "testSuites:startQuickRunIteration"
        ? { iterationId: `iter-${++iterations}` }
        : undefined,
    ),
  };
}

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
  vi.stubEnv("E2B_API_KEY", "test-key");
  vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", "test-secret");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "test-token");
  provisionBox.mockReset();
  provisionBox.mockResolvedValue({
    ok: false as const,
    refusal: {
      status: 409,
      error: SENTENCE,
      code: "native_harness_trial_exhausted",
    },
  });
  assistantTurn.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function runHarnessCase(client: ReturnType<typeof convexClient>) {
  await runEvalSuiteWithAiSdk({
    suiteId: "suite-1",
    runId: null,
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
    convexClient: client,
    convexHttpUrl: "https://example.convex.site",
    convexAuthToken: "token",
    mcpClientManager: manager(),
    testCaseId: "case-1",
    orgModelConfigTarget: { projectId: "project-1" },
    harnessRuntimeVenue: "hosted",
    suiteHostConfig: { harness: "claude-code" },
  } as Parameters<typeof runEvalSuiteWithAiSdk>[0]);
  return client.action.mock.calls.find(
    ([name]) => name === "testSuites:updateTestIteration",
  )?.[1];
}

describe("a harness eval case whose computer the backend refuses", () => {
  it("keeps the trial's code on the setup row, and runs no turn", async () => {
    const setupRow = await runHarnessCase(convexClient());

    expect(provisionBox).toHaveBeenCalledTimes(1);
    expect(assistantTurn).not.toHaveBeenCalled();
    expect(setupRow).toMatchObject({
      status: "setup_failed",
      error: `Could not provision the eval's reproducible sandbox: ${SENTENCE}`,
      errorDetails: JSON.stringify({ code: "native_harness_trial_exhausted" }),
    });
  });

  // A project with no organization gets a plain 400 with no code: an
  // ordinary setup error, which the run view shows as one.
  it("stores no code for a refusal that carries none", async () => {
    const NO_ORGANIZATION =
      "This project has no organization, so it can't run a native harness. Use MCPJam Harness for its clients.";
    provisionBox.mockResolvedValue({
      ok: false as const,
      refusal: { status: 400, error: NO_ORGANIZATION },
    });

    const setupRow = await runHarnessCase(convexClient());

    expect(setupRow).toMatchObject({
      status: "setup_failed",
      error: `Could not provision the eval's reproducible sandbox: ${NO_ORGANIZATION}`,
    });
    expect(setupRow).not.toMatchObject({ errorDetails: expect.anything() });
  });
});
