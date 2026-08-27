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
      // The engine result's shape as the caller reads it — `spans` hang off
      // `turnTrace`, and omitting the trace would send the turn down its
      // cycle-failure branch. What happens after capture does not matter to
      // these tests, which assert on the options handed IN.
      return { messages: [], usage: {}, turnTrace: { spans: [] } } as never;
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

  it("forwards a PRESENT-BUT-EMPTY pinnedHarnessSkills — the A/B arm", async () => {
    // The one harness field gated on `!== undefined` rather than truthiness,
    // and deliberately so: an empty array is how `skillsOverride: "exclude"`
    // says "this arm runs with NO skills". A truthiness regression would drop
    // it, the harness would fall back to its own project-wide skill fetch, and
    // the skill-free arm would quietly run with skills — while every other
    // assertion in this file still passed.
    const options = await engineOptionsFor({
      ...HARNESS_OPTIONS,
      pinnedHarnessSkills: [],
    } as unknown as Partial<DriveHostedEvalTurnParams>);
    expect(options.pinnedHarnessSkills).toEqual([]);
  });

  it("delivers the run's pins on the FROZEN channel, not the live-environment one", async () => {
    // `selectHarnessSkillSource` ranks pinned → environment → live, and only
    // the top rank promises that nothing live is consulted. Sending a frozen
    // run's skills as `runtimeSkillsOverride` would work in the happy case and
    // be wrong in the one that matters: `runtimeSkillsOverride` is documented
    // as the channel for a turn whose environment re-resolves each time.
    const options = await engineOptionsFor({
      ...HARNESS_OPTIONS,
      pinnedHarnessSkills: [
        {
          name: "deploy",
          description: "ship it",
          content: "# Deploy",
          contentHash: "sha-1",
        },
      ],
    } as unknown as Partial<DriveHostedEvalTurnParams>);

    expect(options.pinnedHarnessSkills).toEqual([
      {
        name: "deploy",
        description: "ship it",
        content: "# Deploy",
        contentHash: "sha-1",
      },
    ]);
    expect(options.runtimeSkillsOverride).toBeUndefined();
  });

  it("forwards the host's MCP tool-CONSTRUCTION policies", async () => {
    // `runHarnessTurn` REBUILDS this turn's MCP tools instead of consuming
    // `tools`, and reads each of these off the handler options and nowhere
    // else. Dropping one does not fall back to the host's intent — it falls
    // back to the SDK's default, silently. Definedness, not truthiness:
    // `respectToolVisibility: false` IS the SEP-1865 opt-out.
    const modelVisibleMcpToolResults = { directContent: { image: false } };
    const tasks = { mode: "await" };
    const options = await engineOptionsFor({
      ...HARNESS_OPTIONS,
      modelVisibleMcpToolResults,
      respectToolVisibility: false,
      tasks,
    } as unknown as Partial<DriveHostedEvalTurnParams>);

    expect(options.modelVisibleMcpToolResults).toEqual(
      modelVisibleMcpToolResults,
    );
    expect(options.respectToolVisibility).toBe(false);
    expect(options.tasks).toEqual(tasks);
  });

  it("keeps an EMULATED turn byte-identical — none of it leaks through", async () => {
    // Every harness option is gated on the selector, so a non-harness eval
    // sends exactly what it sent before.
    //
    // The three tool-construction policies matter most here. Two of them
    // (`respectToolVisibility`, `tasks`) are read only by `runHarnessTurn`, so
    // they could not change an emulated turn even ungated — but
    // `modelVisibleMcpToolResults` IS read by the emulated loop's tool-result
    // projection, and the emulated eval tool set was already built under it by
    // `getEvalToolsForAiSdkOrThrow`. This gate is what keeps that path
    // byte-identical, so a regression that ungated it must fail here.
    const options = await engineOptionsFor({
      harnessSandboxBinding: {
        sandboxRowId: "row-1",
        sandboxId: "sbx-1",
      },
      harnessMcpProxy: { plane: "web-authorized", mode: "relay" },
      builtInTools: { web_search: {} },
      pinnedHarnessSkills: [],
      modelVisibleMcpToolResults: { directContent: { image: false } },
      respectToolVisibility: false,
      tasks: { mode: "await" },
    } as unknown as Partial<DriveHostedEvalTurnParams>);

    expect(options.harness).toBeUndefined();
    expect(options.harnessSandboxBinding).toBeUndefined();
    expect(options.harnessMcpProxy).toBeUndefined();
    expect(options.builtInTools).toBeUndefined();
    expect(options.pinnedHarnessSkills).toBeUndefined();
    expect(options.modelVisibleMcpToolResults).toBeUndefined();
    expect(options.respectToolVisibility).toBeUndefined();
    expect(options.tasks).toBeUndefined();
  });
});
