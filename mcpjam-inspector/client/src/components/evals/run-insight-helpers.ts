import type { EvalSuiteRun } from "./types";

export type EvalCaseInsightRow = NonNullable<
  EvalSuiteRun["runInsights"]
>["caseInsights"][number];

/**
 * Resolves the case-level run insight row for a run using exact key/id matching only.
 */
export function findRunInsightForCase(
  run: EvalSuiteRun | null | undefined,
  opts: { caseKey?: string | null; testCaseId?: string | null },
): EvalCaseInsightRow | null {
  if (!run) {
    return null;
  }
  const list = run.runInsights?.caseInsights;
  if (!list?.length) {
    return null;
  }

  const { caseKey, testCaseId } = opts;
  if (caseKey) {
    const byKey = list.find((row) => row.caseKey === caseKey);
    if (byKey) {
      return byKey;
    }
  }
  if (testCaseId) {
    const byId = list.find((row) => row.testCaseId === testCaseId);
    if (byId) {
      return byId;
    }
  }
  return null;
}

/** e.g. `new_failure` → `New failure` */
export function formatRunInsightStatusLabel(status: string): string {
  const parts = status.split("_").filter(Boolean);
  if (parts.length === 0) {
    return status;
  }
  const first =
    parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
  const rest = parts
    .slice(1)
    .map((w) => w.toLowerCase())
    .join(" ");
  return rest ? `${first} ${rest}` : first;
}
