// Grading around pinned (`toolCall`) steps, driven through the REAL hosted and
// local step handlers and `executeSteps`. The case shape is a production call
// turned into a regression case: reset fixture → prompt → pinned read → a
// required assert on the read's result → advisory checks on the agent's path.
// The MCP server is a mocked client manager; the hosted backend driver is
// mocked to play the agent's prompt turn (a pinned step must never reach it).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import type { Predicate } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import { createMockMcpClientManager } from "../../../routes/mcp/__tests__/helpers/mock-mcp-client-manager.js";
import { driveHostedEvalTurn } from "../drive-hosted-eval-turn";
import type { LocalEvalTurnAcc } from "../drive-local-eval-turn";
import {
  buildHostedStepHandlers,
  buildLocalStepHandlers,
} from "../step-handlers";
import {
  createStepExecutionState,
  executeSteps,
  stepsVerdict,
  type StepExecutionState,
} from "../step-executor";

vi.mock("../drive-hosted-eval-turn", () => ({
  driveHostedEvalTurn: vi.fn(async () => ({ kind: "completed" })),
  MAX_WIDGET_FOLLOWUP_TURNS: 3,
}));

const RESET: TestStep = {
  id: "reset",
  kind: "toolCall",
  serverName: "Orders",
  toolName: "reset_orders",
  arguments: {},
};
const ASK: TestStep = { id: "ask", kind: "prompt", prompt: "Refund ord_1" };
const read = (id = "read"): TestStep => ({
  id,
  kind: "toolCall",
  serverName: "Orders",
  toolName: "get_order",
  arguments: { order_id: "ord_1" },
});
const check = (id: string, assertion: Predicate): TestStep => ({
  id,
  kind: "assert",
  assertion,
});
const REFUNDED = check("refunded", {
  type: "toolResultMatches",
  toolName: "get_order",
  path: "/refunded",
  patterns: ["^true$"],
  role: "required",
});

function order(refunded: boolean, id = "ord_1") {
  const value = { order_id: id, refunded, marker: `marker-${id}-7f3a` };
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/** The server: `get_order` answers from `reads` in order; anything else succeeds. */
function ordersServer(...reads: Array<() => unknown>) {
  return createMockMcpClientManager({
    executeTool: vi.fn(async (_server: string, toolName: string) =>
      toolName === "get_order"
        ? reads.shift()?.()
        : { content: [{ type: "text", text: `${toolName} ok` }] },
    ),
  });
}

type AgentCall = {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
};

/** The agent's prompt turn, as the backend driver leaves it on the hosted acc. */
function agentCalls(calls: AgentCall[]) {
  const sentHistories: ModelMessage[][] = [];
  vi.mocked(driveHostedEvalTurn).mockImplementation(async (params) => {
    const { acc, prompt, promptIndex } = params;
    sentHistories.push(structuredClone(acc.messageHistory));
    acc.messageHistory.push({ role: "user", content: prompt });
    calls.forEach((call, i) => {
      const toolCallId = `agent-${promptIndex}-${i}`;
      acc.messageHistory.push(
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId,
              toolName: call.toolName,
              input: call.args,
            },
          ],
        },
        // `result` is the raw MCP result a real run keeps beside the output.
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId,
              toolName: call.toolName,
              output: { type: "json", value: call.result ?? {} },
              result: call.result ?? {},
            },
          ],
        } as never,
      );
    });
    acc.messageHistory.push({ role: "assistant", content: "Refunded ord_1." });
    (acc.toolsCalledByPrompt[promptIndex] ??= []).push(
      ...calls.map((call) => ({
        toolName: call.toolName,
        arguments: call.args,
      })),
    );
    return { kind: "completed" };
  });
  return sentHistories;
}

function makeBrowser() {
  return {
    setActivePromptIndex: vi.fn(),
    setActiveAuthoredStepId: vi.fn(),
    setActiveWidgetChecks: vi.fn(),
    setKeepWidgetsMountedForSteps: vi.fn(),
    dismissCarriedWidget: vi.fn(async () => {}),
    renderPinnedToolResult: vi.fn(async () => {}),
    replayInteractStep: vi.fn(),
    evaluateWidgetAssertion: vi.fn(),
    drainFollowUps: vi.fn(() => [] as string[]),
    widgetRenderObservations: [] as never[],
  };
}

