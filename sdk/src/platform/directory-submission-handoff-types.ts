/**
 * A directory submission's handoff, findings, export, events and snapshots as
 * the API returns them. The summary is the SDK builder's own type, so a
 * summary the API serves and one built locally cannot disagree.
 */
import type {
  DirectoryHandoff,
  DirectorySnapshotLabel,
  DirectorySubmissionEvent,
  DirectorySubmissionSnapshots,
} from "../directory-readiness/handoff.js";
import type { DirectoryReadinessFinding } from "../directory-readiness/types.js";
import type { PlatformServerRevisionDiff } from "./server-revision-types.js";

export type PlatformDirectorySubmissionHandoff = DirectoryHandoff;
export type PlatformDirectorySubmissionEvent = DirectorySubmissionEvent & {
  replayed?: true;
};

/** One check's stored result, under the step and field the flow shows it at. */
export type PlatformDirectorySubmissionFinding = Pick<
  DirectoryReadinessFinding,
  | "lane"
  | "class"
  | "status"
  | "title"
  | "remediation"
  | "notEvaluatedReason"
  | "provenance"
  | "requiresCapabilities"
> & {
  checkId: string;
  /** The run that wrote it; a result outlives its run's report. */
  runId: string;
  step: string;
  field?: string;
  inputs?: Array<{ kind: string; key: string; fingerprint: string }>;
  /** JSON source attribution retained when the run report expires. */
  source?: string;
  intrusiveness?: DirectoryReadinessFinding["intrusiveness"];
  /** Epoch ms of the verdict. */
  evaluatedAt: number;
  engineVersion: string;
  updatedAt: number;
  hasDetails: boolean;
  detailsTruncated?: boolean;
  /** The one-finding read only: the stored observation, at most 8 KiB. */
  details?: unknown;
};

export interface PlatformDirectorySubmissionFindingsQuery {
  status?: DirectoryReadinessFinding["status"];
  step?: string;
  lane?: string;
  cursor?: string;
  limit?: number;
}

/** The pack as a file: `content` is its exact bytes, which every surface saves as is. */
export interface PlatformDirectorySubmissionExportFile {
  format: "json" | "markdown";
  filename: string;
  mediaType: "application/json" | "text/markdown";
  content: string;
}

type Stamped =
  | "id"
  | "submissionId"
  | "projectId"
  | "actor"
  | "actorLabel"
  | "createdAt";

/** What a caller records: the event less what the server stamps. Never a secret's value. */
export type PlatformDirectorySubmissionEventBody = Omit<
  DirectorySubmissionEvent,
  Stamped | "snapshot" | "finding"
> & {
  /** `serverId` defaults to the submission's own server. */
  snapshot?: Omit<
    NonNullable<DirectorySubmissionEvent["snapshot"]>,
    "serverId"
  > & { serverId?: string };
  /** `directory` defaults to the submission's own. */
  finding?: Omit<
    NonNullable<DirectorySubmissionEvent["finding"]>,
    "directory"
  > & {
    directory?: "claude" | "openai";
  };
  idempotencyKey?: string;
};

export interface PlatformDirectorySubmissionSnapshotsView {
  submissionId: string;
  snapshots: DirectorySubmissionSnapshots;
  /** Asked for with `compare`: the diff between the two labels' revisions. */
  comparison?: {
    from: DirectorySnapshotLabel;
    to: DirectorySnapshotLabel;
    diff: PlatformServerRevisionDiff;
  };
}
