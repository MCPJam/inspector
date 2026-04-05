import {
  matchToolCalls,
  type ToolCall,
  type ArgumentMismatch,
} from "@/shared/eval-matching";
import type { PromptTurn } from "@/shared/prompt-turns";

export type { ToolCall };

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
): EvaluationResult => {
  const normalizedExpected = Array.isArray(expectedToolCalls)
    ? expectedToolCalls
    : [];
  const normalizedCalled = Array.isArray(toolsCalled) ? toolsCalled : [];

  const matchResult = matchToolCalls(
    normalizedExpected,
    normalizedCalled,
    isNegativeTest,
  );

  return {
    expectedToolCalls: normalizedExpected,
    toolsCalled: normalizedCalled,
    missing: matchResult.missing,
    unexpected: matchResult.unexpected,
    argumentMismatches: matchResult.argumentMismatches,
    passed: matchResult.passed,
  };
};

export const evaluateMultiTurnResults = (
  promptTurns: PromptTurn[],
  toolsCalledByPrompt: ToolCall[][],
  isNegativeTest?: boolean,
): MultiTurnEvaluationResult => {
  const normalizedTurns = Array.isArray(promptTurns) ? promptTurns : [];
  const promptSummaries: PromptTurnEvaluation[] = normalizedTurns.map(
    (turn, promptIndex) => {
      const actualToolCalls = Array.isArray(toolsCalledByPrompt[promptIndex])
        ? toolsCalledByPrompt[promptIndex]!
        : [];

      if (isNegativeTest) {
        const evaluation = evaluateResults([], actualToolCalls, true);
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

      const evaluation = evaluateResults(turn.expectedToolCalls, actualToolCalls);
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
    : promptSummaries.filter((summary) => summary.expectedToolCalls.length > 0);
  const failedSummaries = assertedSummaries.filter((summary) => !summary.passed);
  const firstFailedTurn = promptSummaries.find((summary) =>
    isNegativeTest
      ? !summary.passed
      : summary.expectedToolCalls.length > 0 && !summary.passed,
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