async function runHosted(
  steps: TestStep[],
  server: ReturnType<typeof ordersServer>,
  evidence?: Parameters<typeof createStepExecutionState>[0],
) {
  const acc = {
    messageHistory: [] as ModelMessage[],
    traceMessageHistory: [] as ModelMessage[],
    capturedSpans: [],
    accumulatedUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    toolsCalledByPrompt: [] as Array<Array<{ toolName: string }>>,
  };
  const browser = makeBrowser();
  const handlers = buildHostedStepHandlers({
    acc,
    browser,
    mcpClientManager: server,
    selectedServers: ["srv-1"],
    resolvePinnedServerKey: () => "srv-1",
    pinnedToolErrors: [],
    prepared: { allTools: {} },
    modelDefinition: { id: "claude-haiku-4.5", provider: "anthropic" },
    modelId: "anthropic/claude-haiku-4.5",
    evalAuthContext: { kind: "user_bearer", token: "Bearer t" },
    endpointPath: "/stream",
    maxSteps: 8,
    runStartedAt: 0,
    isAborted: () => false,
    extractToolCalls: () => [],
  } as never);
  const state = createStepExecutionState(evidence);
  const result = await executeSteps({
    steps,
    state,
    browser: browser as never,
    handlers,
  });
  return { acc, state, result };
}

async function runLocal(
  steps: TestStep[],
  server: ReturnType<typeof ordersServer>,
) {
  const acc: LocalEvalTurnAcc = {
    conversationMessages: [],
    capturedSpans: [],
    accumulatedUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    toolsCalledByPrompt: [],
    assistantMessageByPrompt: [],
    toolErrorsByPrompt: [],
    pinnedToolErrors: [],
    activePromptIndex: 0,
    activePromptInputMessages: [],
    activePartialResponseMessages: [],
    activeCompletedStepCount: 0,
    activeTraceCtx: null,
    iterationError: undefined,
    iterationErrorDetails: undefined,
    stepErrorSource: undefined,
    pinnedSetupFailure: false,
  };
  const browser = makeBrowser();
  const handlers = buildLocalStepHandlers({
    acc,
    browser,
    mcpClientManager: server,
    selectedServers: ["srv-1"],
    resolvePinnedServerKey: () => "srv-1",
    prepared: null,
    llmModel: null,
    test: { model: "gpt-4-turbo", provider: "openai" },
    runStartedAt: 0,
    runIndex: 0,
    iterationId: "iter-1",
    suiteId: "suite-1",
    runId: null,
    testCaseId: "case-1",
    abortSignal: undefined,
    toolChoice: undefined,
    extractToolCalls: () => [],
  } as never);
  const state = createStepExecutionState();
  await executeSteps({ steps, state, browser: browser as never, handlers });
  return { acc, state };
}

function resultOf(state: StepExecutionState, stepId: string) {
  const result = state.assertionResults.find((r) => r.stepId === stepId);
  expect(result, `no result for assert "${stepId}"`).toBeDefined();
  return result!;
}

beforeEach(() => {
  vi.mocked(driveHostedEvalTurn).mockReset();
  agentCalls([]);
});

