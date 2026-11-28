/**
 * Store a graded iteration's grading archive (EFTW-90), so "Test on a past
 * iteration" can later grade a draft on exactly what the run graded.
 *
 * Best effort, and never at the iteration's expense: bounded by its own
 * limit and by what is left of the iteration's clock, and any failure is
 * logged and returns nothing. The storage id comes back only once the backend
 * confirmed the upload, so the terminal `updateTestIteration` names it only
 * then, and a backend without the feature never sees the field.
 *
 *   1. `requestGradingFilesUploadUrl` → `{ uploadUrl, uploadGrantId }`
 *      (any refusal, the 404 of an older backend included, means skip);
 *   2. the tar to `uploadUrl` → `{ storageId }`;
 *   3. the trusted receipt (`confirmUploadedObject`).
 */
import { requestGradingFilesUploadUrl } from "../../../utils/computers/grading-files-client.js";
import {
  getConvexHttpUrl,
  getServiceToken,
} from "../../../utils/computers/control-plane-client.js";
import { logger } from "../../../utils/logger.js";
import { isUsableStorageDestination } from "../../../utils/storage-destination.js";
import { confirmUploadedObject } from "../../../utils/upload-receipt.js";
import { buildGradingArchive } from "./grading-archive.js";
import type { GradingBoxInput } from "./iteration-phases.js";

/** The whole upload, every request in it. */
export const GRADING_ARCHIVE_UPLOAD_TIMEOUT_MS = 30_000;

export type GradingArchiveUpload = {
  runId: string;
  iterationId: string;
  /** The bearer the run writes with, read when the upload starts. */
  bearer: () => string;
  input: GradingBoxInput;
  /** What is left for the upload; nothing is sent when it is not positive. */
  timeoutMs: number;
  signal?: AbortSignal;
};

/** The storage id in the storage's answer, if it holds one. */
function storageIdOf(text: string): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: no storage id, which the caller reports.
    return undefined;
  }
  const storageId =
    body && typeof body === "object"
      ? (body as { storageId?: unknown }).storageId
      : undefined;
  return typeof storageId === "string" && storageId ? storageId : undefined;
}

async function postArchive(
  uploadUrl: string,
  archive: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
): Promise<string> {
  if (!isUsableStorageDestination(uploadUrl)) {
    throw new Error("the upload destination is not usable");
  }
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-tar" },
    body: archive,
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new Error(`storage refused the archive (${response.status})`);
  }
  const storageId = storageIdOf(await response.text());
  if (!storageId) throw new Error("storage answered without a storage id");
  return storageId;
}

/**
 * Upload the archive of what `input` gave the grading box, and return its
 * storage id once confirmed. `undefined` whenever it isn't stored. Never
 * throws.
 */
export async function uploadGradingArchive(
  upload: GradingArchiveUpload,
): Promise<string | undefined> {
  const serviceToken = getServiceToken();
  const convexHttpUrl = getConvexHttpUrl();
  // A server without the service token (a local install) never stores one.
  if (!serviceToken || !convexHttpUrl || upload.timeoutMs <= 0) {
    return undefined;
  }
  const log = { runId: upload.runId, iterationId: upload.iterationId };
  try {
    const archive = buildGradingArchive(upload.input);
    if (!archive) {
      logger.warn("[evals] grading archive is over 64 MB; not stored", log);
      return undefined;
    }
    // Inside the `try`: a renewing bearer the backend stopped renewing throws.
    const bearer = upload.bearer();
    const timeout = AbortSignal.timeout(upload.timeoutMs);
    const signal = upload.signal
      ? AbortSignal.any([upload.signal, timeout])
      : timeout;
    const destination = await requestGradingFilesUploadUrl({
      bearer,
      runId: upload.runId,
      iterationId: upload.iterationId,
      signal,
    });
    if (!destination.ok) {
      const context = { ...log, status: destination.status };
      const message = "[evals] grading archive not stored: no destination";
      // 404 is a backend without the feature, expected while deploys catch
      // up, so it stays out of the warnings.
      if (destination.status === 404) logger.info(message, context);
      else logger.warn(message, context);
      return undefined;
    }
    const storageId = await postArchive(
      destination.value.uploadUrl,
      archive,
      signal,
    );
    await confirmUploadedObject({
      convexHttpUrl,
      bearer,
      serviceToken,
      uploadGrantId: destination.value.uploadGrantId,
      storageId,
      signal,
    });
    return storageId;
  } catch (error) {
    logger.warn("[evals] grading archive not stored; the iteration goes on", {
      ...log,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
