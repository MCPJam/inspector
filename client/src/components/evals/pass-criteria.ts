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
 * Compute if an individual iteration passed based on its data
 */
export function computeIterationPassed(
  iteration: EvalIteration,
  criteria?: PassCriteria,
): boolean {
  if (!iteration.testCaseSnapshot?.expectedToolCalls) {
    return true; // No expectations = pass
  }

  const expected = iteration.testCaseSnapshot.expectedToolCalls;
  const actual = iteration.actualToolCalls || [];

  // Find missing tool calls (expected but not called)
  const missing = expected.filter(
    (exp) => !actual.some((act) => act.toolName === exp.toolName),
  );

  // Find unexpected tool calls (called but not expected)
  const unexpected = actual.filter(
    (act) => !expected.some((exp) => exp.toolName === act.toolName),
  );

  // Check argument mismatches for tools that were called
  const argumentMismatches: string[] = [];
  for (const exp of expected) {
    const act = actual.find((a) => a.toolName === exp.toolName);
    if (act) {
      const expectedArgs = exp.arguments || {};
      const actualArgs = act.arguments || {};

      // Only check if expected arguments were specified
      if (Object.keys(expectedArgs).length > 0) {
        let mismatch = false;
        for (const [key, value] of Object.entries(expectedArgs)) {
          if (JSON.stringify(actualArgs[key]) !== JSON.stringify(value)) {
            mismatch = true;
            break;
          }
        }
        if (mismatch) {
          argumentMismatches.push(exp.toolName);
        }
      }
    }
  }

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

  // Compute passed/failed for each iteration
  const iterationsWithResults = runIterations.map((it) => ({
    ...it,
    passed: computeIterationPassed(it, criteria),
  }));

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
