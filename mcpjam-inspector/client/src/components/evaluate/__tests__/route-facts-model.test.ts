/**
 * Client adapter for route facts: catalog read, iteration mapping, copy.
 */
import { describe, expect, it } from "vitest";
import { evalCaseAggregationKey } from "@mcpjam/sdk/contract";

import type { EvalIteration, EvalSuiteRun } from "../../evals/types";
import type { EvaluateCaseRow } from "../evaluate-case-row-model";
import {
  buildRunRouteFacts,
  iterationToRouteTrial,
  mismatchLines,
  readRunToolCatalog,
  routeFactsForRow,
  routeLine,
} from "../route-facts-model";

const run = (over: Partial<EvalSuiteRun> = {}): EvalSuiteRun =>
  ({
    _id: "run_1",
    suiteId: "suite_1",
    createdBy: "u",
    runNumber: 1,
    configRevision: "cfg",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    createdAt: 1,
    ...over,
  }) as EvalSuiteRun;

const iteration = (over: Partial<EvalIteration> = {}): EvalIteration =>
  ({
    _id: "it_1",
    createdBy: "u",
    createdAt: 1,
    updatedAt: 1,
    iterationNumber: 1,
    status: "completed",
    result: "failed",
    actualToolCalls: [],
    tokensUsed: 0,
    testCaseId: "case_a",
    testCaseSnapshot: {
      title: "Look up a user",
      query: "q",
      provider: "anthropic",
      model: "claude",
      expectedToolCalls: [{ toolName: "tool_a", arguments: {} }],
    },
    ...over,
  }) as EvalIteration;

const row = (over: Partial<EvaluateCaseRow> = {}): EvaluateCaseRow =>
  ({
    key: "case_a",
    title: "Look up a user",
    testCaseId: "case_a",
    caseKey: "case_a",
    iterations: { passed: 0, total: 1 },
    verdict: { kind: "legacyRun" },
    mark: "failed",
    break: { kind: "none" },
    cells: [],
    coverage: {
      total: 1,
      loaded: 1,
      breaksByStage: {
        connection: 0,
        discovery: 0,
        selection: 0,
        call: 0,
        response: 0,
        userValue: 0,
      },
      withheld: 0,
      note: null,
    },
    p50Ms: null,
    opensIterationId: "it_1",
    diagnostic: null,
    failureGroups: [],
    ...over,
  }) as EvaluateCaseRow;

describe("readRunToolCatalog", () => {
  it("reads inline server tool names and the hash", () => {
    expect(
      readRunToolCatalog(
        run({
          toolSnapshotHash: "hash_1",
          toolSnapshot: {
            servers: [
              { tools: [{ name: "tool_a" }, { name: "tool_b" }] },
            ],
          },
        }),
      ),
    ).toEqual({
      state: "loaded",
      toolNames: ["tool_a", "tool_b"],
      hash: "hash_1",
    });
  });

  it("is notLoaded when the snapshot is absent", () => {
    expect(readRunToolCatalog(run())).toEqual({ state: "notLoaded" });
  });
});

describe("iterationToRouteTrial", () => {
  it("keys by caseKey and the snapshot variant — not the verdict key", () => {
    const trial = iterationToRouteTrial(iteration());
    expect(trial.caseVariantKey).toBe(
      evalCaseAggregationKey({
        caseId: "case_a",
        executionVariant: { model: "claude", provider: "anthropic" },
      }),
    );
    expect(trial.caseKey).toBe("case_a");
  });

  it("treats metadata.failureCategory evaluator as evaluatorErrored", () => {
    expect(
      iterationToRouteTrial(
        iteration({ metadata: { failureCategory: "evaluator" } }),
      ).evaluatorErrored,
    ).toBe(true);
  });
});

describe("copy helpers", () => {
  it("summarises an all-pass single route", () => {
    const doc = buildRunRouteFacts(
      run({
        toolSnapshot: { servers: [{ tools: [{ name: "tool_a" }, { name: "tool_b" }] }] },
      }),
      [
        iteration({
          result: "passed",
          actualToolCalls: [
            { toolName: "tool_a", arguments: {} },
            { toolName: "tool_b", arguments: {} },
          ],
          testCaseSnapshot: {
            title: "Look up a user",
            query: "q",
            provider: "anthropic",
            model: "claude",
            expectedToolCalls: [
              { toolName: "tool_a", arguments: {} },
              { toolName: "tool_b", arguments: {} },
            ],
          },
        }),
      ],
    );
    const facts = routeFactsForRow(doc, row(), [
      iteration({ result: "passed" }),
    ]);
    expect(facts).not.toBeNull();
    expect(routeLine(facts!)).toBe("1 took `tool_a→tool_b`");
  });

  it("states not-called, unexpected, substitution, and not-measured question", () => {
    const doc = buildRunRouteFacts(
      run({
        toolSnapshot: {
          servers: [{ tools: [{ name: "tool_a" }, { name: "tool_b" }] }],
        },
      }),
      [
        iteration({
          actualToolCalls: [{ toolName: "tool_b", arguments: {} }],
          testCaseSnapshot: {
            title: "Look up a user",
            query: "q",
            provider: "anthropic",
            model: "claude",
            expectedToolCalls: [{ toolName: "tool_a", arguments: {} }],
          },
        }),
      ],
    );
    const facts = doc.cases[0]!;
    expect(routeLine(facts)).toBe("1 took `tool_b`");
    expect(mismatchLines(facts, doc.catalogState)).toEqual([
      "expected `tool_a` not called in 1 of 1",
      "`tool_b` called in 1 of 1 (1 failed)",
      "`tool_b` called instead of `tool_a` in 1 trials",
      "ended with a question: not measured",
    ]);
  });

  it("labels a negative no-tool route as expected and omits mismatch copy", () => {
    const doc = buildRunRouteFacts(run(), [
      iteration({
        result: "passed",
        actualToolCalls: [],
        testCaseSnapshot: {
          title: "Do not call anything",
          query: "q",
          provider: "anthropic",
          model: "claude",
          expectedToolCalls: [{ toolName: "tool_a", arguments: {} }],
          isNegativeTest: true,
        },
      }),
    ]);
    const facts = doc.cases[0]!;
    expect(routeLine(facts)).toBe("1 called nothing (expected)");
    expect(mismatchLines(facts, doc.catalogState)).toEqual([
      "ended with a question: not measured",
    ]);
  });

  it("notes catalog-not-loaded and never classifies a substitution", () => {
    const doc = buildRunRouteFacts(run(), [
      iteration({
        actualToolCalls: [{ toolName: "tool_b", arguments: {} }],
      }),
    ]);
    expect(doc.catalogState).toBe("notLoaded");
    expect(doc.cases[0]!.mismatch).toMatchObject({
      state: "measured",
      substitutions: [],
    });
    expect(mismatchLines(doc.cases[0]!, doc.catalogState)).toContain(
      "catalog not loaded — substitutions were not classified",
    );
  });
});
