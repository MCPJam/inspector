import { useCallback } from "react";

import { getConvexSiteUrl } from "@/lib/convex-site-url";
import {
  ImageUploadError,
  uploadImage,
  type ImageUploadTarget,
} from "@/lib/image-upload";
import { useConvexAccessToken } from "./use-convex-access-token";

/**
 * Upload a profile picture or organization logo through the backend's
 * upload routes (see `@/lib/image-upload`). The returned function rejects
 * with an {@link ImageUploadError} whose message is ready to show.
 */
export function useImageUpload() {
  const getConvexAccessToken = useConvexAccessToken();
  return useCallback(
    async (target: ImageUploadTarget, file: File) => {
      const siteUrl = getConvexSiteUrl();
      if (!siteUrl) {
        throw new ImageUploadError(
          "Image uploads are not available right now.",
          0,
          "NOT_CONFIGURED",
        );
      }
      const bearerToken = await getConvexAccessToken();
      if (!bearerToken) {
        throw new ImageUploadError(
          "Your session expired. Sign in again to upload an image.",
          401,
          "UNAUTHORIZED",
        );
      }
      return await uploadImage({ siteUrl, bearerToken, target, file });
    },
    [getConvexAccessToken],
  );
}
