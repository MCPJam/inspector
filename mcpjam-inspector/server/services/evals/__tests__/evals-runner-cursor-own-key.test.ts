/**
 * A Cursor eval case, from the eval runner to the harness turn.
 *
 * A Cursor host runs Cursor CLI on its own sentinel (`cursor/auto`), so every
 * case on it runs that sentinel on the customer's own Cursor account, whatever
 * model the case names. The case takes the hosted iteration and its harness
 * turn on a box, with or without "require own keys": the org's Cursor key is
 * checked at launch and at the box reserve, never as an org model connection.
 * Nothing of it is MCPJam's spend, and the session says so.
 *
 * The browser, the chat orchestration, the box and the turn itself are
 * mocked; the runner's routing, policy checks and finalize are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSelection } from "@mcpjam/sdk";

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

// The box: provisioned and released without a control plane.
const provisionBox = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true as const,
    box: { sandboxRowId: "row-1", sandboxId: "sbx-1" },
  })),
);
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

// Every case model comes back as a copy, so the runner can tell a promoted
// host model from the case's own only by the resolver's flag.
vi.mock("../harness-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../harness-admission.js")>();
  return {
    ...actual,
    resolveEvalCaseModelDefinition: (
      args: Parameters<typeof actual.resolveEvalCaseModelDefinition>[0],
    ) => {
      const resolved = actual.resolveEvalCaseModelDefinition(args);
      return { ...resolved, modelDefinition: { ...resolved.modelDefinition } };
    },
  };
});

import { runEvalSuiteWithAiSdk } from "../../evals-runner";
import {
  __resetHostedModelCatalogForTests,
  __setHostedCatalogForTests,
} from "../../hosted-model-catalog";
import { logger } from "../../../utils/logger";

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

/** The organization requires its own keys and has one Anthropic connection. */
const STRICT_ORG_CONFIG = {
  providers: [
    {
      providerKey: "anthropic",
      exportDenied: true,
      exportDeniedCode: "org_keys_required",
      policyEligibility: { eligible: true },
    },
  ],
  aiKeyPolicy: { requireOrgKeys: true },
};

