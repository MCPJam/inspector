import { getApiAuthorizationHeader } from "@/lib/apis/web/context";
import { getConvexSiteUrl } from "@/lib/convex-site-url";
import {
  BlobUploadError,
  uploadBlob,
  type BlobUploadBody,
  type BlobUploadScope,
} from "@/shared/blob-upload";

/**
 * Upload bytes through the backend's upload route (`@/shared/blob-upload`,
 * MJ-006) with the Convex bearer `getBearerToken` resolves. Resolves with the
 * storage id; rejects with a {@link BlobUploadError} whose message is ready to
 * show.
 */
export async function uploadBlobWithBearer(
  getBearerToken: () => Promise<string | null | undefined>,
  scope: BlobUploadScope,
  body: BlobUploadBody,
  contentType: string,
): Promise<string> {
  const siteUrl = getConvexSiteUrl();
  if (!siteUrl) {
    throw new BlobUploadError(
      "Uploads are not available right now.",
      0,
      "NOT_CONFIGURED",
    );
  }
  const bearerToken = await getBearerToken();
  if (!bearerToken) {
    throw new BlobUploadError(
      "Your session has expired. Sign in again and retry.",
      401,
      "UNAUTHORIZED",
    );
  }
  return await uploadBlob({ siteUrl, bearerToken, scope, body, contentType });
}

/**
 * {@link uploadBlobWithBearer} as the actor the `/api/web/*` calls
 * authenticate as. For code outside React; components use
 * `useConvexBlobUpload`.
 */
export function uploadBlobAsApiActor(
  scope: BlobUploadScope,
  body: BlobUploadBody,
  contentType: string,
): Promise<string> {
  return uploadBlobWithBearer(
    async () =>
      (await getApiAuthorizationHeader())?.replace(/^Bearer\s+/i, "").trim(),
    scope,
    body,
    contentType,
  );
}
