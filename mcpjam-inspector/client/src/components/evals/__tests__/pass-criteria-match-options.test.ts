import { describe, it, expect } from "vitest";
import { computeIterationPassed } from "../pass-criteria";
import type { EvalIteration } from "../types";

const tc = (toolName: string, args: Record<string, unknown> = {}) => ({
  toolName,
  arguments: args,
});

function makeIteration(
  overrides: Partial<EvalIteration> & {
    expected?: ReturnType<typeof tc>[];
    actual?: ReturnType<typeof tc>[];
    matchOptions?: EvalIteration["testCaseSnapshot"] extends infer S
      ? S extends { matchOptions?: infer M }
        ? M
        : never
      : never;
    isNegativeTest?: boolean;
  } = {},
): EvalIteration {
  const {
    expected = [],
    actual = [],
    matchOptions,
    isNegativeTest,
    ...rest
  } = overrides;
  return {
    _id: "iter-1",
    createdBy: "user-1",
    createdAt: 0,
    iterationNumber: 1,
    updatedAt: 0,
    status: "completed",
    result: "pending",
    actualToolCalls: actual,
    tokensUsed: 0,
    testCaseSnapshot: {
      title: "case",
      query: "q",
      provider: "openai",
      model: "gpt-4o",
      expectedToolCalls: expected,
      isNegativeTest,
      matchOptions,
    },
    ...rest,
  };
}

describe("computeIterationPassed honors snapshot matchOptions", () => {
  it("defaults preserve legacy behavior when matchOptions is absent", () => {
    // Order-agnostic, extras allowed, partial args
    const iter = makeIteration({
      expected: [tc("a"), tc("b")],
      actual: [tc("b"), tc("a"), tc("c")],
    });
    expect(computeIterationPassed(iter)).toBe(true);
  });

  it("strict order fails when actual is out of order", () => {
    const iter = makeIteration({
      expected: [tc("a"), tc("b")],
      actual: [tc("b"), tc("a")],
      matchOptions: { toolCallOrder: "strict" },
    });
    expect(computeIterationPassed(iter)).toBe(false);
  });

  it("strict order passes when actual order matches expected", () => {
    const iter = makeIteration({
      expected: [tc("a"), tc("b")],
      actual: [tc("a"), tc("b")],
      matchOptions: { toolCallOrder: "strict" },
    });
    expect(computeIterationPassed(iter)).toBe(true);
  });

  it("allowExtraToolCalls=false fails when extras are present", () => {
    const iter = makeIteration({
      expected: [tc("a")],
      actual: [tc("a"), tc("b")],
      matchOptions: { allowExtraToolCalls: false },
    });
    expect(computeIterationPassed(iter)).toBe(false);
  });

  it("allowExtraToolCalls=true (default) passes despite extras", () => {
    const iter = makeIteration({
      expected: [tc("a")],
      actual: [tc("a"), tc("b")],
      matchOptions: { allowExtraToolCalls: true },
    });
    expect(computeIterationPassed(iter)).toBe(true);
  });

  it("argumentMatching=exact fails when actual carries extra keys", () => {
    const iter = makeIteration({
      expected: [tc("save", { id: 1 })],
      actual: [tc("save", { id: 1, extra: "x" })],
      matchOptions: { argumentMatching: "exact" },
    });
    expect(computeIterationPassed(iter)).toBe(false);
  });

  it("argumentMatching=ignore passes regardless of arg values", () => {
    const iter = makeIteration({
      expected: [tc("save", { id: 1 })],
      actual: [tc("save", { id: 999 })],
      matchOptions: { argumentMatching: "ignore" },
    });
    expect(computeIterationPassed(iter)).toBe(true);
  });

  it("argumentMatching=partial (default) tolerates extra actual keys", () => {
    const iter = makeIteration({
      expected: [tc("save", { id: 1 })],
      actual: [tc("save", { id: 1, extra: "x" })],
    });
    expect(computeIterationPassed(iter)).toBe(true);
  });

  it("strict + forbid extras + exact args combine correctly", () => {
    const matchOptions = {
      toolCallOrder: "strict" as const,
      allowExtraToolCalls: false,
      argumentMatching: "exact" as const,
    };
    const passing = makeIteration({
      expected: [tc("a", { x: 1 }), tc("b")],
      actual: [tc("a", { x: 1 }), tc("b")],
      matchOptions,
    });
    expect(computeIterationPassed(passing)).toBe(true);

    const failingOnExtra = makeIteration({
      expected: [tc("a", { x: 1 })],
      actual: [tc("a", { x: 1 }), tc("b")],
      matchOptions,
    });
    expect(computeIterationPassed(failingOnExtra)).toBe(false);
  });

  it("negative tests still pass when no tools called, regardless of options", () => {
    const iter = makeIteration({
      expected: [],
      actual: [],
      isNegativeTest: true,
      matchOptions: { toolCallOrder: "strict", allowExtraToolCalls: false },
    });
    expect(computeIterationPassed(iter)).toBe(true);
  });
});
