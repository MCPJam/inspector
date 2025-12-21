/**
 * Shared tool call matching logic for evals
 * Used by both client and server to ensure consistent pass/fail evaluation
 */

export type ToolCall = {
  toolName: string;
  arguments: Record<string, any>;
};

export type ArgumentMismatch = {
  toolName: string;
  expectedArgs: Record<string, any>;
  actualArgs: Record<string, any>;
};

export type ToolCallMatchResult = {
  missing: ToolCall[];
  unexpected: ToolCall[];
  argumentMismatches: ArgumentMismatch[];
  passed: boolean;
};

/**
 * Check if expected arguments are satisfied by actual arguments.
 * Only checks keys present in expected - actual may have additional keys.
 */
export function argumentsMatch(
  expectedArgs: Record<string, any>,
  actualArgs: Record<string, any>,
): boolean {
  for (const [key, value] of Object.entries(expectedArgs)) {
    if (JSON.stringify(actualArgs[key]) !== JSON.stringify(value)) {
      return false;
    }
  }
  return true;
}

/**
 * Match expected tool calls against actual tool calls using a two-pass algorithm:
 * - Pass 1: Match expected calls to actual calls with matching toolName AND arguments
 * - Pass 2: For unmatched expected calls, try to match by toolName only (argument mismatches)
 *
 * @param expected - Expected tool calls
 * @param actual - Actual tool calls that were made
 * @param isNegativeTest - If true, test passes when NO tools are called
 * @returns Match result with missing, unexpected, argument mismatches, and pass status
 */
export function matchToolCalls(
  expected: ToolCall[],
  actual: ToolCall[],
  isNegativeTest?: boolean,
): ToolCallMatchResult {
  const normalizedExpected = Array.isArray(expected) ? expected : [];
  const normalizedActual = Array.isArray(actual) ? actual : [];

  // Handle negative tests: pass if NO tools were called
  if (isNegativeTest) {
    const passed = normalizedActual.length === 0;
    return {
      missing: [],
      unexpected: normalizedActual,
      argumentMismatches: [],
      passed,
    };
  }

  // Positive test: must call at least one tool
  if (normalizedActual.length === 0) {
    return {
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

  const argumentMismatches: ArgumentMismatch[] = [];

  // Pass 1: Match expected calls to actual calls with matching toolName AND arguments
  for (let ei = 0; ei < normalizedExpected.length; ei++) {
    const exp = normalizedExpected[ei];
    const expectedArgs = exp.arguments || {};

    for (let ai = 0; ai < normalizedActual.length; ai++) {
      if (matchedActualIndices.has(ai)) continue;

      const act = normalizedActual[ai];
      if (act.toolName !== exp.toolName) continue;

      const actualArgs = act.arguments || {};

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

    const exp = normalizedExpected[ei];
    const expectedArgs = exp.arguments || {};

    for (let ai = 0; ai < normalizedActual.length; ai++) {
      if (matchedActualIndices.has(ai)) continue;

      const act = normalizedActual[ai];
      if (act.toolName !== exp.toolName) continue;

      const actualArgs = act.arguments || {};

      // Found a toolName match but arguments don't match
      matchedActualIndices.add(ai);
      matchedExpectedIndices.add(ei);

      // Only record mismatch if expected had arguments specified
      if (Object.keys(expectedArgs).length > 0) {
        argumentMismatches.push({
          toolName: exp.toolName,
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
  const unexpected = normalizedActual.filter(
    (_, idx) => !matchedActualIndices.has(idx),
  );

  const passed = missing.length === 0 && argumentMismatches.length === 0;

  return {
    missing,
    unexpected,
    argumentMismatches,
    passed,
  };
}
