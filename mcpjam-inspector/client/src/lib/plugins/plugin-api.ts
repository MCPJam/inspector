/**
 * Pure (non-hook) helpers for the plugin import API: the direct-to-storage
 * bundle upload and structured error mapping. Hook wrappers live in
 * `client/src/hooks/usePluginImportApi.ts`.
 */

import { PluginApiError, type PluginApiErrorCode } from "./plugin-api-types";

/**
 * Mirror of the backend's compressed-bundle cap
 * (mcpjam-backend convex/lib/pluginArchiveLimits.ts, DEFAULT_ARCHIVE_LIMITS).
 * Used to reject an oversized ZIP before burning an upload-URL rate-limit
 * token; the backend re-enforces it at `createImport` and inspect time.
 */
export const MAX_PLUGIN_BUNDLE_COMPRESSED_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * Upload a plugin bundle ZIP to a Convex storage upload URL (minted by
 * `plugins.generateBundleUploadUrl`) and return the storage id to pass to
 * `plugins.createImport`.
 */
export async function uploadPluginBundleToUrl(
  uploadUrl: string,
  bundle: Blob | Uint8Array,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body =
    bundle instanceof Blob
      ? bundle
      : new Blob([bundle as unknown as BlobPart], {
          type: "application/zip",
        });
  if (body.size > MAX_PLUGIN_BUNDLE_COMPRESSED_BYTES) {
    throw new PluginApiError(
      "ARCHIVE_TOO_LARGE_COMPRESSED",
      "The plugin bundle exceeds the maximum compressed size (25 MB).",
    );
  }

  let response: Response;
  try {
    response = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body,
    });
  } catch (error) {
    throw new PluginApiError(
      "UPLOAD_FAILED",
      `Bundle upload failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) {
    throw new PluginApiError(
      "UPLOAD_FAILED",
      `Bundle upload failed with status ${response.status}`,
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    storageId?: unknown;
  } | null;
  if (!payload || typeof payload.storageId !== "string") {
    throw new PluginApiError(
      "UPLOAD_FAILED",
      "Bundle upload did not return a storage id",
    );
  }
  return payload.storageId;
}

/**
 * Map an unknown rejection from a plugin Convex call to a structured
 * `PluginApiError`. Convex `ConvexError` payloads land on `err.data` — the
 * backend throws `{code, message}` records with stable codes (`FORBIDDEN`,
 * `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `ARCHIVE_TOO_LARGE_COMPRESSED`),
 * optional `details`, and for RATE_LIMITED a `scope` + `retryAfter`.
 * `err.message` for an application error is the redacted "Server Error"
 * string, so it is only a fallback.
 */
export function toPluginApiError(
  err: unknown,
  fallbackMessage = "Plugin request failed",
): PluginApiError {
  if (err instanceof PluginApiError) return err;

  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data: unknown }).data;
    if (typeof data === "string" && data.trim()) {
      return new PluginApiError("UNKNOWN", data.slice(0, 400));
    }
    if (data && typeof data === "object") {
      const record = data as Record<string, unknown>;
      const code =
        typeof record.code === "string" && record.code
          ? (record.code as PluginApiErrorCode)
          : "UNKNOWN";
      const message =
        typeof record.message === "string" && record.message.trim()
          ? record.message.slice(0, 400)
          : fallbackMessage;
      return new PluginApiError(code, message, {
        scope: typeof record.scope === "string" ? record.scope : undefined,
        retryAfter:
          typeof record.retryAfter === "number" ? record.retryAfter : undefined,
        details:
          record.details && typeof record.details === "object"
            ? (record.details as Record<string, string>)
            : undefined,
      });
    }
  }

  if (err instanceof Error && err.message) {
    return new PluginApiError(
      "UNKNOWN",
      err.message.replace(/^\[.*?\]\s*/, "").slice(0, 400) || fallbackMessage,
    );
  }
  return new PluginApiError("UNKNOWN", fallbackMessage);
}
