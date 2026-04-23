import {
  getRuntimeConvexSiteUrl,
  getRuntimeConvexUrl,
} from "@/lib/runtime-config";

/**
 * Derive the Convex HTTP actions URL (*.convex.site) from the Convex client URL.
 */
export function getConvexSiteUrl(): string | null {
  const runtimeSiteUrl = getRuntimeConvexSiteUrl();
  if (runtimeSiteUrl) return runtimeSiteUrl;

  const siteUrl = import.meta.env.VITE_CONVEX_SITE_URL as string | undefined;
  if (siteUrl) return siteUrl;

  const cloudUrl =
    getRuntimeConvexUrl() ??
    (import.meta.env.VITE_CONVEX_URL as string | undefined);
  if (cloudUrl && typeof cloudUrl === "string") {
    return cloudUrl.replace(".convex.cloud", ".convex.site");
  }
  return null;
}
