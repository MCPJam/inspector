/**
 * The Readiness page's directory submissions, through the SDK's own client
 * and the transport `directory-readiness-api.ts` gives it, so `authFetch`
 * owns the bearer and renews it on a 401. A run started here is polled with
 * that module's run reads.
 */
import type { DirectoryFlow } from "@mcpjam/sdk/browser";
import type {
  PlatformDirectorySubmissionFinding,
  PlatformDirectorySubmissionHandoff,
  PlatformDirectorySubmissionSummary,
  PlatformDirectorySubmissionUpdateBody,
  PlatformDirectorySubmissionView,
} from "@mcpjam/sdk/platform";
import { readinessPlatformClient as client } from "@/lib/apis/directory-readiness-api";

export type SubmissionView = PlatformDirectorySubmissionView;
export type SubmissionSummary = PlatformDirectorySubmissionSummary;
export type SubmissionHandoff = PlatformDirectorySubmissionHandoff;
export type SubmissionScope = { projectId: string; submissionId: string };
export type StoredFinding = PlatformDirectorySubmissionFinding;

/** The flow as served by the API that stamps its wording on each write. */
export const getDirectoryFlow = (flowId: string): Promise<DirectoryFlow> =>
  client().getDirectoryFlow({ flowId });

export async function listServerSubmissions(
  projectId: string,
  serverId: string,
  signal?: AbortSignal,
): Promise<SubmissionSummary[]> {
  const page = await client().listDirectorySubmissions(
    { projectId, serverId },
    { signal },
  );
  return page.items;
}

export const createDirectorySubmission = (
  scope: { projectId: string; serverId: string; flowId: string },
  idempotencyKey: string,
) => client().createDirectorySubmission({ ...scope, idempotencyKey });

export const getDirectorySubmission = (scope: SubmissionScope) =>
  client().getDirectorySubmission(scope);

/** A `409` names the fields that changed: read it with `directorySubmissionConflict`. */
export const updateDirectorySubmission = (
  scope: SubmissionScope,
  body: PlatformDirectorySubmissionUpdateBody,
) => client().updateDirectorySubmission({ ...scope, ...body });

export const startDirectorySubmissionRun = (
  scope: SubmissionScope,
  idempotencyKey: string,
) => client().startDirectorySubmissionRun({ ...scope, idempotencyKey });

/** Where to resume, built from the record on every read, as an agent reads it. */
export const getDirectorySubmissionHandoff = (
  scope: SubmissionScope,
  signal?: AbortSignal,
): Promise<SubmissionHandoff> =>
  client().getDirectorySubmissionHandoff(scope, { signal });

/** The pack as a file. `content` is its exact bytes: save it as it is. */
export const exportDirectorySubmission = (
  scope: SubmissionScope,
  format: "json" | "markdown",
) => client().exportDirectorySubmission({ ...scope, format });

/** One check's stored result, with the observation behind it in `details`. */
export const getSubmissionFinding = (
  scope: SubmissionScope,
  checkId: string,
  signal?: AbortSignal,
): Promise<StoredFinding> =>
  client().getDirectorySubmissionFinding({ ...scope, checkId }, { signal });
