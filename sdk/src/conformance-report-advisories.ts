/**
 * A conformance suite's SHOULD/MAY advice, as report advisories. Kept in the
 * saved report so a run reopened from history can still list its advice.
 */
import type {
  ConformanceReportAdvisory,
  ConformanceReportPassedAdvisory,
} from "./conformance-reporting.js";
import { deepJsonSafe } from "./json-safe.js";

/** A suite's SHOULD/MAY advice: what every suite's `readiness` entry carries. */
interface ReadinessWarningLike {
  id: string;
  title: string;
  specStrength: string;
  message: string;
  details?: unknown;
}

/** Advice a suite checked and the server met. */
interface PassedAdviceLike {
  id: string;
  title: string;
  specStrength: string;
}

/**
 * A suite's advice as report advisories, one list for every run in it. A
 * matrix repeats the same advice once per run; the first one is kept, under
 * that run's group. Passed advice is listed only when no run warned about
 * it: a pass in one run does not cancel a miss in another.
 */
export function readinessAdvisoryFields(
  entries: ReadonlyArray<{
    readiness?: readonly ReadinessWarningLike[];
    passedAdvice?: readonly PassedAdviceLike[];
    group: string;
  }>
): {
  advisories?: ConformanceReportAdvisory[];
  passedAdvisories?: ConformanceReportPassedAdvisory[];
} {
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
        // Sanitized at the producer, like every other report `details`:
        // Convex rejects class instances.
        ...(warning.details !== undefined
          ? { details: deepJsonSafe(warning.details) }
          : {}),
      });
    }
  }
  const passedById = new Map<string, ConformanceReportPassedAdvisory>();
  for (const { passedAdvice, group } of entries) {
    for (const advice of passedAdvice ?? []) {
      if (byId.has(advice.id) || passedById.has(advice.id)) continue;
      passedById.set(advice.id, {
        id: advice.id,
        title: advice.title,
        group,
        status: advice.specStrength,
      });
    }
  }
  return {
    ...(byId.size > 0 ? { advisories: [...byId.values()] } : {}),
    ...(passedById.size > 0
      ? { passedAdvisories: [...passedById.values()] }
      : {}),
  };
}
