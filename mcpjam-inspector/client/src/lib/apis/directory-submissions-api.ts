/**
 * The Readiness page's directory submissions, through the SDK's own client
 * and the transport `directory-readiness-api.ts` gives it, so `authFetch`
 * owns the bearer and renews it on a 401. A run started here is polled with
 * that module's run reads.
 */
import type { DirectoryFlow } from "@mcpjam/sdk/browser";
import type {
  PlatformDirectorySubmissionEvent,
  PlatformDirectorySubmissionEventBody,
  PlatformDirectorySubmissionPlugin,
  PlatformDirectorySubmissionSummary,
  PlatformDirectorySubmissionUpdateBody,
  PlatformDirectorySubmissionView,
} from "@mcpjam/sdk/platform";
import { readinessPlatformClient as client } from "@/lib/apis/directory-readiness-api";

export type SubmissionView = PlatformDirectorySubmissionView;
export type SubmissionSummary = PlatformDirectorySubmissionSummary;
export type SubmissionPlugin = PlatformDirectorySubmissionPlugin;
export type SubmissionScope = { projectId: string; submissionId: string };
export type SubmissionEvent = PlatformDirectorySubmissionEvent;
export type SubmissionEventBody = PlatformDirectorySubmissionEventBody;

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

/**
 * A ChatGPT plugin's run also names the stored version it grades. Naming a
 * saved test plan revision authorizes that plan's calls; without one, the
 * run calls none of the server's tools.
 */
export const startDirectorySubmissionRun = (
  scope: SubmissionScope,
  idempotencyKey: string,
  pluginVersionId?: string,
  testPlanRevision?: number,
) =>
  client().startDirectorySubmissionRun({
    ...scope,
    idempotencyKey,
    pluginVersionId,
    testPlanRevision,
  });

/** A retry with the same `idempotencyKey` is answered from the first write. */
export const recordSubmissionEvent = (
  scope: SubmissionScope,
  body: SubmissionEventBody,
): Promise<SubmissionEvent> =>
  client().recordDirectorySubmissionEvent({ ...scope, ...body });
