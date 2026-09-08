/**
 * Analyzer v10 — advisory exclusion, hosted engine.
 *
 * Five authoring scopes through iteration-verdict / step-executor. Every
 * cell: trial passed, no halt, stage rows identical to a run without the
 * check, exactly one advisory score row with onError: "ignore".
 */
import { describe, expect, it } from "vitest";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { deriveStageResults } from "@mcpjam/sdk/contract";
import { buildEvalIterationVerdict } from "../iteration-verdict.js";
import {
  buildHostedScoreContract,
} from "../score-rows.js";
import {
  hostedCriterionId,
  hostedPredicateScoreDefinition,
} from "../score-definitions.js";
import {
  createStepExecutionState,
  executeSteps,
  stepsVerdict,
  type StepEngineOutcome,
  type StepExecutorHandlers,
} from "../step-executor.js";
import type { TestStep } from "@/shared/steps";
import {
  deriveExpectedToolCalls,
  stepsToPromptTurns,
} from "@/shared/steps";
import { stripCheckPolicy } from "@mcpjam/sdk/predicates";
import fixtures from "../../../../../sdk/tests/fixtures/predicates-parity-fixtures.json" with { type: "json" };

const FAILING_ADVISORY: Predicate = {
  type: "responseContains",
  needle: "this text is absent",
  role: "advisory",
  severity: "warn",
};

/**
 * hostedCriterionId literals, pinned 2026-09-06 and extended with each kind.
 *
 * The pin catches the HASHER's inputs moving: an existing literal that changes
 * renames a scorer, which breaks every historical join on it. New rows are
 * added when the fixture set grows; a changed row is a bug.
 */
const PINNED_HOSTED_CRITERION_IDS: Record<string, string> = {
  "argumentsMatchToolSchema — all tools":
    "argumentsMatchToolSchema-1133950cdc56",
  "argumentsMatchToolSchema — one tool":
    "argumentsMatchToolSchema-b241a938d174",
  "finalAssistantMessageNonEmpty — no fields beyond type":
    "finalAssistantMessageNonEmpty-175378843b04",
  "firstToolWas — alternate tool name":
    "firstToolWas-a17d6a6f3fbc",
  "firstToolWas — minimal":
    "firstToolWas-ab4db9cc6ed9",
  "firstToolWas — minimal (Phase 2 NEW)":
    "firstToolWas-3f689e7534ff",
  "firstToolWas — namespaced":
    "firstToolWas-faa3941fa463",
  "noDestructiveToolCalled — minimal":
    "noDestructiveToolCalled-4d38da27d4c1",
  "noToolErrors — no fields beyond type":
    "noToolErrors-037586125822",
  "responseContains — caseSensitive true":
    "responseContains-f4c5be13b732",
  "responseContains — caseSensitive true (2)":
    "responseContains-9a40ccf7b841",
  "responseContains — minimal (no caseSensitive)":
    "responseContains-55e3e23f03b1",
  "responseMatches — anchored regex":
    "responseMatches-0095f40480be",
  "responseMatches — character class regex":
    "responseMatches-5f159fe0cbd8",
  "responseMatches — minimal regex":
    "responseMatches-acad91d7f657",
  "responseMatches — minimal regex (2)":
    "responseMatches-fab1d18c0181",
  "tokenBudgetUnder — large budget":
    "tokenBudgetUnder-d73c1738301e",
  "tokenBudgetUnder — large budget (2)":
    "tokenBudgetUnder-8b5817a6f1fc",
  "tokenBudgetUnder — minimal":
    "tokenBudgetUnder-5c2d14380e24",
  "toolCallCountUnder — all tools":
    "toolCallCountUnder-8f28c5b8530e",
  "toolCallCountUnder — one tool":
    "toolCallCountUnder-8d40f66fe2f2",
  "toolCalledAtLeastOnce — dotted tool name":
    "toolCalledAtLeastOnce-59f33db297d8",
  "toolCalledAtLeastOnce — long tool name":
    "toolCalledAtLeastOnce-6c7e0df4ece0",
  "toolCalledAtLeastOnce — minimal":
    "toolCalledAtLeastOnce-aef5ea86517d",
  "toolCalledAtLeastOnce — minimal (2)":
    "toolCalledAtLeastOnce-9afdc368e48e",
  "toolCalledBefore — minimal":
    "toolCalledBefore-32c7ea98b93d",
  "toolCalledWith — all optional fields populated":
    "toolCalledWith-c09398c31fc9",
  "toolCalledWith — exact argumentMatching":
    "toolCalledWith-cefba3aab174",
  "toolCalledWith — full (argumentMatching=partial with placeholder leaves, minCount)":
    "toolCalledWith-75853c7f2405",
  "toolCalledWith — ignore argumentMatching (args still required)":
    "toolCalledWith-4583a128cfeb",
  "toolCalledWith — minimal (no minCount)":
    "toolCalledWith-82112c464770",
  "toolCalledWith — minimal (only required fields)":
    "toolCalledWith-bb535809fe86",
  "toolCalledWith — partial with placeholder strings":
    "toolCalledWith-4ec7a9274dee",
  "toolLatencyUnder — all tools":
    "toolLatencyUnder-a6090b8a9328",
  "toolNeverCalled — long tool name":
    "toolNeverCalled-605ce8c81441",
  "toolNeverCalled — minimal":
    "toolNeverCalled-8f66a240d084",
  "toolNeverCalled — minimal (2)":
    "toolNeverCalled-1097cd0fde9f",
  "toolNeverCalled — namespaced":
    "toolNeverCalled-0405b542932e",
  "toolResultContains — case-sensitive, one tool":
    "toolResultContains-e9027a7d0d3d",
  "toolResultContains — minimal":
    "toolResultContains-25686816ee42",
  "toolResultMatchesSchema — array root (legal under 2026-07-28)":
    "toolResultMatchesSchema-48c37c32583d",
  "toolResultMatchesSchema — object root":
    "toolResultMatchesSchema-bb67e721141b",
  "toolResultSizeUnder — all tools":
    "toolResultSizeUnder-b2b683d7a85c",
  "turnCountUnder — loose budget":
    "turnCountUnder-6d441716294f",
  "turnCountUnder — tight budget (strictly fewer than 3 user turns)":
    "turnCountUnder-20f83ed0ccc6",
  "widgetNoConsoleErrors — minimal (no toolName filter)":
    "widgetNoConsoleErrors-def686b4d83a",
  "widgetNoConsoleErrors — with toolName filter":
    "widgetNoConsoleErrors-19ad36911f9d",
  "widgetRenderLatencyUnder — minimal":
    "widgetRenderLatencyUnder-24b285bfa69e",
  "widgetRenderLatencyUnder — with toolName filter":
    "widgetRenderLatencyUnder-1dc192155096",
  "widgetRendered — minimal (no toolName filter)":
    "widgetRendered-68223fde7ae1",
  "widgetRendered — with toolName filter":
    "widgetRendered-78fd2ef5d0e0",
};

