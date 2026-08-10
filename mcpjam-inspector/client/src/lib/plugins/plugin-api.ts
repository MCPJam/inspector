/**
 * Pure (non-hook) helpers for the plugin import API: the tracked bundle
 * upload and structured error mapping. Hook wrappers live in
 * `client/src/hooks/usePluginImportApi.ts`.
 */

import { PluginApiError, type PluginApiErrorCode } from "./plugin-api-types";
import { MAX_PLUGIN_BUNDLE_COMPRESSED_BYTES } from "@/shared/plugin-bundle-limits";

/**
 * Re-exported so existing import sites keep working; the value now lives in
 * `shared/` because the local materializer route enforces the same cap.
 * Used here to reject an oversized ZIP before burning a tracked-upload
 * rate-limit token; the backend re-enforces it at the upload route,
 * `createImport`, and inspect time.
 */
export { MAX_PLUGIN_BUNDLE_COMPRESSED_BYTES };

/**
 * Default upload timeout. Generous enough for a full 25 MB bundle on a slow
 * uplink (25 MB at ~1 Mbps ≈ 3.5 min); overridable per call.
 */
export const DEFAULT_PLUGIN_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

/** Compressed byte size of a bundle in either accepted representation. */
export function pluginBundleByteSize(bundle: Blob | Uint8Array): number {
  return bundle instanceof Blob ? bundle.size : bundle.byteLength;
}

/**
 * Throw `ARCHIVE_TOO_LARGE_COMPRESSED` when a bundle exceeds the backend's
 * compressed cap. Call this BEFORE hitting the tracked upload route — it is
 * rate-limited, so an oversized bundle must not burn a token on an upload
 * that can never be imported.
 */
export function assertPluginBundleWithinCap(bundle: Blob | Uint8Array): void {
  if (pluginBundleByteSize(bundle) > MAX_PLUGIN_BUNDLE_COMPRESSED_BYTES) {
    throw new PluginApiError(
      "ARCHIVE_TOO_LARGE_COMPRESSED",
      "The plugin bundle exceeds the maximum compressed size (25 MB).",
    );
  }
}

/**
 * Upload a plugin bundle through the TRACKED route (`POST
 * /plugin-bundle-upload` on the Convex site URL) and return the storage id
 * to pass to `plugins.createImport`.
 *
 * Unlike a minted upload URL — whose resulting storageId only the client
 * ever learns, so an abandoned blob is unreclaimable storage — the tracked
 * route stores the blob server-side, records it with a TTL, and the backend
 * sweeps whatever `createImport` never adopts. REQUIRED for guests (minted
 * URLs refuse them); used for every actor so there is exactly one upload
 * path.
 */
export async function uploadPluginBundleTracked(args: {
  /** Convex HTTP actions base URL (`getConvexSiteUrl()`). */
  siteUrl: string;
  projectId: string;
  bundle: Blob | Uint8Array;
  /** Convex bearer (WorkOS or guest) — the route authorizes with it. */
  bearerToken: string;
  fetchImpl?: typeof fetch;
  /** Abort the upload after this many ms (default 5 minutes). */
  timeoutMs?: number;
}): Promise<string> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? DEFAULT_PLUGIN_UPLOAD_TIMEOUT_MS;
  const body =
    args.bundle instanceof Blob
      ? args.bundle
      : new Blob([args.bundle as unknown as BlobPart], {
          type: "application/zip",
        });
  assertPluginBundleWithinCap(body);

  const url = new URL("/plugin-bundle-upload", args.siteUrl);
  url.searchParams.set("projectId", args.projectId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  let payload: {
    ok?: unknown;
    storageId?: unknown;
    code?: unknown;
    error?: unknown;
  } | null;
  try {
    try {
      response = await fetchImpl(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
          Authorization: `Bearer ${args.bearerToken}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new PluginApiError(
          "UPLOAD_FAILED",
          `Bundle upload timed out after ${timeoutMs}ms`,
        );
      }
      throw new PluginApiError(
        "UPLOAD_FAILED",
        `Bundle upload failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // `fetch` resolves on response HEADERS; the body read below rides the
    // same abort signal, so the timer must stay armed until the JSON lands
    // or a stalled body would hang the import modal forever.
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      if (controller.signal.aborted) {
        throw new PluginApiError(
          "UPLOAD_FAILED",
          `Bundle upload timed out after ${timeoutMs}ms`,
        );
      }
      payload = null;
    }
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    // The route returns the backend's stable codes (RATE_LIMITED, FORBIDDEN,
    // ARCHIVE_TOO_LARGE_COMPRESSED, ...) — surface them structurally so the
    // modal renders the matching remedy instead of a generic failure.
    const code =
      typeof payload?.code === "string"
        ? (payload.code as PluginApiErrorCode)
        : "UPLOAD_FAILED";
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : `Bundle upload failed with status ${response.status}`;
    throw new PluginApiError(code, message);
  }
  const storageId = payload?.storageId;
  if (typeof storageId !== "string" || storageId.length === 0) {
    throw new PluginApiError(
      "UPLOAD_FAILED",
      "Bundle upload did not return a storage id",
    );
  }
  return storageId;
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
