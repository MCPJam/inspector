import {
  rubricCheckVerdictQuestions,
  type RubricCheckVerdictQuestion,
} from "@/shared/rubric-check-verdict";
import type { TrialRowEvidence, TrialRowResult } from "./trial-results";

type StoredModelGraderResult = {
  key: string;
  label: string;
  result: TrialRowResult;
  evidence?: TrialRowEvidence;
  evaluatorId?: string;
  outputKind?: "score" | "passfail";
};

function isUnitValue(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Mirrors what the server's projection would make of the question: a value
 * outside 0 to 1, or a scored question with no value, is an error row, never
 * a pass or a fail.
 */
function readResult(question: RubricCheckVerdictQuestion): TrialRowResult {
  const source = "modelVerdict";
  const reason = question.rationale;
  if (question.status === "skipped") {
    return { state: "skipped", source, reason };
  }
  if (question.status === "error" || !isUnitValue(question.value)) {
    return {
      state: "error",
      source,
      reason:
        reason ||
        question.error ||
        "The evaluator could not run. Rerun the suite to try again.",
    };
  }
  return {
    state: question.value >= question.passThreshold ? "passed" : "failed",
    source,
    value: question.value,
    reason,
    ...(isUnitValue(question.passThreshold)
      ? { threshold: question.passThreshold }
      : {}),
  };
}

/**
 * The job's saved verdicts, in the order the backend asked them, read with
 * the server's own parser so both sides agree on which questions exist.
 */
export function readStoredRubricCheckResults(
  verdict: unknown,
): StoredModelGraderResult[] {
  return rubricCheckVerdictQuestions(verdict).map((question) => ({
    key: question.key,
    label: question.label,
    result: readResult(question),
    ...(question.evidence?.length
      ? { evidence: { scoreEvidence: question.evidence } }
      : {}),
  }));
}

export function readStoredCustomJudgeResults(
  verdict: unknown,
): StoredModelGraderResult[] {
  const entries = record(verdict)?.judges;
  if (!Array.isArray(entries)) return [];
  const results: StoredModelGraderResult[] = [];
  for (const value of entries) {
    const entry = record(value);
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id) ||
      typeof entry.label !== "string" ||
      !entry.label
    ) {
      continue;
    }
    const output = record(entry.output);
    const reason = typeof entry.reason === "string" ? entry.reason : undefined;
    const threshold = output?.kind === "passfail" ? 0.5 : output?.threshold;
    const result: TrialRowResult =
      entry.status === "scored" &&
      isUnitValue(entry.value) &&
      typeof entry.passed === "boolean"
        ? {
            state: entry.passed ? "passed" : "failed",
            source: "modelVerdict",
            value: entry.value,
            reason,
            ...(isUnitValue(threshold) ? { threshold } : {}),
          }
        : {
            state: "error",
            source: "modelVerdict",
            reason:
              reason ||
              (typeof entry.error === "string"
                ? entry.error
                : "The evaluator could not run. Rerun the suite to try again."),
          };
    const origin = record(entry.evaluator);
    results.push({
      key: entry.id,
      label: entry.label,
      result,
      ...(typeof origin?.id === "string" && origin.id
        ? { evaluatorId: origin.id }
        : {}),
      ...(output?.kind === "score" || output?.kind === "passfail"
        ? { outputKind: output.kind }
        : {}),
    });
  }
  return results;
}
