/**
 * A HOSTED EVAL on a host-executed-delivery harness must build its MCP tools
 * under the eval host's policies — end to end, from the eval facade down to the
 * SDK call that actually constructs them.
 *
 * `run-harness-turn-host-executed-options.test.ts` pins the turn→projection
 * wiring for the CHAT routes. This file pins the leg the chat routes do not
 * exercise: `driveHostedEvalTurn` → `runAssistantTurn` → `runHarnessTurn` →
 * `projectSelectedMcpServersAsHostTools` → `MCPClientManager.getToolsForAiSdk`.
 * Only the harness sandbox/broker/agent boundary is mocked; every layer that
 * carries a policy is real.
 *
 * ## What is asserted, and why it is the observable
 *
 * `getToolsForAiSdk` refuses to resolve host-derived inputs itself ("the mode
 * is resolved by the CALLER"), so the arguments it receives ARE the tools it
 * produces: a policy that does not reach this call does not reach the model's
 * tool set, and the SDK's defaults silently take over. That is the whole
 * failure mode — no error, no log, just a Codex eval running under a policy its
 * host never chose. Asserting on this call is asserting on what the harness
 * turn ends up with, one layer below where it could be faked by a pass-through.
 *
 * The `harness` cases here FAIL against 3ac4cda2c7, where the eval facade
 * forwarded none of these and the enumeration took the no-options overload.
 * The emulated case passes both before and after — it is the byte-identity
 * guard for the gate that keeps it that way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harnessState = vi.hoisted(() => ({
  session: {
    sessionId: "session-1",
    stop: vi.fn(async () => ({})),
    destroy: vi.fn(async () => {}),
  },
}));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    createSession = vi.fn(async () => harnessState.session);
    stream = vi.fn(async () => ({
      fullStream: (async function* () {
        yield { type: "finish", finishReason: "stop" };
      })(),
      text: Promise.resolve("done"),
    }));
  },
  collectHarnessAgentToolApprovalContinuations: vi.fn(() => []),
}));

vi.mock("../../../utils/harness/registry.js", () => ({
  buildBrokerDummyAuth: vi.fn(() => ({
    anthropic: {
      apiKey: "",
      authToken: "mcpjam-broker-dummy",
      baseUrl: "https://broker.example",
    },
  })),
  getHarnessAdapter: vi.fn(() => ({
    id: "codex",
    displayName: "Codex",
    defaultPermissionMode: "allow-all",
    supportsSkills: false,
    supportsNativeToolApproval: false,
    supportsHostExecutedToolApproval: false,
    supportsMcpToolApproval: false,
    // The delivery mode under test: no `.mcp.json`, so MCPJam builds the
    // model-facing MCP tools itself instead of consuming `tools`.
    mcpDelivery: "host-executed",
    supportsModel: vi.fn(() => true),
    createHarness: vi.fn(() => ({ harnessId: "codex" })),
    parseToolName: vi.fn((toolName: string) => ({ toolName })),
  })),
}));

vi.mock("../../../utils/harness/resolve-sandbox.js", () => ({
  resolveHarnessSandbox: vi.fn(async () => ({
    computerId: "computer-1",
    sandboxId: "sandbox-1",
  })),
}));

vi.mock("../../../utils/harness/e2b-sandbox-provider.js", () => ({
  createE2BHarnessSandboxProvider: vi.fn(() => ({ sandboxId: "sandbox-1" })),
}));

vi.mock("../../../utils/harness/runtime-skills.js", () => ({
  frontmatterSafeSkills: vi.fn((skills) => skills),
  fetchRuntimeSkills: vi.fn(async () => ({ ok: true, skills: [] })),
  skillsFingerprint: vi.fn(() => "empty-skills"),
}));

vi.mock("../../../utils/harness/reconcile-skill-dirs.js", () => ({
  reconcileSkillDirs: vi.fn(async () => {}),
}));

vi.mock("../../../utils/harness/harness-session-state.js", async (
  importOriginal
) => {
  const actual = await importOriginal<
    typeof import("../../../utils/harness/harness-session-state.js")
  >();
  return {
    ...actual,
    claimHarnessSessionState: vi.fn(async () => ({
      ok: true,
      leaseId: "lease-1",
      stateVersion: 1,
      state: null,
      fingerprintChanged: false,
    })),
    commitHarnessSessionState: vi.fn(async () => true),
    heartbeatHarnessSessionState: vi.fn(async () => "ok"),
    releaseHarnessSessionState: vi.fn(async () => {}),
  };
});

vi.mock("../../../utils/harness/harness-model-broker.js", () => ({
  reserveHarnessBox: vi.fn(async () => ({ ok: true })),
  releaseHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  revokeHarnessModelBroker: vi.fn(async () => {}),
  startHarnessModelBroker: vi.fn(async () => ({
    ok: true,
    proxyBaseUrl: "https://broker.example",
  })),
}));

import { driveHostedEvalTurn } from "../drive-hosted-eval-turn";
import type { DriveHostedEvalTurnParams } from "../drive-hosted-eval-turn";
import {
  __resetHostedModelCatalogForTests,
  __setHostedCatalogForTests,
} from "../../hosted-model-catalog.js";

const HARNESS_MODEL_ID = "openai/gpt-5";

/** The eval's authorized manager. `getToolsForAiSdk` is the assertion surface. */
function makeManager() {
  return {
    getServerConfig: vi.fn(() => ({ url: "https://srv.example/mcp" })),
    getToolsForAiSdk: vi.fn(async () => ({})),
  };
}

