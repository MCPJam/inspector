/**
 * The tool-expectation engine against the hosted matcher, on the real code.
 *
 * `@mcpjam/evaluators` runs its counterexample corpus against the engine with
 * hand-checked answers for "what today's matcher says". This runs the SAME
 * corpus through the code that actually produces today's verdict here —
 * `stepsToPromptTurns` then `evaluateMultiTurnResults` — and holds the engine's
 * `matcherEquivalent` to it turn by turn, lists included. That is the property
 * the shadow rests on: whatever the engine says beside it, the engine can
 * always reproduce the verdict it is about to replace.
 */

import { describe, expect, it } from "vitest";
import {
  TOOL_EXPECTATION_SKILL_TOOL_NAMES,
  compileToolExpectations,
  evaluateToolExpectations,
} from "@mcpjam/evaluators/internal/tool-expectations/index";
import { SKILL_TOOL_NAMES, isSkillToolName } from "@/shared/eval-matching";
import { stepsToPromptTurns, type TestStep } from "@/shared/steps";
import {
  TOOL_EXPECTATION_FIXTURES,
  type ToolExpectationFixture,
} from "../../../../../evaluators/tests/tool-expectations.fixtures";
import { evaluateMultiTurnResults } from "../types";

/** A fixture step, filled out into the authored step the runner would hold. */
function authoredSteps(fixture: ToolExpectationFixture): TestStep[] {
  return fixture.steps.map((step): TestStep => {
    switch (step.kind) {
      case "prompt":
        return { id: step.id, kind: "prompt", prompt: `ask ${step.id}` };
      case "toolCall":
        return {
          id: step.id,
          kind: "toolCall",
          serverName: "srv",
          toolName: "render",
          arguments: {},
        };
      case "interact":
        return {
          id: step.id,
          kind: "interact",
          toolName: "widget",
          action: { kind: "wait", ms: 10 },
        };
      default:
        return step as unknown as TestStep;
    }
  });
}

describe("the engine reproduces the hosted matcher", () => {
  it.each(TOOL_EXPECTATION_FIXTURES.map((fixture) => [fixture.name, fixture]))(
    "%s",
    (_name, fixture) => {
      const steps = authoredSteps(fixture);
      const today = evaluateMultiTurnResults(
        stepsToPromptTurns(steps),
        fixture.callsByTurn,
        fixture.isNegativeTest,
        fixture.matchOptions,
        { skillToolsActive: fixture.skillToolsActive },
      );
      const engine = evaluateToolExpectations(
        compileToolExpectations(fixture.steps, {
          matchOptions: fixture.matchOptions,
          isNegativeTest: fixture.isNegativeTest,
        }),
        fixture.callsByTurn,
        {
          skillToolsActive: fixture.skillToolsActive,
          isSkillTool: isSkillToolName,
        },
      );

      // The same turns, so a turn index means the same thing on both sides.
      expect(engine.turns).toHaveLength(today.promptSummaries.length);

      engine.turns.forEach((turn, index) => {
        const summary = today.promptSummaries[index]!;
        expect(turn.matcherEquivalent, `turn ${index} verdict`).toBe(
          summary.passed,
        );
        expect(turn.matcher, `turn ${index} lists`).toEqual({
          missing: summary.missing,
          unexpected: summary.unexpected,
          argumentMismatches: summary.argumentMismatches,
        });
      });
      expect(engine.matcherEquivalent).toBe(today.passed);

      // The corpus's own claim about today's verdict is a claim about this code.
      expect(fixture.matcher).toEqual(
        today.promptSummaries.map((summary) => summary.passed),
      );
    },
  );
});

describe("the skill exemption list", () => {
  it("is the same list the runner exempts", () => {
    expect([...TOOL_EXPECTATION_SKILL_TOOL_NAMES].sort()).toEqual(
      [...SKILL_TOOL_NAMES].sort(),
    );
  });
});
