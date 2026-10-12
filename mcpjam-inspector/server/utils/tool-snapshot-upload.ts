import { uploadBlob, type BlobUploadScope } from "@/shared/blob-upload";

const INLINE_SNAPSHOT_BYTES = 256 * 1024;
const UPLOAD_TIMEOUT_MS = 10_000;

type ToolSnapshotScope = Extract<BlobUploadScope, { purpose: "tool-snapshot" }>;

/** Upload large catalogs before a Convex function receives its bounded args. */
export async function prepareToolSnapshotTransport<T>(args: {
  snapshot: T;
  bearerToken?: string;
  scope: ToolSnapshotScope;
  siteUrl?: string;
}): Promise<{ toolSnapshot?: T; toolSnapshotBlobId?: string }> {
  if (!args.snapshot) return {};
  const body = JSON.stringify(args.snapshot);
  if (Buffer.byteLength(body, "utf8") > 19 * 1024 * 1024) {
    throw new Error("Tool snapshots must be 19 MiB or smaller");
  }
  if (
    Buffer.byteLength(body, "utf8") <= INLINE_SNAPSHOT_BYTES &&
    (!args.bearerToken || !/"\$[^"\r\n]*"\s*:/.test(body))
  ) {
    return { toolSnapshot: args.snapshot };
  }
  const siteUrl = args.siteUrl ?? process.env.CONVEX_HTTP_URL;
  if (!siteUrl || !args.bearerToken) {
    throw new Error("Large tool snapshots require an authenticated upload");
  }
  const toolSnapshotBlobId = await uploadBlob({
    siteUrl,
    bearerToken: args.bearerToken,
    scope: args.scope,
    body,
    contentType: "application/json",
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  return { toolSnapshotBlobId };
}

/** Full catalog evidence belongs to the archive, never to inline debug args. */
export function toolSnapshotDiagnostics(debug?: Record<string, unknown>) {
  return debug
    ? Object.fromEntries(
        Object.entries(debug).filter(([key]) => key !== "fullSnapshot"),
      )
    : undefined;
}
