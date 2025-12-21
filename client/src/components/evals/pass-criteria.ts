import { EvalIteration, EvalSuiteRun } from "./types";

export type PassCriteriaType =
  | "default"
  | "minimumPassRate"
  | "perTestTemplate"
  | "perModel"
  | "allMustPass";

export type PassCriteria = {
  type: PassCriteriaType;
  minimumPassRate?: number; // 0-100
  perTemplateThresholds?: Record<string, number>; // testTemplateKey -> threshold
  perModelThresholds?: Record<string, number>; // modelId -> threshold
  allowUnexpectedTools?: boolean;
  ignoreArgumentMismatches?: boolean;
};

export type PassCriteriaEvaluation = {
  passed: boolean;
  reason?: string;
  details?: {
    overallPassRate?: number;
    threshold?: number;
    failedTemplates?: Array<{
      templateKey: string;
      passRate: number;
      threshold: number;
    }>;
    failedModels?: Array<{
      model: string;
      passRate: number;
      threshold: number;
    }>;
  };
};

// Default criteria - 100% pass rate required
export const DEFAULT_CRITERIA: PassCriteria = {
  type: "minimumPassRate",
  minimumPassRate: 100,
};

/**
 * Compute the result for an iteration based on its status and pass/fail logic
 */
export function computeIterationResult(
  iteration: {
    status: "pending" | "running" | "completed" | "failed" | "cancelled";
    testCaseSnapshot?: {
      expectedToolCalls: Array<{
        toolName: string;
        arguments: Record<string, any>;
      }>;
    };
    actualToolCalls: Array<{
      toolName: string;
      arguments: Record<string, any>;
    }>;
  },
  criteria?: PassCriteria,
): "pending" | "passed" | "failed" | "cancelled" {
  // Handle status-based results first
  if (iteration.status === "pending" || iteration.status === "running") {
    return "pending";
  }
  if (iteration.status === "cancelled") {
    return "cancelled";
  }

  // Compute pass/fail for completed iterations
  const passed = computeIterationPassed(iteration as any, criteria);
  return passed ? "passed" : "failed";
}

/**
 * Check if expected arguments are satisfied by actual arguments.
 * Only checks keys present in expected - actual may have additional keys.
 */
const argumentsMatch = (
  expectedArgs: Record<string, unknown>,
  actualArgs: Record<string, unknown>,
): boolean => {
  for (const [key, value] of Object.entries(expectedArgs)) {
    if (JSON.stringify(actualArgs[key]) !== JSON.stringify(value)) {
      return false;
    }
  }
  return true;
};

/**
 * Compute if an individual iteration passed based on its data.
 * Uses two-pass matching algorithm to handle multiple calls with the same tool name:
 * - Pass 1: Match expected calls to actual calls with matching toolName AND arguments
 * - Pass 2: For unmatched expected calls, try to match by toolName only (argument mismatches)
 */
