import { describe, expect, it } from "vitest";
import { computeIterationVerdict } from "../iteration-verdict";
import type { PromptTurn } from "@/shared/prompt-turns";

// The shared post-loop verdict pipeline used by all four runner paths. These
// tests lock in the behavior that the four copies used to drift on: per-turn
// checks evaluate + merge + scope-tag, and a runner that authored per-turn
// checks but supplied no signals fails LOUDLY rather than silently dropping them.

function turn(over: Partial<PromptTurn> & { id: string }): PromptTurn {
  return { prompt: "", expectedToolCalls: [], ...over };
}

const baseInput = {
  test: {},
  toolsCalledByPrompt: [[]] as { toolName: string; arguments: Record<string, unknown> }[][],
  renderObservations: [],
  traceForGate: undefined,
  accumulatedUsage: {},
  failOnToolError: true,
} as const;

describe("computeIterationVerdict", () => {
  it("evaluates per-turn checks, scope-tags them, and merges into allPredicateResults", () => {
    const promptTurns = [
      turn({ id: "t1", prompt: "weather?", checks: [{ type: "responseContains", needle: "sunny" }] }),
    ];
    const result = computeIterationVerdict({
      ...baseInput,
      promptTurns,
      perTurnSignals: {
        kind: "captured",
        assistantMessageByPrompt: ["it is sunny today"],
        toolErrorsByPrompt: [[]],
      },
    });
    expect(result.turnCheckResults).toHaveLength(1);
    expect(result.turnCheckResults[0]).toMatchObject({
      passed: true,
      scope: { kind: "turn", promptIndex: 0 },
    });
    // case (none here) ++ per-turn
    expect(result.allPredicateResults).toEqual(result.turnCheckResults);
    // per-turn verdict surfaces on the trace summary for that turn
    expect(result.promptTraceSummaries[0].predicateResults).toHaveLength(1);
  });

  it("throws when a turn authored checks but the runner passed kind:'none'", () => {
    const promptTurns = [
      turn({ id: "t1", checks: [{ type: "responseContains", needle: "x" }] }),
    ];
    expect(() =>
      computeIterationVerdict({
        ...baseInput,
        promptTurns,
        perTurnSignals: { kind: "none" },
      }),
    ).toThrow(/per-turn checks/i);
  });

  it("does not throw for kind:'none' when no turn authored checks", () => {
    const promptTurns = [turn({ id: "t1", prompt: "hi" })];
    const result = computeIterationVerdict({
      ...baseInput,
      promptTurns,
      perTurnSignals: { kind: "none" },
    });
    expect(result.turnCheckResults).toEqual([]);
    expect(result.allPredicateResults).toEqual([]);
  });

  it("returns a NEW evaluation (does not depend on a caller-mutated object)", () => {
    const promptTurns = [turn({ id: "t1", prompt: "hi" })];
    const result = computeIterationVerdict({
      ...baseInput,
      promptTurns,
      perTurnSignals: { kind: "none" },
    });
    expect(typeof result.evaluation.passed).toBe("boolean");
    expect(result.evaluation.passed).toBe(result.passed);
  });
});
