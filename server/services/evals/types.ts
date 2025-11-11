export type UsageTotals = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type EvaluationResult = {
  expectedToolCalls: string[];
  toolsCalled: string[];
  missing: string[];
  unexpected: string[];
  passed: boolean;
};

export const evaluateResults = (
  expectedToolCalls: string[],
  toolsCalled: string[],
): EvaluationResult => {
  const normalizedExpected = Array.isArray(expectedToolCalls)
    ? expectedToolCalls
    : [];
  const normalizedCalled = Array.isArray(toolsCalled) ? toolsCalled : [];

  const missing = normalizedExpected.filter(
    (tool) => !normalizedCalled.includes(tool),
  );
  const unexpected = normalizedCalled.filter(
    (tool) => !normalizedExpected.includes(tool),
  );

  return {
    expectedToolCalls: normalizedExpected,
    toolsCalled: normalizedCalled,
    missing,
    unexpected,
    passed: missing.length === 0,
  };
};


