/**
 * Composite conformance report types. Browser-safe: no runners, no Node.
 * Directory readiness is absent by construction.
 */

import type { ConformanceReport } from "./conformance-reporting.js";
import type { ConformanceRunOutcome } from "./conformance-outcome.js";
import {
  pooledConformanceScore,
  type ConformanceScore,
} from "./conformance-score.js";

export const CONFORMANCE_RUN_SCHEMA_VERSION = 1 as const;
export const CONFORMANCE_SUITE_KINDS = [
  "protocol",
  "apps",
  "tasks",
  "oauth",
] as const;
export type ConformanceSuiteKind = (typeof CONFORMANCE_SUITE_KINDS)[number];

export const DEFAULT_CONFORMANCE_SUITES: ConformanceSuiteKind[] = [
  "protocol",
  "apps",
  "tasks",
];

export interface ConformanceRunReportV1 {
  schemaVersion: typeof CONFORMANCE_RUN_SCHEMA_VERSION;
  requestedSuites: ConformanceSuiteKind[];
  reports: Partial<Record<ConformanceSuiteKind, ConformanceReport>>;
  outcome: ConformanceRunOutcome;
  score: ConformanceScore;
  durationMs: number;
  protocolVersion?: string;
  engineVersion?: string;
}

export function normalizeConformanceSuites(
  suites: readonly string[] | undefined,
): ConformanceSuiteKind[] {
  const raw =
    suites && suites.length > 0 ? suites : DEFAULT_CONFORMANCE_SUITES;
  const seen = new Set<ConformanceSuiteKind>();
  const out: ConformanceSuiteKind[] = [];
  for (const suite of raw) {
    if (
      suite === "protocol" ||
      suite === "apps" ||
      suite === "tasks" ||
      suite === "oauth"
    ) {
      if (!seen.has(suite)) {
        seen.add(suite);
        out.push(suite);
      }
    }
  }
  return out.length > 0 ? out : [...DEFAULT_CONFORMANCE_SUITES];
}

export function buildConformanceRunReport(input: {
  requestedSuites: ConformanceSuiteKind[];
  reports: Partial<Record<ConformanceSuiteKind, ConformanceReport>>;
  startedAt: number;
  engineVersion?: string;
}): ConformanceRunReportV1 {
  const parts: ConformanceScore[] = [];
  for (const kind of input.requestedSuites) {
    const report = input.reports[kind];
    if (report?.score) {
      parts.push(report.score);
    } else {
      parts.push({
        score: null,
        outcome: "incomplete",
        applicable: 1,
        passed: 0,
        failed: 0,
        couldNotRun: 1,
        notApplicable: 0,
        // A suite that never reported has no pending bucket: the one thing
        // known about it is that an obligation went untested.
        pending: 0,
        advicePointsLost: 0,
        advisories: [],
      });
    }
  }
  const score = pooledConformanceScore(parts);
  const protocolVersion =
    input.reports.protocol?.score?.protocolVersion ?? score.protocolVersion;
  return {
    schemaVersion: CONFORMANCE_RUN_SCHEMA_VERSION,
    requestedSuites: input.requestedSuites,
    reports: input.reports,
    outcome: score.outcome,
    score,
    durationMs: Date.now() - input.startedAt,
    ...(protocolVersion ? { protocolVersion } : {}),
    ...(input.engineVersion ? { engineVersion: input.engineVersion } : {}),
  };
}
