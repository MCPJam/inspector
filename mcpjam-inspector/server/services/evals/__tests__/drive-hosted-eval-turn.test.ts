import { describe, expect, it, vi, beforeEach } from "vitest";

// The engine must never be reached when pre-turn setup fails — the mock
// throws a sentinel so an unexpected call fails the test loudly.
const runAssistantTurnMock = vi.fn(async () => {
  throw new Error("engine must not be reached in these tests");
});
vi.mock("../../../utils/assistant-turn.js", () => ({
  runAssistantTurn: (...args: unknown[]) => runAssistantTurnMock(...args),
}));

import { driveHostedEvalTurn } from "../drive-hosted-eval-turn";
import type { DriveHostedEvalTurnParams } from "../drive-hosted-eval-turn";

function baseParams(
  overrides: Partial<DriveHostedEvalTurnParams> = {},
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
    browser: browser as unknown as DriveHostedEvalTurnParams["browser"],
    prepared: {
      allTools: {},
      enhancedSystemPrompt: "sys",
      resolvedTemperature: undefined,
      progressivePlan: undefined,
      discoveryState: undefined,
    } as unknown as DriveHostedEvalTurnParams["prepared"],
    modelDefinition: { id: "m", provider: "anthropic" } as never,
    modelId: "m",
    selectedServers: [],
    mcpClientManager: {} as never,
    evalAuthContext: { kind: "user_bearer", token: "t" },
    endpointPath: "/x",
    extraBodyFields: undefined,
    toolChoice: undefined,
    abortSignal: undefined,
    maxSteps: 5,
    runStartedAt: Date.now(),
    isAborted: () => false,
    extractToolCalls: () => [],
    acc: {
      messageHistory: [],
      capturedSpans: [],
      accumulatedUsage: {},
      toolsCalledByPrompt: [],
    },
    ...overrides,
  };
}

describe("driveHostedEvalTurn pre-turn failure mapping (CodeRabbit, PR 2610)", () => {
  beforeEach(() => {
    runAssistantTurnMock.mockClear();
  });

  it("maps an onTurnStart throw to a failed outcome instead of escaping (engine never invoked)", async () => {
    const onTurnFailure = vi.fn();
    const params = baseParams({
      buildSinks: () => ({
        onTurnStart: () => {
          throw new Error("sse write failed");
        },
        onTurnFailure,
      }),
    });

    const outcome = await driveHostedEvalTurn(params);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.iterationError).toBe("sse write failed");
    }
    // The sinks were built before the throw, so the failure sink fires.
    expect(onTurnFailure).toHaveBeenCalledWith({
      iterationError: "sse write failed",
    });
    expect(runAssistantTurnMock).not.toHaveBeenCalled();
    // Transcript honesty: the user prompt was pushed before the failure.
    expect(params.acc.messageHistory).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("maps a dismissCarriedWidget throw to a failed outcome (sinks not yet built)", async () => {
    const params = baseParams();
    (
      params.browser as unknown as {
        dismissCarriedWidget: ReturnType<typeof vi.fn>;
      }
    ).dismissCarriedWidget.mockRejectedValue(new Error("chromium crashed"));

    const outcome = await driveHostedEvalTurn(params);

    expect(outcome).toMatchObject({
      kind: "failed",
      iterationError: "chromium crashed",
    });
    expect(runAssistantTurnMock).not.toHaveBeenCalled();
  });

  it("maps a pre-turn throw under an active abort to cancelled, not failed", async () => {
    const params = baseParams({ isAborted: () => true });
    (
      params.browser as unknown as {
        dismissCarriedWidget: ReturnType<typeof vi.fn>;
      }
    ).dismissCarriedWidget.mockRejectedValue(new Error("torn down"));

    const outcome = await driveHostedEvalTurn(params);

    expect(outcome).toEqual({ kind: "cancelled" });
    expect(runAssistantTurnMock).not.toHaveBeenCalled();
  });
});

// NOTE: widget `ui/message` follow-up driving moved OUT of driveHostedEvalTurn
// (R3 deleted its internal recursion) into the step-executor's
// `drainAndDriveFollowUps` — covered by `step-executor-followup.test.ts`.

describe("harness execution options reach the engine", () => {
  beforeEach(() => {
    runAssistantTurnMock.mockClear();
  });

  /** Capture the engine options for one turn, then stop it cheaply. */
  async function engineOptionsFor(
    overrides: Partial<DriveHostedEvalTurnParams>,
  ): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> = {};
    runAssistantTurnMock.mockImplementationOnce(async (...args: unknown[]) => {
      captured = args[0] as Record<string, unknown>;
      // Enough of a result for the turn to finish without exercising the
      // engine's own behaviour, which these tests are not about.
      return { messages: [], usage: {}, spans: [] } as never;
    });
    await driveHostedEvalTurn(baseParams(overrides)).catch(() => {});
    return captured;
  }

  const HARNESS_OPTIONS = {
    harness: "claude-code" as const,
    harnessSandboxBinding: { sandboxRowId: "row-1", sandboxId: "sbx-1" },
    harnessMcpProxy: { plane: "web-authorized", mode: "relay" },
    builtInTools: { web_search: {} },
  } as unknown as Partial<DriveHostedEvalTurnParams>;

  it("forwards the box, the proxy strategy and the built-ins", async () => {
    const options = await engineOptionsFor(HARNESS_OPTIONS);

    // ONE box per iteration: the same sandbox the tool resolver exposes as
    // `bash`, handed to the harness so it does not reserve a personal computer.
    expect(options.harnessSandboxBinding).toEqual({
      sandboxRowId: "row-1",
      sandboxId: "sbx-1",
    });
    // An eval suite always has servers, and runHarnessTurn throws without a
    // proxy strategy when any are selected.
    expect(options.harnessMcpProxy).toEqual({
      plane: "web-authorized",
      mode: "relay",
    });
    // runHarnessTurn reads built-ins off THIS field and nowhere else — passing
    // only `tools` would silently give the runtime none.
    expect(options.builtInTools).toEqual({ web_search: {} });
    expect(options.harness).toBe("claude-code");
  });

  it("keeps an EMULATED turn byte-identical — none of it leaks through", async () => {
    // Every harness option is gated on the selector, so a non-harness eval
    // sends exactly what it sent before.
    const options = await engineOptionsFor({
      harnessSandboxBinding: {
        sandboxRowId: "row-1",
        sandboxId: "sbx-1",
      },
      harnessMcpProxy: { plane: "web-authorized", mode: "relay" },
      builtInTools: { web_search: {} },
    } as unknown as Partial<DriveHostedEvalTurnParams>);

    expect(options.harness).toBeUndefined();
    expect(options.harnessSandboxBinding).toBeUndefined();
    expect(options.harnessMcpProxy).toBeUndefined();
    expect(options.builtInTools).toBeUndefined();
  });
});
