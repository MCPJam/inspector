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
};

function isUnitValue(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
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
