import { jsonSchema } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The exact options a hosted eval turn hands the engine, per route. Pinned so
 * moving the driver onto `runUnifiedAssistantTurn` provably changes nothing the
 * engine can observe: `toEqual` fails on any extra or missing defined key, and
 * the engine reads every optional field by truthiness or definedness, so an
 * `undefined`-valued key is the same as an absent one to it.
 */

const runAssistantTurnMock = vi.fn();
vi.mock("../../../utils/assistant-turn.js", () => ({
  runAssistantTurn: (...args: unknown[]) => runAssistantTurnMock(...args),
}));

import { driveHostedEvalTurn } from "../drive-hosted-eval-turn";
import type { DriveHostedEvalTurnParams } from "../drive-hosted-eval-turn";
import { HOSTED_STEP_MAX_OUTPUT_TOKENS } from "../../hosted-step-limits.js";
import type { BrowserSessionContext } from "../../browser-session-context.js";
import type { PrepareChatV2Result } from "../../../utils/chat-v2-orchestration.js";
import {
  createDiscoveryState,
  DEFAULT_TOOL_DISCOVERY_POLICY,
} from "@/shared/progressive-tool-discovery";

const manager = { id: "manager" };
const selection = {
  source: "org",
  modelId: "anthropic/claude-sonnet-4.5",
  connectionRef: { kind: "orgProvider", id: "orgprov_1" },
};

/** A browser with no page: nothing in these turns renders a widget. */
function browserWithoutWidgets(): BrowserSessionContext {
  const noWidget = async () => ({ ok: false, reason: "no widget mounted" });
  return {
    computerUseSupported: false,
    computerUseVersion: null,
    computerWidgetTools: {},
    widgetRenderObservations: [],
    browserInteractionSteps: [],
    prepareAdvertisedTools: undefined,
    scriptedCheckFailures: [],
    mountedWidgetToolName: null,
    drainFollowUps: () => [],
    getModelContext: () => undefined,
    setActivePromptIndex: vi.fn(),
    setActiveAuthoredStepId: vi.fn(),
    setActiveWidgetChecks: vi.fn(),
    flushActiveWidgetChecks: vi.fn(),
    noteToolCallInput: vi.fn(),
    handleEngineToolResult: vi.fn(async () => {}),
    handleDirectToolResultChunk: vi.fn(async () => {}),
    renderPinnedToolResult: vi.fn(async () => {}),
    replayInteractStep: noWidget,
    evaluateWidgetAssertion: noWidget,
    setKeepWidgetsMountedForSteps: vi.fn(),
    drainNewArtifacts: () => ({ observations: [], steps: [] }),
    dismissCarriedWidget: vi.fn(async () => {}),
    collectVideo: async () => null,
    dispose: async () => {},
  };
}

/** A prepared turn with no tools and progressive discovery off. */
const PREPARED: PrepareChatV2Result = {
  allTools: {},
  enhancedSystemPrompt: "sys",
  resolvedTemperature: undefined,
  scrubMessages: (messages) => messages,
  progressivePlan: {
    enabled: false,
    reasons: [],
    policy: DEFAULT_TOOL_DISCOVERY_POLICY,
    catalog: [],
    totalTokenEstimate: 0,
  },
  discoveryState: createDiscoveryState(),
  effectiveUiTools: [],
  reservedAgainstPageTools: new Set(),
};

