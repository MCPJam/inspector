import {
  evaluateToolCalls,
  isSkillToolName,
  resolveExtrasCap,
  type EvalMatchOptions,
  type ToolCall,
  type ArgumentMismatch,
} from "@/shared/eval-matching";
import { isPinnedTurn, type PromptTurn } from "@/shared/steps";

export type { ToolCall };

/**
 * Extra context threaded from the runner into multi-turn matching.
 * `skillToolsActive` is true when the prepared tool set advertised skill tools
 * (see `hasSkillTools`); it gates the skill-call exemption below.
 */
export type EvalMatchContext = {
  skillToolsActive?: boolean;
};

/**
 * When skills are active, a skill tool call (listSkills / loadSkill / …) is
 * agent housekeeping, not a task action — so it must not be counted against a
 * turn's tool-call expectations (else a `maxExtraToolCalls: 0` turn fails merely
 * because the model discovered/loaded a skill). Returns the calls the matcher
 * should see: skill calls are dropped UNLESS the turn explicitly NAMES that
 * skill tool in `expectedToolCalls` (so a skill-CI case can still assert
 * `loadSkill`). The caller keeps the UNFILTERED list for trace/judge/adherence.
 */
function filterExemptSkillCalls(
  actualToolCalls: ToolCall[],
  expectedToolCalls: ToolCall[],
): ToolCall[] {
  const expectedNames = new Set(expectedToolCalls.map((c) => c.toolName));
  return actualToolCalls.filter(
    (c) => !isSkillToolName(c.toolName) || expectedNames.has(c.toolName),
  );
}

export type UsageTotals = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type EvaluationResult = {
  expectedToolCalls: ToolCall[];
  toolsCalled: ToolCall[];
  missing: ToolCall[];
  unexpected: ToolCall[];
  argumentMismatches: ArgumentMismatch[];
  passed: boolean;
};

export type PromptTurnEvaluation = {
  promptIndex: number;
  prompt: string;
  expectedToolCalls: ToolCall[];
  actualToolCalls: ToolCall[];
  expectedOutput?: string;
  missing: ToolCall[];
  unexpected: ToolCall[];
  argumentMismatches: ArgumentMismatch[];
  passed: boolean;
};

export type MultiTurnEvaluationResult = EvaluationResult & {
  promptSummaries: PromptTurnEvaluation[];
  turnCount: number;
  failedTurnCount: number;
  firstFailedTurnIndex?: number;
};

export const evaluateResults = (
  expectedToolCalls: ToolCall[],
  toolsCalled: ToolCall[],
  isNegativeTest?: boolean,
  matchOptions?: EvalMatchOptions,
): EvaluationResult => {
  const normalizedExpected = Array.isArray(expectedToolCalls)
    ? expectedToolCalls
    : [];
  const normalizedCalled = Array.isArray(toolsCalled) ? toolsCalled : [];

  const result = evaluateToolCalls(normalizedExpected, normalizedCalled, {
    ...matchOptions,
    isNegativeTest,
  });

  return {
    expectedToolCalls: normalizedExpected,
    toolsCalled: normalizedCalled,
    missing: result.missing,
    unexpected: result.extra,
    argumentMismatches: result.argumentMismatches,
    passed: result.passed,
  };
};

