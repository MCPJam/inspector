/**
 * Where a graded iteration's grading archive is stored (EFTW-90). The
 * member's bearer and this server's service token go with the request, like
 * `resolveEvalRunAttachments`. Kept out of `control-plane-client.ts`, which
 * has no room left to grow.
 */
import {
  memberAndServiceHeaders,
  postJson,
  type ControlPlaneResult,
} from "./control-plane-client.js";

/** Where one grading archive goes, and the grant that confirms it. */
export interface GradingFilesUploadDestination {
  uploadUrl: string;
  uploadGrantId: string;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Ask where to store a graded iteration's archive. Any refusal, including the
 * 404 of a backend without the feature, means skip the upload. Nobody retries
 * a network failure here, so it logs at warn rather than paging.
 */
export async function requestGradingFilesUploadUrl(args: {
  bearer: string;
  runId: string;
  iterationId: string;
  signal?: AbortSignal;
}): Promise<ControlPlaneResult<GradingFilesUploadDestination>> {
  const result = await postJson<Record<string, unknown> | null>(
    "/evals/grading-files/upload-url",
    memberAndServiceHeaders(args.bearer),
    { runId: args.runId, iterationId: args.iterationId },
    args.signal,
    { quietNetworkErrors: true },
  );
  if (!result.ok) return result;
  const uploadUrl = nonEmpty(result.value?.uploadUrl);
  const uploadGrantId = nonEmpty(result.value?.uploadGrantId);
  return uploadUrl && uploadGrantId
    ? { ok: true, value: { uploadUrl, uploadGrantId } }
    : { ok: false, status: 502, error: "no usable upload destination" };
}
