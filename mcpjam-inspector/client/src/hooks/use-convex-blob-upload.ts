import { useCallback } from "react";

import { uploadBlobWithBearer } from "@/lib/convex-blob-upload";
import type { BlobUploadBody, BlobUploadScope } from "@/shared/blob-upload";
import { useConvexAccessToken } from "./use-convex-access-token";

/**
 * Upload bytes through the backend's upload route as the current actor — the
 * signed-in user, or the guest (see `@/shared/blob-upload`, MJ-006).
 *
 * The returned function resolves with the storage id to hand to the usual
 * create/attach mutation, and rejects with a `BlobUploadError` whose message
 * is ready to show.
 */
export function useConvexBlobUpload() {
  const getConvexAccessToken = useConvexAccessToken();
  return useCallback(
    (scope: BlobUploadScope, body: BlobUploadBody, contentType: string) =>
      uploadBlobWithBearer(getConvexAccessToken, scope, body, contentType),
    [getConvexAccessToken],
  );
}
