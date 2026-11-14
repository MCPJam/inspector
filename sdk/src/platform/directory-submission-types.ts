/**
 * Directory submissions as the API returns them: a saved rehearsal of one
 * directory's form for one saved server, the portal's checks over its
 * answers, and a run's findings placed on the form's steps. The flow types
 * are imported for their types only, so this entry loads no flow data.
 */
import type {
  DirectoryAnswer,
  DirectoryAnswerValue,
  DirectoryFieldIssue,
  PlacedStep,
} from "../directory-readiness/flows/types.js";
import type { PlatformReadinessRun } from "./types.js";

export interface PlatformDirectoryFlowSummary {
  /** A server may list a flow this SDK version does not know yet. */
  id: string;
  directory: "claude" | "openai";
  title: string;
  /** Date of the portal capture the flow copies. */
  version: string;
  submissionUrl: string;
  steps: Array<{ id: string; title: string }>;
}

export interface PlatformDirectorySubmission {
  id: string;
  projectId: string;
  serverId?: string;
  directory: "claude" | "openai";
  flowId: string;
  /** The flow version the answers were written against. */
  flowVersion: string;
  title?: string;
  answers: DirectoryAnswer[];
  /** +1 on every write. Send it back as `expectedRevision`. */
  revision: number;
  createdBy: string;
  lastRunId?: string;
  createdAt: number;
  updatedAt: number;
}

export type PlatformDirectorySubmissionSummary = Omit<
  PlatformDirectorySubmission,
  "answers"
>;

export type PlatformDirectorySubmissionCounts = PlacedStep["counts"];

export interface PlatformDirectorySubmissionView
  extends PlatformDirectorySubmission {
  /** Stored answers plus the flow's defaults (origin `default`), derived on read. */
  answers: DirectoryAnswer[];
  fieldIssues: DirectoryFieldIssue[];
  /** Field issues and the latest complete run's findings, by step. */
  steps: PlacedStep[];
  /** The run `steps` places findings from; `null` before one completes. */
  resultsRunId: string | null;
  submissionUrl: string;
  /** An idempotency key answered from an earlier write. */
  replayed?: true;
}

export interface PlatformDirectorySubmissionResults {
  run: PlatformReadinessRun | null;
  steps: PlacedStep[];
  counts: PlatformDirectorySubmissionCounts;
}

export interface PlatformDirectorySubmissionCreateBody {
  flowId: string;
  serverId: string;
  title?: string;
  idempotencyKey?: string;
}

export interface PlatformDirectorySubmissionUpdateBody {
  /** A stale revision conflicts only on the fields this change touches. */
  expectedRevision: number;
  /** Values by field key. `null` removes the answer. */
  answers?: Record<string, DirectoryAnswerValue>;
  /** Field keys to confirm as true under the wording the flow shows now. */
  confirm?: string[];
  title?: string;
  idempotencyKey?: string;
}

export interface PlatformDirectorySubmissionRunBody {
  idempotencyKey?: string;
  includeLlmObservations?: boolean;
}

export interface PlatformDirectorySubmissionDeleted {
  id: string;
  deleted: true;
}

/** `details` of an update's `409 CONFLICT`. */
export interface PlatformDirectorySubmissionConflict {
  currentRevision: number;
  conflictingKeys: string[];
  /** The submission now, when it could be read back. */
  current?: PlatformDirectorySubmissionView;
}

export function directorySubmissionsPath(
  projectId: string,
  submissionId?: string,
  sub?: "runs" | "results"
): string {
  const base = `/projects/${encodeURIComponent(projectId)}/directory-submissions`;
  if (submissionId === undefined) return base;
  const one = `${base}/${encodeURIComponent(submissionId)}`;
  return sub ? `${one}/${sub}` : one;
}
