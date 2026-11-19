/**
 * Conformance results → `CheckResultEvidence`. The canvas reads the latest
 * run's per-suite `checkDigest` (backend `conformanceRunReports`), whose
 * cases carry the suite's own check ids.
 */

import type {
  CheckResultEvidence,
  CheckStatus,
  ConformanceCheckRef,
  ConformanceSuiteKey,
} from "./types.js";

const SUITE_KEYS: readonly ConformanceSuiteKey[] = [
  "protocol",
  "apps",
  "tasks",
  "events",
  "oauth",
];

export function isConformanceSuiteKey(
  value: unknown,
): value is ConformanceSuiteKey {
  return (
    typeof value === "string" &&
    (SUITE_KEYS as readonly string[]).includes(value)
  );
}

export function isConformanceCheckRef(
  value: string,
): value is ConformanceCheckRef {
  const separator = value.indexOf(":");
  return (
    separator > 0 &&
    separator < value.length - 1 &&
    isConformanceSuiteKey(value.slice(0, separator))
  );
}

/** Digest statuses as the backend stores them. */
export type ConformanceDigestStatus =
  | "passed"
  | "failed"
  | "could_not_run"
  | "not_applicable"
  | "pending";

export interface ConformanceDigestSuite {
  suiteKind: string;
  cases: ReadonlyArray<{ id: string; status: string }>;
}

function digestStatus(status: string): CheckStatus | undefined {
  if (status === "passed" || status === "failed") return status;
  if (status === "could_not_run" || status === "not_applicable")
    return "skipped";
  return undefined;
}

/**
 * One run's suites → check evidence. Pending cases are dropped; cases from a
 * suite the canvas does not map are ignored.
 */
export function checkEvidenceFromDigest(run: {
  runId: string;
  runAt: number;
  protocolVersion?: string;
  suites: readonly ConformanceDigestSuite[];
}): CheckResultEvidence[] {
  const evidence: CheckResultEvidence[] = [];
  for (const suite of run.suites) {
    if (!isConformanceSuiteKey(suite.suiteKind)) continue;
    for (const entry of suite.cases) {
      const status = digestStatus(entry.status);
      if (!status) continue;
      evidence.push({
        ref: `${suite.suiteKind}:${entry.id}`,
        status,
        runId: run.runId,
        runAt: run.runAt,
        protocolVersion: run.protocolVersion,
      });
    }
  }
  return evidence;
}