describe("pinned read grading — hosted handlers + executeSteps", () => {
  it("uses the pinned server's declaration and reports its schema rejections", async () => {
    const evidence = {
      declarationsCaptured: "complete" as const,
      toolDeclarations: [
        { name: "get_order", serverKey: "srv-2", outputSchema: false },
        { name: "get_order", serverKey: "srv-1", outputSchema: true },
      ],
    };
    const steps = [read(), check("declared-schema", {
      type: "toolResultMatchesSchema",
      schema: "declared",
      toolName: "get_order",
    })];
    const valid = await runHosted(steps, ordersServer(() => order(true)), evidence);
    expect(resultOf(valid.state, "declared-schema").passed).toBe(true);
    const invalid = await runHosted(steps, ordersServer(() => {
      throw new Error('Tool "get_order" has an output schema but did not return structured content.');
    }), evidence);
    expect(resultOf(invalid.state, "declared-schema")).toMatchObject({
      passed: false,
      reason: expect.stringContaining("returned no structuredContent"),
    });
    const domainError = await runHosted(steps, ordersServer(() => ({
      ...order(true), isError: true,
    })), evidence);
    expect(resultOf(domainError.state, "declared-schema").predicateResult?.status)
      .toBe("not_applicable");
    const protocolError = await runHosted(steps, ordersServer(() => {
      throw new Error("Connection closed");
    }), evidence);
    expect(resultOf(protocolError.state, "declared-schema").predicateResult?.status)
      .toBe("error");
  });

  it("passes the required assert when the pinned read returns the expected value", async () => {
    agentCalls([{ toolName: "refund_order", args: { order_id: "ord_1" } }]);
    const server = ordersServer(() => order(true));
    const { state, result } = await runHosted(
      [
        RESET,
        ASK,
        read(),
        REFUNDED,
        check("marker", {
          type: "toolResultContains",
          toolName: "get_order",
          needle: "marker-ord_1-7f3a",
          role: "required",
        }),
      ],
      server,
    );

    expect(result.iterationError).toBeUndefined();
    expect(server.executeTool).toHaveBeenCalledWith("srv-1", "get_order", {
      order_id: "ord_1",
    });
    expect(resultOf(state, "refunded").passed).toBe(true);
    expect(resultOf(state, "marker").passed).toBe(true);
    expect(stepsVerdict(state).passed).toBe(true);
    // The read's result is kept with its step identity.
    expect(state.pinnedCalls.find((c) => c.stepId === "read")).toMatchObject({
      stepIndex: 2,
      toolName: "get_order",
      toolCallId: expect.stringMatching(/^pinned-2-/),
      result: order(true),
      isError: false,
    });
  });

  it("fails the required assert, naming the tool, when the pinned read returns a different value", async () => {
    // The agent's own read of ANOTHER order is refunded. It must not stand in
    // for the pinned read, which says ord_1 was not.
    agentCalls([
      {
        toolName: "get_order",
        args: { order_id: "ord_2" },
        result: order(true, "ord_2"),
      },
      { toolName: "refund_order", args: { order_id: "ord_1" } },
    ]);
    const { state } = await runHosted(
      [
        RESET,
        ASK,
        read(),
        REFUNDED,
        check("after", { type: "finalAssistantMessageNonEmpty" }),
      ],
      ordersServer(() => order(false)),
    );

    const refunded = resultOf(state, "refunded");
    expect(refunded.passed).toBe(false);
    expect(refunded.reason).toContain('"get_order"');
    // A real verdict on the read, not missing evidence.
    expect(refunded.predicateResult?.status).not.toBe("error");
    expect(stepsVerdict(state).passed).toBe(false);
    expect(state.skippedSteps.map((s) => s.stepId)).toEqual(["after"]);
  });

  it.each([
    [
      "returns an error result",
      () => ({
        isError: true,
        content: [{ type: "text", text: "get_order failed for ord_1" }],
      }),
    ],
    ["returns no result", () => undefined],
    [
      "throws",
      () => {
        throw new Error("connection reset while reading ord_1");
      },
    ],
  ])(
    "fails as missing evidence, never passes, when the pinned read %s",
    async (_label, answer) => {
      agentCalls([
        {
          toolName: "get_order",
          args: { order_id: "ord_1" },
          result: order(true),
        },
      ]);
      const { state, result } = await runHosted(
        [
          ASK,
          read(),
          // The error text names ord_1: grading it would pass this check.
          check("names-order", {
            type: "toolResultContains",
            toolName: "get_order",
            needle: "ord_1",
            role: "required",
          }),
        ],
        ordersServer(answer),
      );

      expect(result.iterationError).toBeUndefined();
      const named = resultOf(state, "names-order");
      expect(named.passed).toBe(false);
      expect(named.predicateResult?.status).toBe("error");
      expect(named.reason).toContain('"get_order"');
      expect(stepsVerdict(state).passed).toBe(false);
    },
  );

  it("does not let an earlier pinned read that matched rescue a final read that fails", async () => {
    agentCalls([{ toolName: "refund_order", args: { order_id: "ord_1" } }]);
    const { state } = await runHosted(
      [RESET, read("read-before"), ASK, read("read-after"), REFUNDED],
      ordersServer(
        () => order(true),
        () => order(false),
      ),
    );

    expect(resultOf(state, "refunded").passed).toBe(false);
    expect(stepsVerdict(state).passed).toBe(false);
  });

  it("grades the final pinned read when an earlier one failed", async () => {
    agentCalls([{ toolName: "refund_order", args: { order_id: "ord_1" } }]);
    const { state } = await runHosted(
      [RESET, read("read-before"), ASK, read("read-after"), REFUNDED],
      ordersServer(
        () => order(false),
        () => order(true),
      ),
    );

    expect(resultOf(state, "refunded").passed).toBe(true);
  });

  it("keeps the reset and the pinned read out of the agent-path checks", async () => {
    agentCalls([
      { toolName: "lookup_order", args: { order_id: "ord_1" } },
      { toolName: "refund_order", args: { order_id: "ord_1" } },
    ]);
    const advisory = { role: "advisory", severity: "warn" } as const;
    const { state } = await runHosted(
      [
        RESET,
        ASK,
        read(),
        REFUNDED,
        check("first", {
          type: "firstToolWas",
          toolName: "lookup_order",
          ...advisory,
        }),
        check("refund", {
          type: "toolCalledAtLeastOnce",
          toolName: "refund_order",
          ...advisory,
        }),
        check("agent-read", {
          type: "toolCalledAtLeastOnce",
          toolName: "get_order",
          ...advisory,
        }),
        check("agent-reset", {
          type: "toolCalledAtLeastOnce",
          toolName: "reset_orders",
          ...advisory,
        }),
      ],
      ordersServer(() => order(true)),
    );

    // The transcript still records every call, fixtures included...
    expect(state.toolCalls.map((c) => c.toolName)).toEqual([
      "reset_orders",
      "lookup_order",
      "refund_order",
      "get_order",
    ]);
    // ...but the agent's path starts at its own first call,
    expect(resultOf(state, "first").passed).toBe(true);
    expect(resultOf(state, "refund").passed).toBe(true);
    // and the fixture calls are not the agent's.
    expect(resultOf(state, "agent-read")).toMatchObject({
      passed: false,
      reason: 'tool "get_order" was never called',
    });
    expect(resultOf(state, "agent-reset").passed).toBe(false);
    // Advisory misses never fail the iteration.
    expect(stepsVerdict(state).passed).toBe(true);
  });

  it("still reads the agent's own results for a tool the case did not pin", async () => {
    agentCalls([
      {
        toolName: "refund_order",
        args: { order_id: "ord_1" },
        result: { content: [{ type: "text", text: "refund re_42 issued" }] },
      },
    ]);
    const { state } = await runHosted(
      [
        RESET,
        ASK,
        read(),
        check("refund-result", {
          type: "toolResultContains",
          toolName: "refund_order",
          needle: "re_42",
        }),
      ],
      ordersServer(() => order(true)),
    );

    expect(resultOf(state, "refund-result").passed).toBe(true);
  });

  it("keeps the history sent to the backend text-only after a pinned read", async () => {
    const sentHistories = agentCalls([
      { toolName: "refund_order", args: { order_id: "ord_1" } },
    ]);
    const { acc, state } = await runHosted(
      [RESET, read(), ASK],
      ordersServer(() => order(true)),
    );

    const pinnedPairs = [
      { role: "user", content: 'Pinned tool call: reset_orders on "Orders"' },
      { role: "assistant", content: "Pinned tool call reset_orders executed" },
      { role: "user", content: 'Pinned tool call: get_order on "Orders"' },
      { role: "assistant", content: "Pinned tool call get_order executed" },
    ];
    expect(sentHistories).toEqual([pinnedPairs]);
    expect(acc.traceMessageHistory.slice(0, 4)).toEqual(pinnedPairs);
    // The result reached grading anyway, beside the transcript.
    expect(state.pinnedCalls.map((c) => c.toolName)).toEqual([
      "reset_orders",
      "get_order",
    ]);
    expect(state.pinnedCalls[1]!.result).toEqual(order(true));
  });
});

describe("pinned read grading — local handlers + executeSteps", () => {
  const steps = [RESET, read(), REFUNDED];
  const withoutCallIds = (state: StepExecutionState) =>
    state.pinnedCalls.map(({ toolCallId, ...rest }) => ({
      ...rest,
      toolCallId: toolCallId?.replace(/-\d+$/, ""),
    }));

  it.each([true, false])(
    "records the same evidence and verdict as the hosted path (refunded: %s)",
    async (refunded) => {
      const local = await runLocal(
        steps,
        ordersServer(() => order(refunded)),
      );
      const hosted = await runHosted(
        steps,
        ordersServer(() => order(refunded)),
      );

      expect(resultOf(local.state, "refunded").passed).toBe(refunded);
      expect(withoutCallIds(local.state)).toEqual(withoutCallIds(hosted.state));
      expect(local.state.assertionResults).toEqual(
        hosted.state.assertionResults,
      );
      // The local transcript keeps the same text-only pinned pair.
      expect(
        local.acc.conversationMessages.every(
          (m) => typeof m.content === "string",
        ),
      ).toBe(true);
    },
  );
});
