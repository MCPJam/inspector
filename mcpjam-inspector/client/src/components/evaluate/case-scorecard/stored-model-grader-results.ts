import type { TrialRowEvidence, TrialRowResult } from "./trial-results";

type StoredModelGraderResult = {
  key: string;
  label: string;
  result: TrialRowResult;
  evidence?: TrialRowEvidence;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isUnitValue(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

function readResult(
  entry: Record<string, unknown>,
  reason: string | undefined,
  threshold: unknown,
): TrialRowResult | undefined {
  const source = "modelVerdict";
  if (entry.status === "skipped") {
    return { state: "skipped", source, reason };
  }
  if (entry.status === "error") {
    return {
      state: "error",
      source,
      reason:
        reason ||
        (typeof entry.error === "string"
          ? entry.error
          : "The evaluator could not run. Rerun the suite to try again."),
    };
  }
  if (
    entry.status !== "scored" ||
    !isUnitValue(entry.value) ||
    typeof entry.passed !== "boolean"
  ) {
    return undefined;
  }
  return {
    state: entry.passed ? "passed" : "failed",
    source,
    value: entry.value,
    reason,
    ...(isUnitValue(threshold) ? { threshold } : {}),
  };
}

/** The job's saved verdicts are available even without score-row projection. */
export function readStoredRubricCheckResults(
  verdict: unknown,
): StoredModelGraderResult[] {
  const entries = record(verdict)?.questions;
  if (!Array.isArray(entries)) return [];
  const results: StoredModelGraderResult[] = [];
  for (const value of entries) {
    const entry = record(value);
    if (
      !entry ||
      typeof entry.key !== "string" ||
      !/^[cq]:[A-Za-z0-9_-]{1,64}$/.test(entry.key) ||
      typeof entry.label !== "string" ||
      !entry.label
    ) {
      continue;
    }
    const result = readResult(
      entry,
      typeof entry.rationale === "string" ? entry.rationale : undefined,
      entry.passThreshold,
    );
    if (!result) continue;
    const scoreEvidence = Array.isArray(entry.evidence)
      ? entry.evidence.filter((item): item is string => typeof item === "string")
      : [];
    results.push({
      key: entry.key,
      label: entry.label,
      result,
      ...(scoreEvidence.length > 0 ? { evidence: { scoreEvidence } } : {}),
    });
  }
  return results;
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
    const result = readResult(
      entry,
      typeof entry.reason === "string" ? entry.reason : undefined,
      output?.kind === "passfail" ? 0.5 : output?.threshold,
    );
    if (result) results.push({ key: entry.id, label: entry.label, result });
  }
  return results;
}