function baseParams(
  manager: ReturnType<typeof makeManager>,
  overrides: Partial<DriveHostedEvalTurnParams> = {}
): DriveHostedEvalTurnParams {
  const browser = {
    setActivePromptIndex: vi.fn(),
    setActiveWidgetChecks: vi.fn(),
    dismissCarriedWidget: vi.fn(async () => {}),
    computerWidgetTools: {},
    noteToolCallInput: vi.fn(),
    handleEngineToolResult: vi.fn(async () => {}),
    drainFollowUps: vi.fn(() => [] as string[]),
  };
  return {
    promptIndex: 0,
    prompt: "list the open issues",
    browser: browser as unknown as DriveHostedEvalTurnParams["browser"],
    prepared: {
      allTools: {},
      enhancedSystemPrompt: "You are Codex.",
      resolvedTemperature: undefined,
      progressivePlan: undefined,
      discoveryState: undefined,
    } as unknown as DriveHostedEvalTurnParams["prepared"],
    modelDefinition: {
      id: HARNESS_MODEL_ID,
      provider: "openai",
    } as never,
    modelId: HARNESS_MODEL_ID,
    // An eval suite always has servers — that is what makes the projection run.
    selectedServers: ["srv-a"],
    mcpClientManager: manager as never,
    evalAuthContext: { kind: "user_bearer", token: "Bearer test" },
    endpointPath: "/stream",
    extraBodyFields: undefined,
    toolChoice: undefined,
    abortSignal: undefined,
    maxSteps: 5,
    runStartedAt: Date.now(),
    isAborted: () => false,
    extractToolCalls: () => [],
    projectId: "project-1",
    harnessSandboxBinding: {
      sandboxRowId: "row-1",
      sandboxId: "sbx-1",
    } as never,
    harnessMcpProxy: { plane: "local-mcp" } as never,
    acc: {
      messageHistory: [],
      traceMessageHistory: [],
      capturedSpans: [],
      accumulatedUsage: {},
      toolsCalledByPrompt: [],
    },
    ...overrides,
  };
}

/**
 * Drive one hosted eval turn and return the options the SDK was asked to build
 * this turn's MCP tools with. `undefined` means the no-options overload — the
 * shape a DEFAULT turn must keep, and the shape the bug produced for every
 * turn.
 */
async function toolBuildOptionsFor(
  overrides: Partial<DriveHostedEvalTurnParams>
): Promise<Record<string, unknown> | undefined> {
  const manager = makeManager();
  await driveHostedEvalTurn(baseParams(manager, overrides));
  expect(manager.getToolsForAiSdk).toHaveBeenCalledTimes(1);
  const call = manager.getToolsForAiSdk.mock.calls[0] as unknown as unknown[];
  expect(call[0]).toEqual(["srv-a"]);
  return call[1] as Record<string, unknown> | undefined;
}

const MODEL_VISIBLE_POLICY = {
  directContent: { image: false },
  embeddedResources: { blob: { image: false } },
  linkedResources: { blob: { image: false } },
};

const HARNESS_PARAMS = {
  harness: "codex",
} as unknown as Partial<DriveHostedEvalTurnParams>;

describe("hosted eval on a host-executed harness builds MCP tools under the HOST's policies", () => {
  beforeEach(() => {
    vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
    // The harness arm is gated on the model being MCPJam-provided; without a
    // seeded catalog `runAssistantTurn` would surface a fallback to the
    // emulated engine and the projection would never run.
    __setHostedCatalogForTests([HARNESS_MODEL_ID]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetHostedModelCatalogForTests();
  });

  it("carries the eval host's modelVisibleMcpToolResults into the tool build", async () => {
    // THE REPORTED BUG: the eval facade dropped this, so the SDK's default
    // applied and content the eval host disabled could reach the model.
    const options = await toolBuildOptionsFor({
      ...HARNESS_PARAMS,
      modelVisibleMcpToolResults: MODEL_VISIBLE_POLICY as never,
    });
    expect(options).toMatchObject({
      modelVisibleMcpToolResults: MODEL_VISIBLE_POLICY,
    });
  });

  it("carries an explicit respectToolVisibility=false through as includeAppOnly", async () => {
    // The SEP-1865 opt-out. `false` is the meaningful value, so a truthiness
    // check anywhere on the path erases it silently.
    const options = await toolBuildOptionsFor({
      ...HARNESS_PARAMS,
      respectToolVisibility: false,
    });
    expect(options).toMatchObject({ includeAppOnly: true });
  });

  it("carries the run's resolved Tasks seam", async () => {
    // Without it a harness turn drops to the no-`_meta` path — MCP Tasks off,
    // on a run whose host turned them on.
    const tasks = { mode: "await" } as never;
    const options = await toolBuildOptionsFor({ ...HARNESS_PARAMS, tasks });
    expect(options).toMatchObject({ tasks: { mode: "await" } });
  });

  it("keeps a policy-free harness turn on the no-options overload", async () => {
    // Byte-identity guard (green before this change too): a host that set none
    // of these must still produce exactly the tools it produced before any of
    // this plumbing existed.
    expect(await toolBuildOptionsFor(HARNESS_PARAMS)).toBeUndefined();
  });
});

// `needsApproval` is deliberately absent from this projection on every surface
// (host-executed approval is `HarnessAgent`'s own `toolApproval` map, not the
// AI SDK flag). That is pinned where it is decided —
// `harness/__tests__/host-executed-mcp-tools.test.ts` and
// `run-harness-turn-host-executed-options.test.ts` — and is not re-asserted
// here: an eval that sets `requireToolApproval` on a Codex host is REFUSED by
// `harnessToolApprovalRefusalReason` before any tool is built, so this file
// could only ever test the refusal, which has its own coverage.
