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

/** hostedCriterionId literals pinned 2026-09-06. */
const PINNED_HOSTED_CRITERION_IDS: Record<string, string> = {
  "onlyToolsCalled — an allow-list of tools": "onlyToolsCalled-ef1d9ea3488c",
  "onlyToolsCalled — EMPTY list means no tool was called (the negative case, as a check)": "onlyToolsCalled-01ce35d01165",
  "toolCalledWith — minimal (only required fields)":
    "toolCalledWith-bb535809fe86",
  "toolCalledWith — all optional fields populated":
    "toolCalledWith-c09398c31fc9",
  "toolCalledWith — exact argumentMatching": "toolCalledWith-cefba3aab174",
  "toolCalledWith — ignore argumentMatching (args still required)":
    "toolCalledWith-4583a128cfeb",
  "toolCalledWith — partial with placeholder strings":
    "toolCalledWith-4ec7a9274dee",
  "toolCalledAtLeastOnce — minimal": "toolCalledAtLeastOnce-aef5ea86517d",
  "toolCalledAtLeastOnce — long tool name":
    "toolCalledAtLeastOnce-6c7e0df4ece0",
  "toolNeverCalled — minimal": "toolNeverCalled-8f66a240d084",
  "toolNeverCalled — long tool name": "toolNeverCalled-605ce8c81441",
  "firstToolWas — minimal": "firstToolWas-ab4db9cc6ed9",
  "firstToolWas — alternate tool name": "firstToolWas-a17d6a6f3fbc",
  "responseContains — minimal (no caseSensitive)":
    "responseContains-55e3e23f03b1",
  "responseContains — caseSensitive true": "responseContains-f4c5be13b732",
  "responseMatches — minimal regex": "responseMatches-acad91d7f657",
  "responseMatches — anchored regex": "responseMatches-0095f40480be",
  "noToolErrors — no fields beyond type": "noToolErrors-037586125822",
  "noToolErrors — second example (still no fields)":
    "noToolErrors-037586125822",
  "finalAssistantMessageNonEmpty — no fields beyond type":
    "finalAssistantMessageNonEmpty-175378843b04",
  "finalAssistantMessageNonEmpty — second example":
    "finalAssistantMessageNonEmpty-175378843b04",
  "tokenBudgetUnder — minimal": "tokenBudgetUnder-5c2d14380e24",
  "tokenBudgetUnder — large budget": "tokenBudgetUnder-d73c1738301e",
  "turnCountUnder — tight budget (strictly fewer than 3 user turns)":
    "turnCountUnder-20f83ed0ccc6",
  "turnCountUnder — loose budget": "turnCountUnder-6d441716294f",
  "widgetRendered — minimal (no toolName filter)":
    "widgetRendered-68223fde7ae1",
  "widgetRendered — with toolName filter": "widgetRendered-78fd2ef5d0e0",
  "widgetRenderLatencyUnder — minimal":
    "widgetRenderLatencyUnder-24b285bfa69e",
  "widgetRenderLatencyUnder — with toolName filter":
    "widgetRenderLatencyUnder-1dc192155096",
  "widgetNoConsoleErrors — minimal (no toolName filter)":
    "widgetNoConsoleErrors-def686b4d83a",
  "widgetNoConsoleErrors — with toolName filter":
    "widgetNoConsoleErrors-19ad36911f9d",
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
