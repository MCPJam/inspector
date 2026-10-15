/**
 * An org-key harness eval case, from the eval runner to the turn.
 *
 * The case's saved selection names the organization's Anthropic connection
 * on a Claude Code host. It travels from the runner's org rail through the
 * hosted iteration's step-handler context and `driveHostedEvalTurn` into
 * `runAssistantTurn`, which only runs the harness on the org's key when the
 * selection arrives: without it the turn is refused as not hosted. Only the
 * engine and the local run's preparation are mocked; every layer that carries
 * the selection is real. The local venue keeps the iteration off a hosted box.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSelection } from "@mcpjam/sdk";

const localVenue = vi.hoisted(() => ({
  prepare: vi.fn(),
}));
vi.mock("../../../utils/harness/local/run-resources", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../utils/harness/local/run-resources")
  >()),
  prepareLocalHarnessRun: localVenue.prepare,
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

const MODEL = "anthropic/claude-sonnet-4.5";
const ORG_ANTHROPIC: ModelSelection = {
  modelId: MODEL,
  source: "org",
  connectionRef: { kind: "orgProvider", id: "orgprov_anthropic_1" },
  nativeModelId: "claude-sonnet-4-5",
  fallback: { provider: "none", model: "none" },
};

const TARGET = {
  machineId: "machine-1",
  runtimeId: "runtime-1",
  targetId: "target-1",
  localSessionId: "local-run-1",
};

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
  return {
    query: vi.fn(async () => ({ status: "running" })),
    mutation: vi.fn(async () => ({ iterationId: "iter-1" })),
    action: vi.fn(async (name: string) =>
      name === "testSuites:startQuickRunIteration"
        ? { iterationId: "iter-1" }
        : undefined,
    ),
  };
}

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
  localVenue.prepare.mockReset();
  localVenue.prepare.mockResolvedValue({
    target: TARGET,
    cleanup: vi.fn(async () => {}),
  });
  assistantTurn.mockReset();
  assistantTurn.mockImplementation(async (opts: { messages: unknown[] }) => ({
    messages: [...opts.messages, { role: "assistant", content: "Done." }],
    turnTrace: { spans: [] },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function runCase(
  selection: ModelSelection,
  extra: Partial<Parameters<typeof runEvalSuiteWithAiSdk>[0]> = {},
) {
  return runEvalSuiteWithAiSdk({
    suiteId: "suite-1",
    runId: null,
    config: {
      tests: [
        {
          title: "Case",
          query: "Hello",
          model: MODEL,
          provider: "anthropic",
          selection,
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
    testCaseId: "case-1",
    orgModelConfigTarget: { projectId: "project-1" },
    harnessRuntimeVenue: "local",
    suiteHostConfig: { harness: "claude-code" },
    ...extra,
  } as Parameters<typeof runEvalSuiteWithAiSdk>[0]);
}

describe("an org-key harness eval case", () => {
  it("hands the turn the saved org selection on the harness host", async () => {
    await runCase(ORG_ANTHROPIC);

    expect(localVenue.prepare).toHaveBeenCalledTimes(1);
    expect(assistantTurn).toHaveBeenCalledTimes(1);
    expect(assistantTurn.mock.calls[0]![0]).toMatchObject({
      harness: "claude-code",
      modelSelection: ORG_ANTHROPIC,
      harnessExecutionTarget: TARGET,
    });
  });
});

/**
 * "Use your keys for all AI features": the organization's own key is the only
 * key a turn may run on. A harness on its matching vendor's org connection
 * still runs; a harness on an MCPJam-provided model never starts a lease.
 */
describe("a harness eval case when the organization requires its own keys", () => {
  const STRICT_ORG_CONFIG = {
    providers: [
      {
        providerKey: "anthropic",
        exportDenied: true,
        exportDeniedCode: "org_keys_required",
        // The backend's verdict on the connection; the runner only reads it.
        policyEligibility: { eligible: true },
      },
    ],
    aiKeyPolicy: { requireOrgKeys: true },
  };

  it("still runs Claude Code on the organization's Anthropic connection", async () => {
    await runCase(ORG_ANTHROPIC, { orgModelConfig: STRICT_ORG_CONFIG });

    expect(assistantTurn).toHaveBeenCalledTimes(1);
    expect(assistantTurn.mock.calls[0]![0]).toMatchObject({
      harness: "claude-code",
      modelSelection: ORG_ANTHROPIC,
    });
  });

  it("refuses an Anthropic connection the backend calls ineligible before any lease or turn", async () => {
    await runCase(ORG_ANTHROPIC, {
      orgModelConfig: {
        ...STRICT_ORG_CONFIG,
        providers: [
          {
            ...STRICT_ORG_CONFIG.providers[0]!,
            policyEligibility: {
              eligible: false,
              code: "org_keys_required" as const,
            },
          },
        ],
      },
    }).catch(() => undefined);

    expect(localVenue.prepare).not.toHaveBeenCalled();
    expect(assistantTurn).not.toHaveBeenCalled();
  });

  it("refuses an MCPJam-provided model before any lease or turn", async () => {
    const hosted: ModelSelection = {
      modelId: MODEL,
      source: "hosted",
      fallback: { provider: "none", model: "none" },
    };
    // The refusal is recorded on the case; the run itself does not throw it.
    await runCase(hosted, { orgModelConfig: STRICT_ORG_CONFIG }).catch(
      () => undefined,
    );

    expect(localVenue.prepare).not.toHaveBeenCalled();
    expect(assistantTurn).not.toHaveBeenCalled();
  });
});