function params(
  overrides: Partial<DriveHostedEvalTurnParams>,
): DriveHostedEvalTurnParams {
  return {
    promptIndex: 0,
    prompt: "hello",
    turnTimeoutMs: 5 * 60_000,
    browser: browserWithoutWidgets(),
    prepared: PREPARED,
    modelDefinition: { id: "m", provider: "anthropic" } as never,
    modelId: "anthropic/m",
    selectedServers: ["srv"],
    mcpClientManager: manager as never,
    evalAuthContext: { kind: "user_bearer", token: "t" },
    endpointPath: "/stream",
    extraBodyFields: undefined,
    toolChoice: undefined,
    abortSignal: undefined,
    maxSteps: 5,
    runStartedAt: Date.now(),
    isAborted: () => false,
    extractToolCalls: () => [],
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

async function engineOptions(
  overrides: Partial<DriveHostedEvalTurnParams>,
): Promise<Record<string, unknown>> {
  runAssistantTurnMock.mockImplementationOnce(
    async (options: { messages: unknown[] }) => ({
      messages: [...options.messages, { role: "assistant", content: "ok" }],
      usage: {},
      turnTrace: { spans: [] },
    }),
  );
  await driveHostedEvalTurn(params(overrides));
  expect(runAssistantTurnMock).toHaveBeenCalledTimes(1);
  return runAssistantTurnMock.mock.calls[0][0];
}

/** What every hosted eval turn hands the engine, whatever its route. */
const COMMON = {
  messages: [{ role: "user", content: "hello" }],
  modelDefinition: { id: "anthropic/m", provider: "anthropic" },
  systemPrompt: "sys",
  tools: expect.any(Object),
  selectedServerIds: ["srv"],
  mcpClientManager: manager,
  authContext: { kind: "user_bearer", token: "t" },
  progressivePlan: PREPARED.progressivePlan,
  discoveryState: PREPARED.discoveryState,
  sourceType: "eval",
  origin: "eval",
  streamSink: "none",
  persistMode: "caller",
  approvalMode: "auto-deny",
  abortSignal: expect.any(AbortSignal),
  maxSteps: 5,
  onToolCall: expect.any(Function),
  onToolResult: expect.any(Function),
  onEngineError: expect.any(Function),
  onHarnessEvidenceDecision: expect.any(Function),
};

describe("hosted eval turn engine options", () => {
  beforeEach(() => {
    runAssistantTurnMock.mockReset();
  });

  it("emulated /stream: the output ceiling and tool choice ride the body", async () => {
    expect(await engineOptions({ toolChoice: "required" })).toEqual({
      ...COMMON,
      endpointPath: "/stream",
      extraBodyFields: {
        maxOutputTokens: HOSTED_STEP_MAX_OUTPUT_TOKENS,
        toolChoice: "required",
      },
    });
  });

  it("emulated /stream/org: headers by reference, and no harness selection", async () => {
    const extraHeaders = { "x-mcpjam-benchmark-grant": "grant-1" };
    const options = await engineOptions({
      endpointPath: "/stream/org",
      extraBodyFields: { providerKey: "anthropic" },
      extraHeaders,
      modelSelection: selection as never,
    });

    expect(options).toEqual({
      ...COMMON,
      endpointPath: "/stream/org",
      extraBodyFields: {
        maxOutputTokens: HOSTED_STEP_MAX_OUTPUT_TOKENS,
        providerKey: "anthropic",
      },
      extraHeaders,
    });
    // A rotated benchmark grant is written into this object in place.
    expect(options.extraHeaders).toBe(extraHeaders);
  });

  it("harness: the selection and the harness-only fields ride along", async () => {
    const harnessFields = {
      harnessSandboxBinding: { sandboxRowId: "row-1", sandboxId: "sbx-1" },
      harnessMcpProxy: { plane: "web-authorized", mode: "relay" },
      builtInTools: { web_search: { inputSchema: jsonSchema({}) } },
      projectId: "project-1",
      environmentId: "env-1",
      evalIterationId: "iteration-1",
      requireToolApproval: true,
      pinnedHarnessSkills: [],
      respectToolVisibility: false,
    } satisfies Partial<DriveHostedEvalTurnParams>;
    const options = await engineOptions({
      harness: "claude-code",
      modelSelection: selection as never,
      ...harnessFields,
    });

    expect(options).toEqual({
      ...COMMON,
      ...harnessFields,
      endpointPath: "/stream",
      extraBodyFields: { maxOutputTokens: HOSTED_STEP_MAX_OUTPUT_TOKENS },
      harness: "claude-code",
      modelSelection: selection,
    });
  });
});