function hostedBase() {
  return {
    promptTurns: [{ prompt: "hi", expectedToolCalls: [] as string[] }],
    toolsCalledByPrompt: [[] as string[]],
    isNegativeTest: false,
    matchOptions: undefined,
    turnCheckResults: [],
    effectivePredicates: undefined,
    trace: undefined,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    renderObservations: undefined,
    iterationError: undefined,
    failOnToolError: false,
    pinnedToolErrors: [],
    scriptedCheckFailures: [],
  } as unknown as Parameters<typeof buildEvalIterationVerdict>[0];
}

function makeBrowser() {
  return {
    setActivePromptIndex: () => {},
    setActiveAuthoredStepId: () => {},
    setKeepWidgetsMountedForSteps: () => {},
    replayInteractStep: async () => ({ ok: true }),
    evaluateWidgetAssertion: async () => ({ ok: true }),
    widgetRenderObservations: [],
    drainFollowUps: () => [],
  };
}

function makeHandlers(): StepExecutorHandlers {
  return {
    onPrompt: async (): Promise<StepEngineOutcome> => ({
      messages: [{ role: "assistant", content: "ok" }],
      toolCalls: [],
    }),
    onToolCall: async (): Promise<StepEngineOutcome> => ({
      messages: [{ role: "assistant", content: "tool ran" }],
      toolCalls: [],
    }),
  };
}

function stageOf(predicateResults: Parameters<typeof deriveStageResults>[0]["evidence"]["predicateResults"]) {
  return deriveStageResults({
    authored: {
      mode: "model_driven",
      expectsToolCall: false,
      assertionCount: 1,
    },
    evidence: {
      spans: [],
      prompts: [
        {
          promptIndex: 0,
          missing: [],
          unexpected: [],
          argumentMismatches: [],
          passed: true,
        },
      ],
      predicateResults,
    },
    iteration: { status: "completed" },
  });
}

function expectAdvisoryScoreRow(predicate: Predicate, passed: boolean) {
  const contract = buildHostedScoreContract({
    predicateResults: [{ predicate, passed, reason: "advisory" }],
  });
  const def = contract.evaluationConfig.definitions.find((d) =>
    d.scorerId.startsWith("predicate:")
  );
  expect(def?.role).toBe("advisory");
  expect(def?.onError).toBe("ignore");
  expect(def).not.toHaveProperty("severity");
  const bare = hostedPredicateScoreDefinition({
    predicate: stripCheckPolicy(predicate) as Predicate,
  });
  expect(def?.scorerId).toBe(bare.scorerId);
  expect(def?.implementationHash).toBe(bare.implementationHash);
  expect(
    contract.evaluationConfig.definitions.filter((d) => d.role === "advisory")
  ).toHaveLength(1);
}