export const evaluateMultiTurnResults = (
  promptTurns: PromptTurn[],
  toolsCalledByPrompt: ToolCall[][],
  isNegativeTest?: boolean,
  matchOptions?: EvalMatchOptions,
  evalContext?: EvalMatchContext,
): MultiTurnEvaluationResult => {
  const skillToolsActive = evalContext?.skillToolsActive === true;
  const normalizedTurns = Array.isArray(promptTurns) ? promptTurns : [];
  const promptSummaries: PromptTurnEvaluation[] = normalizedTurns.map(
    (turn, promptIndex) => {
      const actualToolCalls = Array.isArray(toolsCalledByPrompt[promptIndex])
        ? toolsCalledByPrompt[promptIndex]!
        : [];

      // Pinned tool calls are fixture input, not model behavior: the call is
      // pre-determined, so it is exempt from expected/extra/order matching
      // (otherwise strict / maxExtraToolCalls=0 options would fail a legacy
      // render check). The call is still surfaced in `actualToolCalls` so it
      // flows into the transcript's toolCalls for predicate visibility.
      if (isPinnedTurn(turn)) {
        return {
          promptIndex,
          prompt: turn.prompt,
          expectedToolCalls: [],
          actualToolCalls,
          expectedOutput: turn.expectedOutput,
          missing: [],
          unexpected: [],
          argumentMismatches: [],
          passed: true,
        };
      }

      // The calls the matcher SEES. With skills active, skill-tool calls the
      // turn didn't explicitly expect are dropped (exempted); reported
      // `actualToolCalls` stays unfiltered. Byte-identical (same reference) when
      // skills are inactive, so no behavior change for skill-free suites.
      const matchableToolCalls = skillToolsActive
        ? filterExemptSkillCalls(actualToolCalls, turn.expectedToolCalls)
        : actualToolCalls;

      if (isNegativeTest) {
        const evaluation = evaluateResults(
          [],
          matchableToolCalls,
          true,
          matchOptions,
        );
        return {
          promptIndex,
          prompt: turn.prompt,
          expectedToolCalls: [],
          actualToolCalls,
          expectedOutput: turn.expectedOutput,
          missing: evaluation.missing,
          unexpected: evaluation.unexpected,
          argumentMismatches: evaluation.argumentMismatches,
          passed: evaluation.passed,
        };
      }

      if (turn.expectedToolCalls.length === 0) {
        // A turn with no expectations should normally pass. The one exception
        // is bounded extras (`maxExtraToolCalls === 0`, including the legacy
        // `allowExtraToolCalls === false` shim) when the model *did* make
        // calls on this turn — those calls are unexpected extras and must
        // fail. We can't route through `evaluateResults` for the empty-actual
        // case because the SDK matcher fails positive both-empty by design.
        const extrasCap = resolveExtrasCap(matchOptions);
        if (
          extrasCap !== null &&
          matchableToolCalls.length > extrasCap
        ) {
          return {
            promptIndex,
            prompt: turn.prompt,
            expectedToolCalls: turn.expectedToolCalls,
            actualToolCalls,
            expectedOutput: turn.expectedOutput,
            missing: [],
            unexpected: matchableToolCalls,
            argumentMismatches: [],
            passed: false,
          };
        }
        return {
          promptIndex,
          prompt: turn.prompt,
          expectedToolCalls: turn.expectedToolCalls,
          actualToolCalls,
          expectedOutput: turn.expectedOutput,
          missing: [],
          unexpected: [],
          argumentMismatches: [],
          passed: true,
        };
      }

      const evaluation = evaluateResults(
        turn.expectedToolCalls,
        matchableToolCalls,
        undefined,
        matchOptions,
      );
      return {
        promptIndex,
        prompt: turn.prompt,
        expectedToolCalls: turn.expectedToolCalls,
        actualToolCalls,
        expectedOutput: turn.expectedOutput,
        missing: evaluation.missing,
        unexpected: evaluation.unexpected,
        argumentMismatches: evaluation.argumentMismatches,
        passed: evaluation.passed,
      };
    },
  );

  const assertedSummaries = isNegativeTest
    ? promptSummaries
    : promptSummaries.filter(
        // Include turns that either declared expectations OR failed at
        // evaluation time (e.g. strict-extras turn with 0 expected calls but
        // actual calls present). The latter would otherwise be silently
        // dropped from the aggregate pass/fail roll-up.
        (summary) => summary.expectedToolCalls.length > 0 || !summary.passed,
      );
  const failedSummaries = assertedSummaries.filter(
    (summary) => !summary.passed,
  );
  const firstFailedTurn = promptSummaries.find(
    (summary) => !summary.passed,
  );

  return {
    expectedToolCalls: isNegativeTest
      ? []
      : assertedSummaries.flatMap((summary) => summary.expectedToolCalls),
    toolsCalled: promptSummaries.flatMap((summary) => summary.actualToolCalls),
    missing: assertedSummaries.flatMap((summary) => summary.missing),
    unexpected: isNegativeTest
      ? promptSummaries.flatMap((summary) => summary.unexpected)
      : assertedSummaries.flatMap((summary) => summary.unexpected),
    argumentMismatches: assertedSummaries.flatMap(
      (summary) => summary.argumentMismatches,
    ),
    passed: failedSummaries.length === 0,
    promptSummaries,
    turnCount: promptSummaries.length,
    failedTurnCount: failedSummaries.length,
    firstFailedTurnIndex: firstFailedTurn?.promptIndex,
  };
};
