/**
 * What a shared conformance run's artifact holds, as the backend's share build
 * writes it (`internalBuildShareArtifact` in mcpjam-backend): the run's score,
 * and each suite's redacted SDK report.
 */

import type { ConformanceRunListItem } from "./ConformanceHistory";
import type { SavedReportCase } from "./use-saved-run-reports";

/** One suite as a shared artifact stores it: the redacted SDK report. */
export type SharedSuiteReport = {
  outcome?: string;
  passed?: boolean;
  incompleteReason?: string;
  score?: {
    score?: number;
    outcome?: string;
    applicable?: number;
    passed?: number;
    failed?: number;
    couldNotRun?: number;
  };
  groups?: Array<{ cases?: SavedReportCase[] }>;
  advisories?: unknown;
};

export type SharedConformanceArtifact = {
  score?: number | null;
  outcome?: ConformanceRunListItem["outcome"];
  applicable?: number;
  passed?: number;
  failed?: number;
  couldNotRun?: number;
  notApplicable?: number;
  advisoryCount?: number;
  protocolVersion?: string | null;
  requestedSuites?: string[];
  createdAt?: number;
  /**
   * The name the owner gave the server. Absent on a run against a URL, a run
   * whose server was deleted, and a share built before the backend kept it.
   */
  serverName?: string | null;
  reports?: Record<string, SharedSuiteReport>;
};
