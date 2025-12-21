export type UsageTotals = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ToolCall = {
  toolName: string;
  arguments: Record<string, any>;
};

export type EvaluationResult = {
  expectedToolCalls: ToolCall[];
  toolsCalled: ToolCall[];
  missing: ToolCall[];
  unexpected: ToolCall[];
  argumentMismatches: Array<{
    toolName: string;
    expectedArgs: Record<string, any>;
    actualArgs: Record<string, any>;
  }>;
  passed: boolean;
};

/**
 * Check if expected arguments are satisfied by actual arguments.
 * Only checks keys present in expected - actual may have additional keys.
 */
const argumentsMatch = (
  expectedArgs: Record<string, any>,
  actualArgs: Record<string, any>,
): boolean => {
  for (const [key, value] of Object.entries(expectedArgs)) {
    if (JSON.stringify(actualArgs[key]) !== JSON.stringify(value)) {
      return false;
    }
  }
  return true;
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

  // Handle negative tests: pass if NO tools were called
  if (isNegativeTest) {
    const passed = normalizedCalled.length === 0;
    return {
      expectedToolCalls: normalizedExpected,
      toolsCalled: normalizedCalled,
      missing: [],
      unexpected: normalizedCalled,
      argumentMismatches: [],
      passed,
    };
  }

  // Positive test: must call at least one tool
  if (normalizedCalled.length === 0) {
    return {
      expectedToolCalls: normalizedExpected,
      toolsCalled: normalizedCalled,
      missing: normalizedExpected,
      unexpected: [],
      argumentMismatches: [],
      passed: false,
    };
  }

  // Track which actual calls have been matched to prevent reuse
  const matchedActualIndices = new Set<number>();
  // Track which expected calls found a match (by index)
  const matchedExpectedIndices = new Set<number>();

  const argumentMismatches: Array<{
    toolName: string;
    expectedArgs: Record<string, any>;
    actualArgs: Record<string, any>;
  }> = [];

  // Pass 1: Match expected calls to actual calls with matching toolName AND arguments
  for (let ei = 0; ei < normalizedExpected.length; ei++) {
    const expected = normalizedExpected[ei];
    const expectedArgs = expected.arguments || {};

    for (let ai = 0; ai < normalizedCalled.length; ai++) {
      if (matchedActualIndices.has(ai)) continue;

      const actual = normalizedCalled[ai];
      if (actual.toolName !== expected.toolName) continue;

      const actualArgs = actual.arguments || {};

      // Check if arguments match (empty expected args always match)
      if (
        Object.keys(expectedArgs).length === 0 ||
        argumentsMatch(expectedArgs, actualArgs)
      ) {
        matchedActualIndices.add(ai);
        matchedExpectedIndices.add(ei);
        break;
      }
    }
  }

  // Pass 2: For unmatched expected calls, try to match by toolName only
  // These will be recorded as argument mismatches
  for (let ei = 0; ei < normalizedExpected.length; ei++) {
    if (matchedExpectedIndices.has(ei)) continue;

    const expected = normalizedExpected[ei];
    const expectedArgs = expected.arguments || {};

    for (let ai = 0; ai < normalizedCalled.length; ai++) {
      if (matchedActualIndices.has(ai)) continue;

      const actual = normalizedCalled[ai];
      if (actual.toolName !== expected.toolName) continue;

      const actualArgs = actual.arguments || {};

      // Found a toolName match but arguments don't match
      matchedActualIndices.add(ai);
      matchedExpectedIndices.add(ei);

      // Only record mismatch if expected had arguments specified
      if (Object.keys(expectedArgs).length > 0) {
        argumentMismatches.push({
          toolName: expected.toolName,
          expectedArgs,
          actualArgs,
        });
      }
      break;
    }
  }

  // Missing: expected calls that found no match at all
  const missing = normalizedExpected.filter(
    (_, idx) => !matchedExpectedIndices.has(idx),
  );

  // Unexpected: actual calls that were never matched
  const unexpected = normalizedCalled.filter(
    (_, idx) => !matchedActualIndices.has(idx),
  );

  const passed = missing.length === 0 && argumentMismatches.length === 0;

  return {
    expectedToolCalls: normalizedExpected,
    toolsCalled: normalizedCalled,
    missing,
    unexpected,
    argumentMismatches,
    passed,
  };
};
