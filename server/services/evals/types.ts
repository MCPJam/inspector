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

export const evaluateResults = (
  expectedToolCalls: ToolCall[],
  toolsCalled: ToolCall[],
): EvaluationResult => {
  const normalizedExpected = Array.isArray(expectedToolCalls)
    ? expectedToolCalls
    : [];
  const normalizedCalled = Array.isArray(toolsCalled) ? toolsCalled : [];

  // Find missing tool calls (expected but not called)
  const missing = normalizedExpected.filter(
    (expected) =>
      !normalizedCalled.some((called) => called.toolName === expected.toolName),
  );

  // Find unexpected tool calls (called but not expected)
  const unexpected = normalizedCalled.filter(
    (called) =>
      !normalizedExpected.some(
        (expected) => expected.toolName === called.toolName,
      ),
  );

  // Check argument mismatches for tools that were called
  const argumentMismatches: Array<{
    toolName: string;
    expectedArgs: Record<string, any>;
    actualArgs: Record<string, any>;
  }> = [];

  for (const expected of normalizedExpected) {
    const actual = normalizedCalled.find(
      (c) => c.toolName === expected.toolName,
    );
    if (actual) {
      // Check if arguments match (only if expected has arguments specified)
      const expectedArgs = expected.arguments || {};
      const actualArgs = actual.arguments || {};

      // Only check if expected arguments were specified
      if (Object.keys(expectedArgs).length > 0) {
        let mismatch = false;

        // Check if all expected arguments match
        for (const [key, value] of Object.entries(expectedArgs)) {
          if (JSON.stringify(actualArgs[key]) !== JSON.stringify(value)) {
            mismatch = true;
            break;
          }
        }

        if (mismatch) {
          argumentMismatches.push({
            toolName: expected.toolName,
            expectedArgs,
            actualArgs,
          });
        }
      }
    }
  }

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
