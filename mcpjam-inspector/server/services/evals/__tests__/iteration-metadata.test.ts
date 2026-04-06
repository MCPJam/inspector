import { describe, expect, it } from "vitest";
import { buildIterationMetadata } from "../iteration-metadata";
import { evaluateMultiTurnResults } from "../types";

describe("buildIterationMetadata", () => {
  it("matches evaluateMultiTurnResults aggregates for positive multi-turn with an unasserted first turn", () => {
    const promptTurns = [
      {
        id: "t1",
        prompt: "Warm up",
        expectedToolCalls: [] as Array<{ toolName: string; arguments: Record<string, unknown> }>,
      },
      {
        id: "t2",
        prompt: "Fetch data",
        expectedToolCalls: [
          { toolName: "fetch", arguments: {} },
        ],
      },
    ];

    const evaluation = evaluateMultiTurnResults(promptTurns, [[], [{ toolName: "fetch", arguments: {} }]]);

    expect(evaluation.passed).toBe(true);
    expect(evaluation.missing).toHaveLength(0);
    expect(evaluation.unexpected).toHaveLength(0);
    expect(evaluation.argumentMismatches).toHaveLength(0);

    const meta = buildIterationMetadata(evaluation);
    expect(meta.missingCount).toBe(0);
    expect(meta.unexpectedCount).toBe(0);
    expect(meta.argumentMismatchCount).toBe(0);
    expect(meta.mismatchCount).toBe(0);
  });

  it("matches evaluateMultiTurnResults for negative tests when tools are called", () => {
    const promptTurns = [
      {
        id: "t1",
        prompt: "No tools",
        expectedToolCalls: [],
      },
    ];

    const evaluation = evaluateMultiTurnResults(
      promptTurns,
      [[{ toolName: "leak", arguments: {} }]],
      true,
    );

    expect(evaluation.passed).toBe(false);
    expect(evaluation.unexpected.length).toBeGreaterThan(0);

    const meta = buildIterationMetadata(evaluation);
    expect(meta.missingCount).toBe(evaluation.missing.length);
    expect(meta.unexpectedCount).toBe(evaluation.unexpected.length);
    expect(meta.argumentMismatchCount).toBe(evaluation.argumentMismatches.length);
    expect(meta.mismatchCount).toBe(
      evaluation.missing.length +
        evaluation.unexpected.length +
        evaluation.argumentMismatches.length,
    );
  });

  it("matches evaluateMultiTurnResults for a fully passing multi-turn run", () => {
    const promptTurns = [
      {
        id: "t1",
        prompt: "One",
        expectedToolCalls: [{ toolName: "a", arguments: {} }],
      },
      {
        id: "t2",
        prompt: "Two",
        expectedToolCalls: [{ toolName: "b", arguments: { x: 1 } }],
      },
    ];

    const evaluation = evaluateMultiTurnResults(promptTurns, [
      [{ toolName: "a", arguments: {} }],
      [{ toolName: "b", arguments: { x: 1 } }],
    ]);

    expect(evaluation.passed).toBe(true);

    const meta = buildIterationMetadata(evaluation);
    expect(meta.mismatchCount).toBe(0);
    expect(meta.missingCount).toBe(0);
    expect(meta.unexpectedCount).toBe(0);
    expect(meta.argumentMismatchCount).toBe(0);
  });
});
