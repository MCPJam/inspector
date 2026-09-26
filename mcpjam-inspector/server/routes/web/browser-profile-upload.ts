/**
 * `POST /api/web/browser-profiles/upload?projectId=…` — store a browser
 * profile archive (MJ-006).
 *
 * The browser posts the archive's raw bytes here. This process asks the
 * backend where to store them on the caller's behalf, streams the bytes
 * there, and answers with the storage id alone; the client then commits the
 * profile exactly as before. The archive (up to 256 MB) is streamed through,
 * never held whole in memory.
 *
 * The global `/api/web/*` 1 MB body cap exempts this path
 * (`middleware/web-body-limit.ts`); the cap below is the one that applies.
 */
import type { Context } from "hono";
import { HOSTED_MODE } from "../../config.js";
import {
  getConfiguredInspectorServiceToken,
  INSPECTOR_SERVICE_TOKEN_HEADER,
} from "../../middleware/internal-service-auth.js";
import { logger } from "../../utils/logger.js";
import { isUsableStorageDestination } from "../../utils/storage-destination.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { ErrorCode, WebRouteError, handleRoute } from "./auth.js";

export const MAX_BROWSER_PROFILE_ARCHIVE_BYTES = 256 * 1024 * 1024;

/** Asking the backend for a destination is small metadata; bound it tightly. */
const DESTINATION_TIMEOUT_MS = 10_000;

/**
 * Moving the archive itself runs at the browser's upload speed, so the bound
 * is generous — but a stalled storage write still ends as a 504 instead of
 * holding the request open.
 */
const ARCHIVE_UPLOAD_TIMEOUT_MS = 15 * 60_000;

const UPLOAD_FAILED_MESSAGE =
  "The browser profile archive could not be uploaded.";

function convexHttpUrl(): string {
  const url = process.env.CONVEX_HTTP_URL;
  if (!url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration",
    );
  }
  return url;
}

/** The declared body length, or null when absent or malformed. */
function declaredLength(header: string | undefined): number | null {
  if (!header || !/^\d+$/.test(header.trim())) return null;
  const length = Number(header.trim());
  return Number.isSafeInteger(length) ? length : null;
}

/**
 * Where to store one archive, asked for on the caller's behalf.
 *
 * With the inspector service credential, the backend's internal route checks
 * the caller's bearer against the project and answers. A local install holds
 * no service credential, so it asks the backend's per-user route instead; a
 * hosted deployment without one is misconfigured and refuses.
 */
async function requestArchiveDestination(
  c: Context,
  projectId: string,
): Promise<string> {
  const serviceToken = getConfiguredInspectorServiceToken();
  if (!serviceToken && HOSTED_MODE) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing INSPECTOR_SERVICE_TOKEN configuration",
    );
  }
  const bearer = await getConvexBearerForRequest(c);
  const path = serviceToken
    ? "/internal/v1/browser-profiles/upload-url"
    : "/browser-profiles/upload-url";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DESTINATION_TIMEOUT_MS);
  try {
    const response = await fetch(`${convexHttpUrl()}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        ...(serviceToken
          ? { [INSPECTOR_SERVICE_TOKEN_HEADER]: serviceToken }
          : {}),
      },
      body: JSON.stringify({ projectId }),
      signal: AbortSignal.any([controller.signal, c.req.raw.signal]),
    });
    const body = (await response.json().catch(() => null)) as {
      uploadUrl?: unknown;
      code?: unknown;
      error?: unknown;
    } | null;
    if (!response.ok) {
      throw new WebRouteError(
        response.status,
        typeof body?.code === "string"
          ? (body.code as ErrorCode)
          : ErrorCode.INTERNAL_ERROR,
        typeof body?.error === "string" ? body.error : "Backend error",
      );
    }
    if (!isUsableStorageDestination(body?.uploadUrl)) {
      throw new WebRouteError(
        502,
        ErrorCode.INTERNAL_ERROR,
        UPLOAD_FAILED_MESSAGE,
      );
    }
    return body.uploadUrl;
  } catch (error) {
    if (error instanceof WebRouteError) throw error;
    if (controller.signal.aborted) {
      throw new WebRouteError(
        504,
        ErrorCode.TIMEOUT,
        "Browser profile request timed out",
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The request body, passed through as it arrives, refusing anything past
 * `maxBytes` (the declared length is already checked; this holds the stream
 * to it).
 */
function limitedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(
            new Error("Browser profile archive exceeded its declared length"),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

export function handleBrowserProfileUpload(c: Context) {
  return handleRoute(c, async () => {
    const projectId = c.req.query("projectId")?.trim();
    if (!projectId) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "projectId is required",
      );
    }
    const length = declaredLength(c.req.header("content-length"));
    if (length === null) {
      throw new WebRouteError(
        411,
        ErrorCode.VALIDATION_ERROR,
        "Content-Length is required",
      );
    }
    if (length > MAX_BROWSER_PROFILE_ARCHIVE_BYTES) {
      throw new WebRouteError(
        413,
        ErrorCode.VALIDATION_ERROR,
        "The browser profile archive exceeds the 256 MB limit.",
      );
    }
    const body = c.req.raw.body;
    if (length === 0 || !body) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "The browser profile archive is empty.",
      );
    }

    const destination = await requestArchiveDestination(c, projectId);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      ARCHIVE_UPLOAD_TIMEOUT_MS,
    );
    try {
      const response = await fetch(destination, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(length),
        },
        body: limitedBody(body, length),
        // Streamed through, never buffered: Node requires half duplex for a
        // stream body.
        duplex: "half",
        redirect: "error",
        signal: AbortSignal.any([controller.signal, c.req.raw.signal]),
      } as RequestInit & { duplex: "half" });
      const stored = (await response.json().catch(() => null)) as {
        storageId?: unknown;
      } | null;
      if (
        !response.ok ||
        typeof stored?.storageId !== "string" ||
        !stored.storageId
      ) {
        logger.warn("[browser-profiles] archive storage refused the upload", {
          status: response.status,
          projectId,
        });
        throw new WebRouteError(
          502,
          ErrorCode.INTERNAL_ERROR,
          UPLOAD_FAILED_MESSAGE,
        );
      }
      return { storageId: stored.storageId };
    } catch (error) {
      if (error instanceof WebRouteError) throw error;
      if (controller.signal.aborted) {
        throw new WebRouteError(
          504,
          ErrorCode.TIMEOUT,
          "Browser profile upload timed out",
        );
      }
      // A caller that hung up gets its own abort back.
      if (c.req.raw.signal.aborted) throw error;
      logger.warn("[browser-profiles] archive upload failed", {
        projectId,
        error: error instanceof Error ? error.name : "unknown",
      });
      throw new WebRouteError(
        502,
        ErrorCode.INTERNAL_ERROR,
        UPLOAD_FAILED_MESSAGE,
      );
    } finally {
      clearTimeout(timeout);
    }
  });
}
