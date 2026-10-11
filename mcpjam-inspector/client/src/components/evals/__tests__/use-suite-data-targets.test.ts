import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { comparisonKey } from "@mcpjam/sdk/browser";
import { useSuiteData, useSuiteDataFromMetrics } from "../use-suite-data";
import { metricsByRunFromIterations } from "../run-metrics";
import type { EvalIteration, EvalSuite, EvalSuiteRun } from "../types";

const SONNET = "anthropic/claude-sonnet-5.5";
const selection = (reasoningEffort: "low" | "high") => ({
  modelId: SONNET,
  source: "hosted" as const,
  settings: { reasoningEffort },
  fallback: { provider: "none" as const, model: "none" as const },
});

function iteration(
  id: string,
  overrides: Partial<EvalIteration> & { effort?: "low" | "high" } = {},
): EvalIteration {
  const { effort, ...rest } = overrides;
  return {
    _id: id,
    suiteRunId: "run-1",
    testCaseId: "case-1",
    createdBy: "u1",
    createdAt: 1,
    updatedAt: 2,
    startedAt: 1,
    iterationNumber: 1,
    status: "completed",
    result: "passed",
    resultSource: "reported",
    actualToolCalls: [],
    tokensUsed: 10,
    testCaseSnapshot: {
      title: "Case",
      query: "q",
      provider: "anthropic",
      model: SONNET,
      expectedToolCalls: [],
    },
    ...(effort
      ? {
          targetKey: comparisonKey(selection(effort)),
          execution: { effectiveSettings: { reasoningEffort: effort } },
        }
      : {}),
    ...rest,
  } as EvalIteration;
}

const run = {
  _id: "run-1",
  suiteId: "s1",
  createdBy: "u1",
  runNumber: 1,
  configRevision: "r1",
  configSnapshot: { tests: [], environment: { servers: [] } },
  status: "completed",
  result: "passed",
  createdAt: 1,
} as unknown as EvalSuiteRun;

const suite = { _id: "s1" } as unknown as EvalSuite;

describe("Performance by Model keys by target", () => {
  const mixed = [
    iteration("a", { effort: "low" }),
    iteration("b", { effort: "high", result: "failed" }),
    iteration("c", { effort: "high" }),
  ];

  it("two efforts of one model are two entries with distinct labels (iterations)", () => {
    const { result } = renderHook(() =>
      useSuiteData(suite, [], [], mixed, [run], null),
    );
    expect(
      result.current.modelStats.map((row) => [
        row.model,
        row.passed,
        row.total,
      ]),
    ).toEqual([
      [`${SONNET} · High`, 1, 2],
      [`${SONNET} · Low`, 1, 1],
    ]);
  });

  it("two efforts of one model are two entries with distinct labels (metrics)", () => {
    const { result } = renderHook(() =>
      useSuiteDataFromMetrics([run], metricsByRunFromIterations(mixed)),
    );
    expect(
      result.current.modelStats.map((row) => [
        row.model,
        row.passed,
        row.total,
      ]),
    ).toEqual([
      [`${SONNET} · High`, 1, 2],
      [`${SONNET} · Low`, 1, 1],
    ]);
  });

  it("default runs read exactly as before", () => {
    const plain = [
      iteration("a"),
      iteration("b", {
        testCaseSnapshot: {
          title: "Case",
          query: "q",
          provider: "openai",
          model: "openai/gpt-5",
          expectedToolCalls: [],
        },
      }),
    ];
    const fromIterations = renderHook(() =>
      useSuiteData(suite, [], [], plain, [run], null),
    ).result.current.modelStats.map((row) => row.model);
    const fromMetrics = renderHook(() =>
      useSuiteDataFromMetrics([run], metricsByRunFromIterations(plain)),
    ).result.current.modelStats.map((row) => row.model);
    expect(fromIterations).toEqual([SONNET, "openai/gpt-5"]);
    expect(fromMetrics).toEqual([SONNET, "openai/gpt-5"]);
  });
});
