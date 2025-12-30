import { matchToolCalls } from "@/shared/eval-matching";
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
 * Compute if an individual iteration passed based on its data.
 * Uses the shared two-pass matching algorithm from @/shared/eval-matching.
 */
export function computeIterationPassed(
  iteration: EvalIteration,
  criteria?: PassCriteria,
): boolean {
  const actual = iteration.actualToolCalls || [];
  const expected = iteration.testCaseSnapshot?.expectedToolCalls || [];
  const isNegativeTest = iteration.testCaseSnapshot?.isNegativeTest;

  // Use shared matching logic
  const matchResult = matchToolCalls(expected, actual, isNegativeTest);

  // For negative tests, the shared function handles everything
  if (isNegativeTest) {
    return matchResult.passed;
  }

  // For positive tests with no expected calls but tools were called = pass
  if (expected.length === 0 && actual.length > 0) {
    return true;
  }

  // Apply tolerances from criteria
  const effectiveMissing = criteria?.allowUnexpectedTools
    ? []
    : matchResult.missing;
  const effectiveMismatches = criteria?.ignoreArgumentMismatches
    ? []
    : matchResult.argumentMismatches;

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
