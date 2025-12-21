import {
  matchToolCalls,
  type ToolCall,
  type ArgumentMismatch,
} from "@/shared/eval-matching";

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