export function computeIterationPassed(
  iteration: EvalIteration,
  criteria?: PassCriteria,
): boolean {
  const actual = iteration.actualToolCalls || [];

  // Handle negative tests: pass if NO tools were called
  if (iteration.testCaseSnapshot?.isNegativeTest) {
    return actual.length === 0;
  }

  // Positive test: must call at least one tool
  if (actual.length === 0) {
    return false;
  }

  if (!iteration.testCaseSnapshot?.expectedToolCalls) {
    return true; // No specific expectations, but tools were called = pass
  }

  const expected = iteration.testCaseSnapshot.expectedToolCalls;

  // No specific tool expectations, but tools were called = pass
  if (expected.length === 0) {
    return true;
  }

  // Track which actual calls have been matched to prevent reuse
  const matchedActualIndices = new Set<number>();
  // Track which expected calls found a match (by index)
  const matchedExpectedIndices = new Set<number>();

  const argumentMismatches: string[] = [];

  // Pass 1: Match expected calls to actual calls with matching toolName AND arguments
  for (let ei = 0; ei < expected.length; ei++) {
    const exp = expected[ei];
    const expectedArgs = exp.arguments || {};

    for (let ai = 0; ai < actual.length; ai++) {
      if (matchedActualIndices.has(ai)) continue;

      const act = actual[ai];
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
  for (let ei = 0; ei < expected.length; ei++) {
    if (matchedExpectedIndices.has(ei)) continue;

    const exp = expected[ei];
    const expectedArgs = exp.arguments || {};

    for (let ai = 0; ai < actual.length; ai++) {
      if (matchedActualIndices.has(ai)) continue;

      const act = actual[ai];
      if (act.toolName !== exp.toolName) continue;

      // Found a toolName match but arguments don't match
      matchedActualIndices.add(ai);
      matchedExpectedIndices.add(ei);

      // Only record mismatch if expected had arguments specified
      if (Object.keys(expectedArgs).length > 0) {
        argumentMismatches.push(exp.toolName);
      }
      break;
    }
  }

  // Missing: expected calls that found no match at all
  const missing = expected.filter((_, idx) => !matchedExpectedIndices.has(idx));

  // Apply tolerances
  const effectiveMissing = criteria?.allowUnexpectedTools ? [] : missing;
  const effectiveMismatches = criteria?.ignoreArgumentMismatches
    ? []
    : argumentMismatches;

  return effectiveMissing.length === 0 && effectiveMismatches.length === 0;
}

/**
 * Evaluate pass/fail criteria for a suite run
 */
export function evaluatePassCriteria(
  run: EvalSuiteRun,
  iterations: EvalIteration[],
  criteria: PassCriteria = DEFAULT_CRITERIA,
): PassCriteriaEvaluation {
  // Filter to only this run's iterations
  const runIterations = iterations.filter((it) => it.suiteRunId === run._id);

  // Compute passed/failed for each iteration (only completed ones)
  const iterationsWithResults = runIterations
    .map((it) => {
      const result = computeIterationResult(it, criteria);
      return {
        ...it,
        result,
        passed: result === "passed",
      };
    })
    // Only count completed iterations - exclude pending/cancelled
    .filter((it) => it.result === "passed" || it.result === "failed");

  const totalCount = iterationsWithResults.length;
  const passedCount = iterationsWithResults.filter((it) => it.passed).length;
  const overallPassRate = totalCount > 0 ? (passedCount / totalCount) * 100 : 0;

  switch (criteria.type) {
    case "default":
    case "allMustPass":
    case "minimumPassRate": {
      const threshold = criteria.minimumPassRate ?? 100;
      const passed = overallPassRate >= threshold;
      return {
        passed,
        reason: passed
          ? undefined
          : `Pass rate ${overallPassRate.toFixed(1)}% below threshold ${threshold}%`,
        details: {
          overallPassRate,
          threshold,
        },
      };
    }

    case "perTestTemplate": {
      const threshold = criteria.minimumPassRate ?? 80;
      const failedTemplates: Array<{
        templateKey: string;
        passRate: number;
        threshold: number;
      }> = [];

      // Group by testTemplateKey
      const byTemplate = new Map<
        string,
        Array<(typeof iterationsWithResults)[0]>
      >();
      for (const it of iterationsWithResults) {
        const templateKey = it.testCaseSnapshot?.title || "unknown"; // Use title as fallback
        if (!byTemplate.has(templateKey)) {
          byTemplate.set(templateKey, []);
        }
        byTemplate.get(templateKey)!.push(it);
      }

      // Check each template
      for (const [templateKey, templateIterations] of byTemplate) {
        const templatePassed = templateIterations.filter(
          (it) => it.passed,
        ).length;
        const templateTotal = templateIterations.length;
        const templatePassRate =
          templateTotal > 0 ? (templatePassed / templateTotal) * 100 : 0;
        const templateThreshold =
          criteria.perTemplateThresholds?.[templateKey] ?? threshold;

        if (templatePassRate < templateThreshold) {
          failedTemplates.push({
            templateKey,
            passRate: templatePassRate,
            threshold: templateThreshold,
          });
        }
      }

      const passed = failedTemplates.length === 0;
      return {
        passed,
        reason: passed
          ? undefined
          : `${failedTemplates.length} test template(s) below threshold`,
        details: {
          overallPassRate,
          threshold,
          failedTemplates,
        },
      };
    }

    case "perModel": {
      const threshold = criteria.minimumPassRate ?? 80;
      const failedModels: Array<{
        model: string;
        passRate: number;
        threshold: number;
      }> = [];

      // Group by model
      const byModel = new Map<
        string,
        Array<(typeof iterationsWithResults)[0]>
      >();
      for (const it of iterationsWithResults) {
        const model = it.testCaseSnapshot?.model || "unknown";
        if (!byModel.has(model)) {
          byModel.set(model, []);
        }
        byModel.get(model)!.push(it);
      }

      // Check each model
      for (const [model, modelIterations] of byModel) {
        const modelPassed = modelIterations.filter((it) => it.passed).length;
        const modelTotal = modelIterations.length;
        const modelPassRate =
          modelTotal > 0 ? (modelPassed / modelTotal) * 100 : 0;
        const modelThreshold =
          criteria.perModelThresholds?.[model] ?? threshold;

        if (modelPassRate < modelThreshold) {
          failedModels.push({
            model,
            passRate: modelPassRate,
            threshold: modelThreshold,
          });
        }
      }

      const passed = failedModels.length === 0;
      return {
        passed,
        reason: passed
          ? undefined
          : `${failedModels.length} model(s) below threshold`,
        details: {
          overallPassRate,
          threshold,
          failedModels,
        },
      };
    }

    default:
      return {
        passed: overallPassRate >= 80,
        details: {
          overallPassRate,
          threshold: 80,
        },
      };
  }
}
