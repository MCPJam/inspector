/**
 * Analyzer v10 — advisory exclusion.
 *
 * A Warn/Report check must never halt or fail a trial. This file pins the
 * SDK half of that matrix: five authoring scopes through EvalTest (and the
 * SDK helpers it shares with hosted), plus stage-derivation skip and
 * toolCalledWith non-promotion.
 */
import { describe, expect, it } from "vitest";
import { EvalTest } from "../src/EvalTest.js";
import { PromptResult } from "../src/PromptResult.js";
import {
  evalTestFromPlatformCase,
  resolveEffectiveChecks,
} from "../src/corpus.js";
import {
  allPredicatesPassed,
  evaluatePredicates,
  evaluateTurnChecks,
} from "../src/predicates/evaluate.js";
import { finalizePassedForEval } from "../src/eval-tool-execution.js";
import { predicateScoreDefinition } from "../src/contract/adapters.js";
import {
  STAGE_ANALYZER_VERSION,
  deriveStageResults,
  type StageAuthoredCase,
  type StageDerivationInput,
} from "../src/contract/index.js";
import type { HostRunner } from "../src/HostRunner.js";
import type { Predicate } from "../src/predicates/types.js";
import type { PlatformEvalCase } from "../src/platform/types.js";

const FAILING_ADVISORY: Predicate = {
  type: "responseContains",
  needle: "this text is absent",
  role: "advisory",
  severity: "warn",
};

const modelDrivenCase: StageAuthoredCase = {
  mode: "model_driven",
  expectsToolCall: true,
  assertionCount: 1,
};

function mockPrompt(text = "done", toolsCalled: string[] = ["search"]) {
  return PromptResult.from({
    prompt: "go",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: text },
    ],
    text,
    toolCalls: toolsCalled.map((toolName) => ({ toolName, arguments: {} })),
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    latency: { e2eMs: 10, llmMs: 8, mcpMs: 2 },
  } as never);
}

function mockAgent(text = "done", toolsCalled: string[] = ["search"]): HostRunner {
  const create = (): HostRunner => {
    let history: ReturnType<typeof mockPrompt>[] = [];
    return {
      run: async () => {
        const result = mockPrompt(text, toolsCalled);
        history.push(result);
        return result;
      },
      resetPromptHistory: () => {
        history = [];
      },
      getPromptHistory: () => [...history],
      withOptions: () => create(),
    } as unknown as HostRunner;
  };
  return create();
}

