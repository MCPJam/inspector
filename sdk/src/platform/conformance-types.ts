/**
 * Wire types for the conformance run routes under `/api/v1`, re-exported from
 * `types.ts` so existing import paths keep working.
 */
/** Suites the hosted agent/API surface can start. OAuth is refused. */
export type PlatformConformanceSuiteKind = "protocol" | "apps" | "tasks";

/** The `202` receipt. Poll the run detail; do not re-POST. */
export interface PlatformConformanceRunReceipt {
  runId: string;
  projectId: string;
  serverId: string;
  /**
   * The run's status at the moment the start returned.
   *
   * `queued` for a fresh start. For a DEDUPED start it is whatever the
   * existing run is already at — which may be `completed`.
   */
  status: string;
  /** True when an idempotency key replayed an existing run. */
  deduped: boolean;
  requestedSuites: PlatformConformanceSuiteKind[];
}

export interface PlatformConformanceRunReportSummary {
  suiteKind: string;
  status: string;
  outcome: string | null;
  score: number | null;
  pending: number;
  profileId: string | null;
  profileVersion: string | null;
  hasReport: boolean;
}

export interface PlatformConformanceRun {
  id: string;
  projectId: string;
  serverId: string | null;
  source: string | null;
  verification: string | null;
  status: string;
  outcome: string | null;
  incompleteReason: string | null;
  score: number | null;
  applicable: number;
  passed: number;
  failed: number;
  couldNotRun: number;
  notApplicable: number;
  pending: number;
  advisoryCount: number;
  requestedSuites: string[];
  protocolVersion: string | null;
  engineVersion: string | null;
  createdAt: number;
  completedAt: number | null;
  durationMs: number | null;
  reports: PlatformConformanceRunReportSummary[];
  /** Relative v1 report URL when a stored report exists (or the run is terminal). */
  reportUrl: string | null;
}

export interface PlatformConformanceReportCheck {
  suiteKind: string;
  id: string;
  title: string;
  groupId: string;
  status: string;
  pending: boolean;
  skipReason?: string;
  error?: string;
}

export interface PlatformConformanceReportProfile {
  suiteKind: string;
  profileId: string | null;
  profileVersion: string | null;
  pendingCheckIds: string[];
}

/** Bounded failing-check projection. The stored report can be megabytes. */
export interface PlatformConformanceReport {
  runId: string;
  status: string;
  outcome: string | null;
  score: number | null;
  pending: number;
  checks: PlatformConformanceReportCheck[];
  totalCases: number;
  /** Failed + could-not-run count, the denominator behind `truncated`. */
  totalFailingCases: number;
  truncated: boolean;
  profiles: PlatformConformanceReportProfile[];
}
