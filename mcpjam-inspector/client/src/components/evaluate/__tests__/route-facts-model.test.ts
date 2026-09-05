/**
 * Client adapter for route facts: catalog read, iteration mapping, copy.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_MISMATCH_TOOLS,
  evalCaseAggregationKey,
  type EvalRunRouteFactsCase,
} from "@mcpjam/sdk/contract";

import type { EvalIteration, EvalSuiteRun } from "../../evals/types";
import type { EvaluateCaseRow } from "../evaluate-case-row-model";
import {
  ROUTE_LINE_MAX_ROUTES,
  buildRunRouteFacts,
  iterationToRouteTrial,
  mismatchLines,
  readRunToolCatalog,
  routeFactsForRow,
  routeLine,
  routeLineForRow,
  variantLabel,
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
            servers: [{ tools: [{ name: "tool_a" }, { name: "tool_b" }] }],
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

  it("is loaded, and empty, when the snapshot is present but lists no tools", () => {
    expect(
      readRunToolCatalog(run({ toolSnapshot: { servers: [{ tools: [] }] } })),
    ).toEqual({ state: "loaded", toolNames: [] });
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
        toolSnapshot: {
          servers: [{ tools: [{ name: "tool_a" }, { name: "tool_b" }] }],
        },
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
    const facts = routeFactsForRow(doc!, row(), [
      iteration({ result: "passed" }),
    ]);
    expect(facts).toHaveLength(1);
    expect(routeLine(facts[0]!)).toBe("1 took `tool_a→tool_b`");
  });

  it("returns every variant of a row that ran on two models, labelled", () => {
    const onClaude = iteration({
      _id: "it_claude",
      result: "passed",
      actualToolCalls: [{ toolName: "tool_a", arguments: {} }],
    });
    const onGpt = iteration({
      _id: "it_gpt",
      result: "failed",
      actualToolCalls: [],
      testCaseSnapshot: {
        title: "Look up a user",
        query: "q",
        provider: "openai",
        model: "gpt",
        expectedToolCalls: [{ toolName: "tool_a", arguments: {} }],
      },
    });
    const doc = buildRunRouteFacts(run(), [onClaude, onGpt]);
    const facts = routeFactsForRow(doc!, row(), [onClaude, onGpt]);
    expect(facts).toHaveLength(2);
    expect(facts.map(variantLabel).sort()).toEqual([
      "claude (anthropic)",
      "gpt (openai)",
    ]);
    const line = routeLineForRow(facts);
    expect(line).toContain("claude (anthropic): 1 took `tool_a`");
    expect(line).toContain("gpt (openai): 1 called nothing");
    expect(line).not.toContain("\n");
  });

  it("keeps a ten-route case to one line: three routes and a count", () => {
    const iterations = Array.from({ length: 10 }, (_, index) =>
      iteration({
        _id: `it_${index}`,
        actualToolCalls: [
          { toolName: "tool_a", arguments: {} },
          { toolName: `tool_${index}`, arguments: {} },
        ],
      }),
    );
    const doc = buildRunRouteFacts(run(), iterations);
    const line = routeLine(doc!.cases[0]!);
    expect(line).not.toContain("\n");
    expect(line.match(/ took `/g)).toHaveLength(ROUTE_LINE_MAX_ROUTES);
    expect(line).toMatch(/ · 7 other routes$/);
  });

  it("adds the document's folded routes to the count when it says how many", () => {
    const iterations = Array.from({ length: 5 }, (_, index) =>
      iteration({
        _id: `it_${index}`,
        actualToolCalls: [{ toolName: `tool_${index}`, arguments: {} }],
      }),
    );
    const facts = buildRunRouteFacts(run(), iterations)!.cases[0]!;
    const other = { trials: 4, passed: 1, failed: 3 };
    const withCount = {
      ...facts,
      routes: {
        ...facts.routes,
        otherRoutes: { ...other, distinctPaths: 6 },
      },
    } as EvalRunRouteFactsCase;
    expect(routeLine(withCount)).toMatch(/ · 8 other routes$/);
    const withoutCount = {
      ...facts,
      routes: { ...facts.routes, otherRoutes: other },
    } as EvalRunRouteFactsCase;
    expect(routeLine(withoutCount)).toMatch(/ · 2\+ other routes$/);
  });

  it("names only the first tool a case looped on", () => {
    const doc = buildRunRouteFacts(run(), [
      iteration({
        _id: "it_loop",
        actualToolCalls: [
          { toolName: "tool_a", arguments: {} },
          { toolName: "tool_a", arguments: {} },
          { toolName: "tool_a", arguments: {} },
          { toolName: "tool_b", arguments: {} },
          { toolName: "tool_b", arguments: {} },
          { toolName: "tool_b", arguments: {} },
        ],
      }),
    ]);
    const facts = doc!.cases[0]!;
    if (facts.routes.loopedOn.length < 2) {
      // The document folds repeats before this rule can bite; nothing to cap.
      expect(routeLine(facts).match(/looped on/g)?.length ?? 0).toBeLessThan(2);
      return;
    }
    expect(routeLine(facts).match(/looped on/g)).toHaveLength(1);
  });

  it("returns null instead of throwing when the contract rejects the run", () => {
    // An empty run id fails the document's `runId: min(1)` rule.
    expect(
      buildRunRouteFacts(run({ _id: "" as never }), [iteration()]),
    ).toBeNull();
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
    const facts = doc!.cases[0]!;
    expect(facts.mismatch).toMatchObject({ gradeableTrials: 1 });
    expect(routeLine(facts)).toBe("1 took `tool_b`");
    expect(mismatchLines(facts, doc!.catalogState)).toEqual([
      "expected `tool_a` not called in 1 of 1",
      "`tool_b` called in 1 of 1 (1 failed)",
      "`tool_b` called instead of `tool_a` in 1 trial",
      "ended with a question: not measured",
    ]);
  });

  it("pluralizes a substitution seen more than once, and notes a capped list", () => {
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
    const facts = doc!.cases[0]!;
    if (facts.mismatch.state !== "measured")
      throw new Error("expected measured");
    const capped = {
      ...facts,
      mismatch: {
        ...facts.mismatch,
        substitutions: [{ expected: "tool_a", observed: "tool_b", trials: 2 }],
        truncated: true as const,
      },
    } as EvalRunRouteFactsCase;
    const lines = mismatchLines(capped, doc!.catalogState);
    expect(lines).toContain("`tool_b` called instead of `tool_a` in 2 trials");
    expect(lines).toContain(
      `showing the ${MAX_MISMATCH_TOOLS} most-seen tools`,
    );
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
    const facts = doc!.cases[0]!;
    expect(routeLine(facts)).toBe("1 called nothing (expected)");
    expect(mismatchLines(facts, doc!.catalogState)).toEqual([
      "ended with a question: not measured",
    ]);
  });

  it("notes catalog-not-loaded and never classifies a substitution", () => {
    const doc = buildRunRouteFacts(run(), [
      iteration({
        actualToolCalls: [{ toolName: "tool_b", arguments: {} }],
      }),
    ]);
    expect(doc!.catalogState).toBe("notLoaded");
    expect(doc!.cases[0]!.mismatch).toMatchObject({
      state: "measured",
      substitutions: [],
    });
    expect(mismatchLines(doc!.cases[0]!, doc!.catalogState)).toContain(
      "catalog not loaded — substitutions were not classified",
    );
  });
});