function evalCase(overrides: Partial<PlatformEvalCase> = {}): PlatformEvalCase {
  return {
    id: "case_adv",
    title: "Advisory cell",
    steps: [{ id: "s1", kind: "prompt", prompt: "go" }],
    iterations: 1,
    isNegative: false,
    models: [{ provider: "openai", model: "gpt-4o" } as never],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function derive(over: Partial<StageDerivationInput> = {}) {
  return deriveStageResults({
    authored: modelDrivenCase,
    evidence: {
      spans: [
        {
          id: "s1",
          category: "tool",
          status: "ok",
          toolName: "search",
          promptIndex: 0,
        },
      ],
      prompts: [
        {
          promptIndex: 0,
          missing: [],
          unexpected: [],
          argumentMismatches: [],
          passed: true,
        },
      ],
    },
    iteration: { status: "completed" },
    ...over,
  });
}

function advisoryScoreRows(test: EvalTest, scores: { scorerId: string; definitionHash: string }[]) {
  const config = test.getEvaluationConfigSnapshot();
  const advisory = config.definitions.filter((d) => d.role === "advisory");
  expect(advisory).toHaveLength(1);
  expect(advisory[0]!.onError).toBe("ignore");
  const row = scores.find((s) => s.scorerId === advisory[0]!.scorerId);
  expect(row).toBeDefined();
  return advisory[0]!;
}

describe("STAGE_ANALYZER_VERSION", () => {
  // 10 was advisory exclusion (the behaviour this file pins); 11 added
  // response/call routing on top of it. The exclusion tests above are the
  // real assertion — this one only keeps the constant from drifting silently.
  it("is analyzer version 11", () => {
    expect(STAGE_ANALYZER_VERSION).toBe(11);
  });
});

describe("allPredicatesPassed / finalizePassedForEval ignore advisory", () => {
  it("a failing advisory predicate does not fail the aggregate", () => {
    const results = evaluatePredicates(
      {
        toolCalls: [],
        finalAssistantMessage: "done",
      },
      [FAILING_ADVISORY]
    );
    expect(results[0]!.passed).toBe(false);
    expect(allPredicatesPassed(results)).toBe(true);
    expect(
      finalizePassedForEval({
        matchPassed: true,
        failOnToolError: false,
        predicateResults: results,
      })
    ).toBe(true);
  });

  it("a failing gating predicate still fails", () => {
    const results = evaluatePredicates(
      { toolCalls: [], finalAssistantMessage: "done" },
      [{ type: "responseContains", needle: "absent" }]
    );
    expect(allPredicatesPassed(results)).toBe(false);
    expect(
      finalizePassedForEval({
        matchPassed: true,
        failOnToolError: false,
        predicateResults: results,
      })
    ).toBe(false);
  });
});

describe("D9 role matrix — SDK (EvalTest)", () => {
  it("suite default: advisory-failing check → trial passed, one advisory score row", async () => {
    const test = new EvalTest({
      id: "c_adv_suite",
      name: "suite default",
      predicates: [FAILING_ADVISORY],
      test: async (executor) => {
        await executor.run("go");
        return true;
      },
    });
    const run = await test.run(mockAgent(), { iterations: 1 });
    const iteration = run.iterationDetails[0]!;
    expect(iteration.passed).toBe(true);
    expect(iteration.predicateResults?.[0]?.passed).toBe(false);
    advisoryScoreRows(test, iteration.scores ?? []);
  });

  it("turn check: evaluateTurnChecks advisory failure does not fail the trial", () => {
    const turnResults = evaluateTurnChecks([
      {
        promptIndex: 0,
        checks: [FAILING_ADVISORY],
        transcript: { toolCalls: [], finalAssistantMessage: "done" },
      },
    ]);
    expect(turnResults).toHaveLength(1);
    expect(turnResults[0]!.passed).toBe(false);
    expect(turnResults[0]!.scope).toEqual({ kind: "turn", promptIndex: 0 });
    expect(allPredicatesPassed(turnResults)).toBe(true);
    expect(
      finalizePassedForEval({
        matchPassed: true,
        failOnToolError: false,
        predicateResults: turnResults,
      })
    ).toBe(true);
  });

  it("step assertion: advisory assert stays a predicate; trial passed", async () => {
    const test = evalTestFromPlatformCase(
      evalCase({
        steps: [
          { id: "s1", kind: "prompt", prompt: "go" },
          { id: "s2", kind: "assert", assertion: FAILING_ADVISORY },
        ],
      })
    );
    const config = test.getConfig();
    expect(config.predicates).toEqual([FAILING_ADVISORY]);
    const run = await test.run(mockAgent(), { iterations: 1 });
    expect(run.iterationDetails[0]!.passed).toBe(true);
    advisoryScoreRows(test, run.iterationDetails[0]!.scores ?? []);
  });

  it("case override: advisory check from replace list does not fail", async () => {
    const predicates = resolveEffectiveChecks(
      { mode: "replace", list: [FAILING_ADVISORY] },
      [{ type: "noToolErrors" }],
      { caseId: "case_adv", caseTitle: "Advisory cell" }
    );
    expect(predicates).toEqual([FAILING_ADVISORY]);
    const test = new EvalTest({
      id: "c_adv_override",
      name: "case override",
      predicates,
      test: async (executor) => {
        await executor.run("go");
        return true;
      },
    });
    const run = await test.run(mockAgent(), { iterations: 1 });
    expect(run.iterationDetails[0]!.passed).toBe(true);
    advisoryScoreRows(test, run.iterationDetails[0]!.scores ?? []);
  });

  it("advisory toolCalledWith is not minted as a matcher expectation", async () => {
    const assertion: Predicate = {
      type: "toolCalledWith",
      toolName: "never_called",
      args: { args: {} },
      role: "advisory",
      severity: "warn",
    };
    const test = evalTestFromPlatformCase(
      evalCase({
        steps: [
          { id: "s1", kind: "prompt", prompt: "go" },
          { id: "s2", kind: "assert", assertion },
        ],
      })
    );
    const config = test.getConfig();
    expect(config.expectedToolCalls ?? []).toEqual([]);
    expect(config.predicates).toEqual([assertion]);
    const run = await test.run(mockAgent("done", ["search"]), { iterations: 1 });
    expect(run.iterationDetails[0]!.passed).toBe(true);
    expect(run.iterationDetails[0]!.toolMatch).toBeUndefined();
    advisoryScoreRows(test, run.iterationDetails[0]!.scores ?? []);
  });
});

describe("stage derivation skips advisory results", () => {
  const evidence = {
    spans: [
      {
        id: "s1",
        category: "tool",
        status: "ok",
        toolName: "search",
        promptIndex: 0,
      },
    ],
    prompts: [
      {
        promptIndex: 0,
        missing: [],
        unexpected: [],
        argumentMismatches: [],
        passed: true,
      },
    ],
  };

  it("userValue is identical to a run without the advisory check", () => {
    const baseline = derive({ evidence });
    const withAdvisory = derive({
      evidence: {
        ...evidence,
        predicateResults: [
          {
            passed: false,
            reason: "advisory miss",
            predicate: {
              type: "responseContains",
              role: "advisory",
            },
          },
        ],
      },
    });
    expect(withAdvisory.stageResults).toEqual(baseline.stageResults);
    expect(withAdvisory.firstFailedStage).toBe(baseline.firstFailedStage);
  });

  it("a failed advisory selection predicate does not fail selection", () => {
    const rows = derive({
      evidence: {
        spans: [
          {
            id: "s1",
            category: "tool",
            status: "ok",
            toolName: "search",
            promptIndex: 0,
          },
        ],
        prompts: [
          {
            promptIndex: 0,
            missing: [],
            unexpected: [],
            argumentMismatches: [],
            passed: true,
          },
        ],
        predicateResults: [
          {
            passed: false,
            reason: "never called",
            predicate: {
              type: "toolCalledAtLeastOnce",
              toolName: "other",
              role: "advisory",
            },
          },
        ],
      },
    });
    const baseline = derive();
    expect(rows.stageResults).toEqual(baseline.stageResults);
  });
});

describe("predicateScoreDefinition strips policy from the hash", () => {
  it("honours role and keeps implementationHash stable", () => {
    const bare: Predicate = { type: "noToolErrors" };
    const advised: Predicate = {
      type: "noToolErrors",
      role: "advisory",
      severity: "warn",
    };
    const a = predicateScoreDefinition(bare, { ordinal: 0 });
    const b = predicateScoreDefinition(advised, { ordinal: 0 });
    expect(a.scorerId).toBe(b.scorerId);
    expect(a.implementationHash).toBe(b.implementationHash);
    expect(a.role).toBe("gating");
    expect(b.role).toBe("advisory");
    expect(JSON.stringify(b)).not.toContain("severity");
  });
});