const fallback = { provider: "none", model: "none" } as const;
/** An error that reads like an exhausted credit balance. */
const CREDIT_WORDS = "Insufficient credits on this account.";
const ORG_ANTHROPIC: ModelSelection = {
  modelId: "anthropic/claude-sonnet-4.5",
  source: "org",
  connectionRef: { kind: "orgProvider", id: "orgprov_anthropic_1" },
  nativeModelId: "claude-sonnet-4-5",
  fallback,
};

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
  // Cloud execution is available, so a harness case gets a box.
  vi.stubEnv("E2B_API_KEY", "test-key");
  vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", "test-secret");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "test-token");
  provisionBox.mockClear();
  assistantTurn.mockReset();
  assistantTurn.mockImplementation(async (opts: { messages: unknown[] }) => ({
    messages: [...opts.messages, { role: "assistant", content: "Done." }],
    turnTrace: { spans: [] },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __resetHostedModelCatalogForTests();
});

function runCase(
  extra: Partial<Parameters<typeof runEvalSuiteWithAiSdk>[0]> = {},
  testExtra: Record<string, unknown> = {},
) {
  const client = convexClient();
  const run = runEvalSuiteWithAiSdk({
    suiteId: "suite-1",
    runId: null,
    config: {
      tests: [
        {
          title: "Case",
          query: "Hello",
          // A per-case model is normal in evals; on a Cursor host the host's
          // own sentinel is what runs.
          model: "anthropic/claude-sonnet-4.5",
          provider: "anthropic",
          runs: 1,
          testCaseId: "case-1",
          expectedToolCalls: [],
          promptTurns: [
            { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
          ],
          ...testExtra,
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
    suiteHostConfig: { harness: "cursor", modelId: "cursor/auto" },
    ...extra,
  } as Parameters<typeof runEvalSuiteWithAiSdk>[0]);
  return { run, client };
}

/** What the runner handed the turn: the harness, the model and its bill. */
function turnOptions(call = 0) {
  return assistantTurn.mock.calls[call]![0] as {
    harness?: string;
    modelDefinition: { id: string };
    endpointPath?: string;
    extraBodyFields?: Record<string, unknown>;
    modelSelection?: unknown;
  };
}

/** The eval session rows the run wrote, one per turn. */
function traceWrites(client: ReturnType<typeof convexClient>) {
  return client.action.mock.calls
    .filter(([name]) => name === "testSuites:appendEvalTurnTrace")
    .map(([, args]) => args);
}

/** The cases the organization's AI-key policy refused, as the run logs them. */
function policyRefusals(warn: ReturnType<typeof vi.spyOn>) {
  return warn.mock.calls.filter(([message]) =>
    String(message).includes("refused by the organization AI-key policy"),
  );
}

describe("a Cursor eval case", () => {
  it("runs the harness turn on a box, on Cursor's sentinel, with the policy off", async () => {
    const { run } = runCase();
    await run;

    expect(provisionBox).toHaveBeenCalledTimes(1);
    expect(assistantTurn).toHaveBeenCalledTimes(1);
    const turn = turnOptions();
    expect(turn.harness).toBe("cursor");
    expect(turn.modelDefinition.id).toBe("cursor/auto");
  });

  it("runs on the org's Cursor key when the organization requires its own keys", async () => {
    const warn = vi.spyOn(logger, "warn");
    const { run } = runCase({ orgModelConfig: STRICT_ORG_CONFIG });
    await run;

    expect(policyRefusals(warn)).toEqual([]);
    expect(assistantTurn).toHaveBeenCalledTimes(1);
    expect(turnOptions().harness).toBe("cursor");
  });

  it("bills nothing to MCPJam and records the session as the customer's own account", async () => {
    const { run, client } = runCase({ orgModelConfig: STRICT_ORG_CONFIG });
    await run;

    // No billing target and no selection ride with the turn: the backend has
    // nothing to charge, and the harness reaches Cursor on the org's key.
    const turn = turnOptions();
    expect(turn.extraBodyFields).not.toHaveProperty("projectId");
    expect(turn.extraBodyFields).not.toHaveProperty("modelSelection");
    expect(turn.modelSelection).toBeUndefined();
    const writes = traceWrites(client);
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write).toMatchObject({
        modelId: "cursor/auto",
        modelSource: "external-account",
      });
    }
  });

  it("is never MCPJam's spend, even with its sentinel on the hosted list", async () => {
    __setHostedCatalogForTests(["cursor/auto"]);
    const { run, client } = runCase();
    await run;

    expect(assistantTurn).toHaveBeenCalledTimes(1);
    expect(turnOptions().extraBodyFields).not.toHaveProperty("projectId");
    expect(traceWrites(client)[0]).toMatchObject({
      modelSource: "external-account",
    });
  });

  it("never stops the run as if MCPJam's credits ran out", async () => {
    // The vendor's own words, which read like an exhausted MCPJam wallet.
    assistantTurn.mockRejectedValue(new Error(CREDIT_WORDS));
    const { run, client } = runCase({}, { runs: 2 });
    await run;

    // Both iterations ran their turn; none was skipped as out of credits.
    expect(assistantTurn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(client.action.mock.calls)).not.toContain(
      "Out of MCPJam credits",
    );
  });
});

describe("the other cases keep today's rules", () => {
  it("leaves a Cursor host that carries an ordinary model on that model's own rail", async () => {
    // Not the runtime's sentinel: a broken configuration, refused by admission
    // on the host's own id before a run starts and by the turn's eligibility
    // check here (mocked). It is never recorded as the customer's own account.
    const { run, client } = runCase({
      suiteHostConfig: {
        harness: "cursor",
        modelId: "anthropic/claude-sonnet-4.5",
      },
    });
    await run;

    expect(turnOptions().modelDefinition.id).toBe(
      "anthropic/claude-sonnet-4.5",
    );
    expect(traceWrites(client)[0]).toMatchObject({ modelSource: "mcpjam" });
  });

  it("bills an ordinary hosted case to MCPJam, its own model or a copy", async () => {
    __setHostedCatalogForTests(["anthropic/claude-sonnet-4.5"]);
    const { run, client } = runCase(
      { suiteHostConfig: { harness: "claude-code" } },
      {
        selection: {
          modelId: "anthropic/claude-sonnet-4.5",
          source: "hosted",
          fallback,
        },
      },
    );
    await run;

    expect(turnOptions().extraBodyFields).toMatchObject({
      projectId: "project-1",
    });
    expect(traceWrites(client)[0]).toMatchObject({ modelSource: "mcpjam" });
  });

  it("still stops a Claude Code run on the same words", async () => {
    // The control for the Cursor case: a Claude Code case can spend MCPJam
    // credits, so the same error stops its remaining iterations.
    assistantTurn.mockRejectedValue(new Error(CREDIT_WORDS));
    const { run } = runCase(
      { suiteHostConfig: { harness: "claude-code" } },
      { runs: 2, selection: ORG_ANTHROPIC },
    );
    await run;

    expect(assistantTurn).toHaveBeenCalledTimes(1);
  });

  it("still refuses a Claude Code case on an MCPJam-provided model under the policy", async () => {
    const warn = vi.spyOn(logger, "warn");
    const { run } = runCase(
      {
        orgModelConfig: STRICT_ORG_CONFIG,
        suiteHostConfig: { harness: "claude-code" },
      },
      {
        selection: {
          modelId: "anthropic/claude-sonnet-4.5",
          source: "hosted",
          fallback,
        },
      },
    );
    await run;

    expect(assistantTurn).not.toHaveBeenCalled();
    expect(policyRefusals(warn)).toEqual([
      [
        expect.any(String),
        expect.objectContaining({ code: "org_keys_required" }),
      ],
    ]);
  });
});
