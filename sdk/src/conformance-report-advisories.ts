/**
 * A conformance suite's SHOULD/MAY advice, as report advisories. Kept in the
 * saved report so a run reopened from history can still list its advice.
 */
import type { ConformanceReportAdvisory } from "./conformance-reporting.js";

/** A suite's SHOULD/MAY advice: what every suite's `readiness` entry carries. */
interface ReadinessWarningLike {
  id: string;
  title: string;
  specStrength: string;
  message: string;
  details?: unknown;
}

/**
 * A suite's advice as report advisories, one list for every run in it. A
 * matrix repeats the same advice once per run; the first one is kept, under
 * that run's group.
 */
export function readinessAdvisoryFields(
  entries: ReadonlyArray<{
    readiness?: readonly ReadinessWarningLike[];
    group: string;
  }>,
): { advisories?: ConformanceReportAdvisory[] } {
  const byId = new Map<string, ConformanceReportAdvisory>();
  for (const { readiness, group } of entries) {
    for (const warning of readiness ?? []) {
      if (byId.has(warning.id)) continue;
      byId.set(warning.id, {
        id: warning.id,
        title: warning.title,
        group,
        kind: "readiness",
        status: warning.specStrength,
        message: warning.message,
        ...(warning.details !== undefined ? { details: warning.details } : {}),
      });
    }
  }
  return byId.size > 0 ? { advisories: [...byId.values()] } : {};
}
