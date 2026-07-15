import { describe, it, expect } from "vitest";
import {
  evaluateTurnChecks,
  type TurnChecksInput,
} from "../src/predicates/evaluate";
import { buildTurnTranscript } from "../src/predicates/transcript";
import {
  isTurnScopablePredicateKind,
  TURN_SCOPABLE_PREDICATE_KINDS,
} from "../src/predicates/types";

// Per-turn checks reuse the whole-iteration evaluator against a turn-scoped
// slice. These tests prove the slice makes positional checks resolve to the
// turn — the core feasibility claim of the per-turn-checks feature — and that
// every result is tagged with its `scope`.

describe("evaluateTurnChecks — turn-scoped evaluation", () => {
  // Two turns: turn 0 calls `search`; turn 1 calls `get_weather` and the
  // assistant says "weather is sunny".
  const turn0 = buildTurnTranscript({
    toolCalls: [{ toolName: "search", arguments: {} }],
    finalAssistantMessage: "let me look that up",
  });
  const turn1 = buildTurnTranscript({
    toolCalls: [{ toolName: "get_weather", arguments: { city: "SF" } }],
    finalAssistantMessage: "the weather is sunny",
  });

  it("scopes responseContains to the addressed turn", () => {
    const turns: TurnChecksInput[] = [
      {
        promptIndex: 0,
        checks: [{ type: "responseContains", needle: "weather" }],
        transcript: turn0,
      },
      {
        promptIndex: 1,
        checks: [{ type: "responseContains", needle: "weather" }],
        transcript: turn1,
      },
    ];
    const results = evaluateTurnChecks(turns);
    expect(results).toHaveLength(2);
    // Turn 0's message has no "weather" — fails when scoped to turn 0.
    expect(results[0]).toMatchObject({
      passed: false,
      scope: { kind: "turn", promptIndex: 0 },
    });
    // Turn 1's message does — passes when scoped to turn 1. A whole-iteration
    // check would pass for both, masking the turn-0 failure.
    expect(results[1]).toMatchObject({
      passed: true,
      scope: { kind: "turn", promptIndex: 1 },
    });
  });

  it("scopes firstToolWas / toolCalledWith per turn", () => {
    const results = evaluateTurnChecks([
      {
        promptIndex: 0,
        checks: [{ type: "firstToolWas", toolName: "search" }],
        transcript: turn0,
      },
      {
        promptIndex: 1,
        checks: [
          { type: "firstToolWas", toolName: "search" },
          {
            type: "toolCalledWith",
            toolName: "get_weather",
            args: { args: { city: "SF" } },
          },
        ],
        transcript: turn1,
      },
    ]);
    expect(results[0]).toMatchObject({ passed: true, scope: { promptIndex: 0 } });
    // turn 1's first tool is get_weather, not search → fails
    expect(results[1]).toMatchObject({ passed: false, scope: { promptIndex: 1 } });
    // get_weather was called with {city:"SF"} in turn 1 → passes
    expect(results[2]).toMatchObject({ passed: true, scope: { promptIndex: 1 } });
  });

  it("skips turns with no checks", () => {
    const results = evaluateTurnChecks([
      { promptIndex: 0, checks: undefined, transcript: turn0 },
      { promptIndex: 1, checks: [], transcript: turn1 },
    ]);
    expect(results).toEqual([]);
  });

  it("drops non-turn-scopable kinds (defense in depth)", () => {
    // `tokenBudgetUnder` is case-only; even if one reaches the evaluator it must
    // not be treated as a per-turn check. The valid sibling still evaluates.
    const results = evaluateTurnChecks([
      {
        promptIndex: 0,
        checks: [
          { type: "tokenBudgetUnder", tokens: 100 },
          { type: "firstToolWas", toolName: "search" },
        ],
        transcript: turn0,
      },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].predicate.type).toBe("firstToolWas");
    expect(results[0]).toMatchObject({ scope: { promptIndex: 0 } });
  });
});

describe("TURN_SCOPABLE_PREDICATE_KINDS", () => {
  it("includes positional + widget kinds but excludes tokenBudgetUnder", () => {
    expect(isTurnScopablePredicateKind("responseContains")).toBe(true);
    expect(isTurnScopablePredicateKind("widgetRendered")).toBe(true);
    expect(isTurnScopablePredicateKind("noToolErrors")).toBe(true);
    expect(isTurnScopablePredicateKind("tokenBudgetUnder")).toBe(false);
    expect(TURN_SCOPABLE_PREDICATE_KINDS).not.toContain("tokenBudgetUnder");
    // 12 predicate kinds total, exactly one (tokenBudgetUnder) is case-only.
    expect(TURN_SCOPABLE_PREDICATE_KINDS).toHaveLength(11);
  });
});
