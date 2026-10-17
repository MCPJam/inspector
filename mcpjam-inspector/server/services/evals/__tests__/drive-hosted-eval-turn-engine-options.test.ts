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

const manager = { id: "manager" };
const selection = {
  source: "org",
  modelId: "anthropic/claude-sonnet-4.5",
  connectionRef: { kind: "orgProvider", id: "orgprov_1" },
};

function params(
  overrides: Partial<DriveHostedEvalTurnParams>,
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
    prompt: "hello",
    turnTimeoutMs: 5 * 60_000,
    browser: browser as unknown as DriveHostedEvalTurnParams["browser"],
    prepared: {
      allTools: {},
      enhancedSystemPrompt: "sys",
      resolvedTemperature: undefined,
      progressivePlan: undefined,
      discoveryState: undefined,
    } as unknown as DriveHostedEvalTurnParams["prepared"],
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
      builtInTools: { web_search: {} },
      projectId: "project-1",
      environmentId: "env-1",
      evalIterationId: "iteration-1",
      requireToolApproval: true,
      pinnedHarnessSkills: [],
      respectToolVisibility: false,
    };
    const options = await engineOptions({
      harness: "claude-code",
      modelSelection: selection as never,
      ...(harnessFields as Partial<DriveHostedEvalTurnParams>),
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