describe("D9 role matrix — hosted", () => {
  it("suite default: advisory-failing effective predicate → trial passed", () => {
    const verdict = buildEvalIterationVerdict({
      ...hostedBase(),
      effectivePredicates: [FAILING_ADVISORY],
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.predicateResults).toHaveLength(1);
    expect(verdict.predicateResults[0]!.passed).toBe(false);
    const without = buildEvalIterationVerdict(hostedBase());
    expect(stageOf(verdict.predicateResults).stageResults).toEqual(
      stageOf(without.predicateResults).stageResults
    );
    expectAdvisoryScoreRow(FAILING_ADVISORY, false);
  });

  it("turn check: advisory-failing turn result → trial passed", () => {
    const verdict = buildEvalIterationVerdict({
      ...hostedBase(),
      turnCheckResults: [
        {
          predicate: FAILING_ADVISORY,
          passed: false,
          reason: "absent",
          scope: { kind: "turn", promptIndex: 0 },
        },
      ],
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.predicateResults).toHaveLength(1);
    const without = buildEvalIterationVerdict(hostedBase());
    expect(stageOf(verdict.predicateResults).stageResults).toEqual(
      stageOf(without.predicateResults).stageResults
    );
    expectAdvisoryScoreRow(FAILING_ADVISORY, false);
  });

  it("step assertion: advisory failure records and CONTINUES", async () => {
    const steps: TestStep[] = [
      { id: "p", kind: "prompt", prompt: "hi" },
      {
        id: "a1",
        kind: "assert",
        assertion: FAILING_ADVISORY,
      },
      {
        id: "a2",
        kind: "assert",
        assertion: { type: "finalAssistantMessageNonEmpty" },
      },
    ];
    const state = createStepExecutionState();
    await executeSteps({
      steps,
      state,
      browser: makeBrowser(),
      handlers: makeHandlers(),
    });
    expect(state.assertionResults).toHaveLength(2);
    expect(state.assertionResults[0]!.passed).toBe(false);
    expect(state.assertionResults[1]!.passed).toBe(true);
    expect(state.skippedSteps).toEqual([]);
    expect(stepsVerdict(state).passed).toBe(true);
    expectAdvisoryScoreRow(FAILING_ADVISORY, false);
  });

  it("case override: advisory list is the effective predicates", () => {
    const verdict = buildEvalIterationVerdict({
      ...hostedBase(),
      effectivePredicates: [FAILING_ADVISORY],
    });
    expect(verdict.passed).toBe(true);
    expectAdvisoryScoreRow(FAILING_ADVISORY, false);
  });

  it("advisory toolCalledWith is not promoted into expectedToolCalls", () => {
    const assertion: Predicate = {
      type: "toolCalledWith",
      toolName: "never_called",
      args: { args: {} },
      role: "advisory",
      severity: "warn",
    };
    const steps: TestStep[] = [
      { id: "p", kind: "prompt", prompt: "hi" },
      { id: "a", kind: "assert", assertion },
    ];
    expect(deriveExpectedToolCalls(steps)).toEqual([]);
    const turns = stepsToPromptTurns(steps);
    expect(turns[0]!.expectedToolCalls).toEqual([]);
    expect(turns[0]!.checks).toEqual([assertion]);
    const verdict = buildEvalIterationVerdict({
      ...hostedBase(),
      effectivePredicates: [assertion],
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.evaluation.expectedToolCalls ?? []).toEqual([]);
    expectAdvisoryScoreRow(assertion, false);
  });
});

describe("hostedCriterionId is stable across check policy", () => {
  const accept = (fixtures as { accept: Array<{ label: string; value: Record<string, unknown> }> }).accept.filter(
    (row) =>
      row.value &&
      typeof row.value === "object" &&
      typeof row.value.type === "string" &&
      row.value.role === undefined
  );

  it("equals the policy-bearing twin for every fixture predicate", () => {
    for (const row of accept) {
      const bare = row.value as Predicate;
      const advised = {
        ...bare,
        role: "advisory" as const,
        severity: "warn" as const,
      };
      expect(hostedCriterionId(bare)).toBe(hostedCriterionId(advised));
    }
  });

  it("pins today's ids for fixture predicates", () => {
    // Literals computed 2026-09-06 against the then-current hasher.
    // Changing one means hostedCriterionId's inputs moved.
    const pinned: Record<string, string> = {};
    const accept = (
      fixtures as { accept: Array<{ label: string; value: Record<string, unknown> }> }
    ).accept.filter(
      (row) =>
        row.value &&
        typeof row.value === "object" &&
        typeof row.value.type === "string" &&
        row.value.role === undefined
    );
    for (const row of accept) {
      pinned[row.label] = hostedCriterionId(row.value as Predicate);
    }
    expect(pinned).toEqual(PINNED_HOSTED_CRITERION_IDS);
  });
});
