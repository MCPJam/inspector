/** Failed runs from the baseline's steering cases, each with a reason and the page it opens. */
import { FAILURE_CATEGORY_LABELS, STAGE_REASON_LABELS, USER_VALUE_STAGE_LABELS } from "../contract/decision-labels.js";
import type { ClimbEvidence, FailedRun } from "./types.js";

export const MAX_FAILED_RUNS = 3;

const labelOf = <T extends Record<string, string>>(table: T, key: string | undefined): string | undefined =>
  key !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key as keyof T] : undefined;

/** A reason in the words the run page uses: the stage it failed at, and why. */
export function failureReason(evidence: ClimbEvidence): string {
  const stage = labelOf(USER_VALUE_STAGE_LABELS, evidence.failedStage?.stage) ?? evidence.failedStage?.stage;
  const why = labelOf(STAGE_REASON_LABELS, evidence.failedStage?.reason);
  const category = labelOf(FAILURE_CATEGORY_LABELS, evidence.failureCategory);
  if (stage && why) return `Failed at ${stage}: ${why}.`;
  if (stage) return `Failed at ${stage}${category ? ` (${category})` : ""}.`;
  return category ? `Failed (${category}).` : "Failed; the run page has the trace.";
}

export function toFailedRun(evidence: ClimbEvidence): FailedRun {
  return {
    caseKey: evidence.caseKey,
    ...(evidence.caseTitle ? { caseTitle: evidence.caseTitle } : {}),
    environmentId: evidence.environmentId,
    runId: evidence.runId,
    iterationId: evidence.iterationId,
    ...(evidence.failedStage ? { stage: evidence.failedStage.stage } : {}),
    reason: failureReason(evidence),
    link: evidence.link,
  };
}

/**
 * Up to three failed runs, spread over cases and environments so three failures
 * of one case do not stand for the suite. Order within a spread is the input's.
 */
export function pickFailedRuns(evidence: readonly ClimbEvidence[], limit = MAX_FAILED_RUNS): FailedRun[] {
  const failed = evidence.filter((item) => item.outcome === "failed");
  const picked: ClimbEvidence[] = [];
  const seen = new Set<string>();
  for (const item of failed) {
    if (picked.length === limit) break;
    const key = `${item.caseKey}|${item.environmentId}`;
    if (!seen.has(key)) {
      seen.add(key);
      picked.push(item);
    }
  }
  for (const item of failed) {
    if (picked.length === limit) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked.map(toFailedRun);
}
