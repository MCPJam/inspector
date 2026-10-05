import { describe, expect, it, vi } from "vitest";

// Pass-through spy on the ONE verdict boundary, so the backtest can be shown to
// grade through it rather than through the evaluators one by one.
vi.mock("../iteration-verdict", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../iteration-verdict")>();
  return {
    ...original,
    buildEvalIterationVerdict: vi.fn(original.buildEvalIterationVerdict),
  };
});

import { buildEvalIterationVerdict } from "../iteration-verdict";
import { storedTraceVerdict } from "../stored-trace-verdict";
import { backtestIteration } from "../assertion-backtest";
import type { Predicate } from "@/shared/eval-matching";

// One recorded single-turn iteration: the transcript a live run captured, and
// the calls it persisted.
const messages = [
  { role: "user", content: "find cats" },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "search",
        input: { q: "cats" },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "search",
        output: { type: "json", value: { hits: 3 } },
      },
    ],
  },
  { role: "assistant", content: "Found 3 cats." },
];
const toolCalls = [
  { toolName: "search", arguments: { q: "cats" }, toolCallId: "c1" },
];
const expectedToolCalls = [{ toolName: "search", arguments: { q: "cats" } }];
const predicates: Predicate[] = [
  { type: "responseContains", needle: "cats" },
  { type: "toolCalledAtLeastOnce", toolName: "search" },
  { type: "noToolErrors" },
  { type: "responseContains", needle: "dogs" },
];

/** The call the runner makes for this iteration (no browser, no pins). */
function liveVerdict(effectivePredicates: Predicate[]) {
  return buildEvalIterationVerdict({
    promptTurns: [{ id: "turn-1", prompt: "find cats", expectedToolCalls }],
    toolsCalledByPrompt: [toolCalls],
    isNegativeTest: false,
    matchOptions: undefined,
    skillToolsActive: false,
    turnCheckResults: [],
    effectivePredicates,
    trace: { messages: messages as never },
    usage: undefined,
    renderObservations: undefined,
    iterationError: undefined,
    failOnToolError: true,
    pinnedToolErrors: [],
    scriptedCheckFailures: [],
  });
}

describe("storedTraceVerdict", () => {
  it("decides a stored trace exactly as the live boundary decided it", () => {
    const live = liveVerdict(predicates);
    const stored = storedTraceVerdict(
      {
        query: "find cats",
        expectedToolCalls,
        actualToolCalls: toolCalls,
        isNegativeTest: false,
        messages,
      },
      { effectivePredicates: predicates },
    );
    expect(stored.passed).toBe(live.passed);
    expect(stored.passed).toBe(false);
    expect(stored.predicateResults).toEqual(live.predicateResults);
    expect(stored.evaluation.passed).toBe(live.evaluation.passed);
    expect(stored.evaluation.missing).toEqual(live.evaluation.missing);
  });

  it("keeps the gates: a recorded cycle error and a fired activity guard fail", () => {
    const base = {
      expectedToolCalls,
      actualToolCalls: toolCalls,
      messages,
    };
    expect(storedTraceVerdict(base).passed).toBe(true);
    expect(
      storedTraceVerdict({ ...base, iterationError: "turn 2 failed" }).passed,
    ).toBe(false);
    expect(
      storedTraceVerdict({
        ...base,
        agentActivity: { status: "no_agent_activity", detail: "nothing ran" },
      }).passed,
    ).toBe(false);
  });

  it("appends already-decided rows after the case rows, in the runner's order", () => {
    const turnRow = {
      predicate: { type: "noToolErrors" } as Predicate,
      passed: false,
      reason: "recorded step fact",
      scope: { kind: "turn" as const, promptIndex: 0 },
    };
    const verdict = storedTraceVerdict(
      { expectedToolCalls, actualToolCalls: toolCalls, messages },
      { effectivePredicates: [predicates[0]!], turnCheckResults: [turnRow] },
    );
    expect(verdict.predicateResults).toHaveLength(2);
    expect(verdict.predicateResults[1]).toEqual(turnRow);
    expect(verdict.passed).toBe(false);
  });
});

describe("assertion backtest", () => {
  it("grades through buildEvalIterationVerdict and matches live grading", () => {
    vi.mocked(buildEvalIterationVerdict).mockClear();
    const live = liveVerdict(predicates);
    vi.mocked(buildEvalIterationVerdict).mockClear();
    const differences = backtestIteration(
      {
        iterationId: "iteration",
        caseId: "case",
        query: "find cats",
        actualToolCalls: toolCalls,
        expectedToolCalls,
        isNegativeTest: false,
        predicates: [],
        evidence: { traceVersion: 1, traceComplete: true, messages },
        completeness: { transcript: "complete" },
      },
      { assertions: { mode: "replace", list: predicates } },
    );
    expect(buildEvalIterationVerdict).toHaveBeenCalled();
    // Every draft row is the live row for the same check.
    expect(differences.map((row) => row.draft?.passed)).toEqual(
      live.predicateResults.map((row) => row.passed),
    );
  });
});
