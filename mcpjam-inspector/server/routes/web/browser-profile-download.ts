/**
 * `POST /api/web/browser-profiles/download` — a saved browser profile archive,
 * as bytes (MJ-005).
 *
 * The backend runs the owner check and tells THIS server where the archive
 * is; this server reads it and streams it on. The browser receives the
 * archive bytes and nothing else — the location stays server-side, exactly
 * as it does when a browser boot imports the profile
 * (`BrowserSessionService.downloadProfile`).
 *
 * An archive can be up to 256 MB, so it is never buffered here.
 */
import type { Context } from "hono";
import { z } from "zod";
import {
  ErrorCode,
  WebRouteError,
  mapRuntimeError,
  parseWithSchema,
  readJsonBody,
  webErrorFromRoute,
} from "./auth.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { getConfiguredInspectorServiceToken } from "../../middleware/internal-service-auth.js";
import {
  BrowserSessionService,
  BrowserSessionServiceError,
} from "../../services/browserd/session-service.js";
import { MAX_BROWSER_PROFILE_ARCHIVE_BYTES } from "../../services/browserd/profile-archive.js";
import { getRequestLogger } from "../../utils/request-logger.js";
import type { RequestEventMap } from "../../utils/log-events.js";

/** The owner check is small metadata: the same 10s as the proxied operations. */
const LOOKUP_TIMEOUT_MS = 10_000;
/** How long the archive's response headers may take to arrive. */
export const ARCHIVE_RESPONSE_TIMEOUT_MS = 30_000;
/**
 * Once the archive is streaming, how long it may go without a byte moving
 * before the transfer is cut. Deliberately not a deadline on the whole
 * transfer, which would cut a slow but steady 256 MB download; this only
 * cuts one that has stalled, on either side.
 */
export const ARCHIVE_IDLE_TIMEOUT_MS = 60_000;

const downloadBodySchema = z.object({
  projectId: z.string().trim().min(1).max(128),
  profileId: z.string().trim().min(1).max(128),
});

function archiveUnavailable(): WebRouteError {
  return new WebRouteError(
    502,
    ErrorCode.SERVER_UNREACHABLE,
    "The browser profile archive could not be read",
  );
}

/** The backend's refusal, as the matching web error. */
function refusalFor(status: number): WebRouteError {
  switch (status) {
    case 400:
      return new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "projectId and profileId are required",
      );
    case 401:
      return new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        "Missing or invalid bearer token",
      );
    case 403:
      return new WebRouteError(
        403,
        ErrorCode.FORBIDDEN,
        "Not authorized for this browser profile",
      );
    case 404:
      return new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "Browser profile not found",
      );
    default:
      return archiveUnavailable();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportFailure(
  c: Context,
  payload: RequestEventMap["browser_profile.download.failed"],
): void {
  getRequestLogger(c, "routes.web.browser-profiles").event(
    "browser_profile.download.failed",
    payload,
  );
}

/** Ask the backend where the caller's archive is. */
async function resolveArchiveLocation(
  c: Context,
  ids: { projectId: string; profileId: string },
): Promise<URL> {
  const baseUrl = process.env.CONVEX_HTTP_URL?.trim();
  if (!baseUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration",
    );
  }
  // The backend names an archive location only to a caller that also holds
  // the inspector service token.
  if (!getConfiguredInspectorServiceToken()) {
    throw new WebRouteError(
      503,
      ErrorCode.INTERNAL_ERROR,
      "Browser profile downloads are not available on this server",
    );
  }
  const bearer = await getConvexBearerForRequest(c);
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const location = await new BrowserSessionService({
      baseUrl,
      enabled: true,
    }).resolveProfileArchive({
      ...ids,
      bearer,
      signal: AbortSignal.any([deadline.signal, c.req.raw.signal]),
    });
    if (!location) throw refusalFor(404);
    return location;
  } catch (error) {
    if (error instanceof WebRouteError) throw error;
    if (error instanceof BrowserSessionServiceError) {
      throw refusalFor(error.status);
    }
    // A caller that hung up gets its own abort back.
    if (c.req.raw.signal.aborted) throw error;
    if (deadline.signal.aborted) {
      throw new WebRouteError(
        504,
        ErrorCode.TIMEOUT,
        "Browser profile request timed out",
      );
    }
    // A transport failure, or a location this server will not read from.
    reportFailure(c, { stage: "lookup", errorMessage: errorMessage(error) });
    throw archiveUnavailable();
  } finally {
    clearTimeout(timeout);
  }
}

/** The length the archive's server declared, when it still applies. */
function declaredLength(response: Response): number | null {
  // A body the fetch decoded no longer has the length declared for it.
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.trim().toLowerCase() !== "identity") return null;
  const value = response.headers.get("content-length")?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * The archive body, passed through chunk by chunk. Cut — and the upstream
 * read cancelled — when no chunk moves for `ARCHIVE_IDLE_TIMEOUT_MS` or the
 * archive runs past the size limit. A cut stream errors rather than ending,
 * so the browser sees an incomplete download, never a short one.
 */
function streamWithLimits(
  body: ReadableStream<Uint8Array>,
  transfer: AbortController,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let received = 0;
  let cut = false;
  let idle: ReturnType<typeof setTimeout> | undefined;

  const stop = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    reason: Error,
  ) => {
    clearTimeout(idle);
    if (cut) return;
    cut = true;
    transfer.abort();
    reader.cancel(reason).catch(() => undefined);
    controller.error(reason);
  };
  const armIdle = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    clearTimeout(idle);
    idle = setTimeout(
      () => stop(controller, new Error("browser profile archive stalled")),
      ARCHIVE_IDLE_TIMEOUT_MS,
    );
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      armIdle(controller);
    },
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        stop(
          controller,
          error instanceof Error ? error : new Error(errorMessage(error)),
        );
        return;
      }
      if (cut) return;
      if (chunk.done) {
        clearTimeout(idle);
        controller.close();
        return;
      }
      received += chunk.value.byteLength;
      if (received > MAX_BROWSER_PROFILE_ARCHIVE_BYTES) {
        stop(
          controller,
          new Error("browser profile archive exceeds the 256 MB limit"),
        );
        return;
      }
      controller.enqueue(chunk.value);
      armIdle(controller);
    },
    cancel(reason) {
      clearTimeout(idle);
      cut = true;
      transfer.abort();
      return reader.cancel(reason).catch(() => undefined);
    },
  });
}

function archiveFilename(profileId: string): string {
  const safe = profileId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return safe ? `browser-profile-${safe}.tar.gz` : "browser-profile.tar.gz";
}

async function streamArchive(
  c: Context,
  location: URL,
  profileId: string,
): Promise<Response> {
  // One controller for the whole transfer: the response deadline, the idle
  // cut and the size cut all end the same upstream read.
  const transfer = new AbortController();
  const responseTimeout = setTimeout(
    () => transfer.abort(),
    ARCHIVE_RESPONSE_TIMEOUT_MS,
  );
  let upstream: Response;
  try {
    upstream = await fetch(location, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.any([transfer.signal, c.req.raw.signal]),
    });
  } catch (error) {
    if (c.req.raw.signal.aborted) throw error;
    if (transfer.signal.aborted) {
      throw new WebRouteError(
        504,
        ErrorCode.TIMEOUT,
        "Browser profile download timed out",
      );
    }
    reportFailure(c, { stage: "archive", errorMessage: errorMessage(error) });
    throw archiveUnavailable();
  } finally {
    clearTimeout(responseTimeout);
  }

  if (!upstream.ok || !upstream.body) {
    // Unread, the body holds its connection until GC.
    await upstream.body?.cancel().catch(() => undefined);
    reportFailure(c, { stage: "archive", statusCode: upstream.status });
    throw upstream.status === 404 ? refusalFor(404) : archiveUnavailable();
  }
  const length = declaredLength(upstream);
  if (length !== null && length > MAX_BROWSER_PROFILE_ARCHIVE_BYTES) {
    await upstream.body.cancel().catch(() => undefined);
    reportFailure(c, {
      stage: "archive",
      errorMessage: "browser profile archive exceeds the 256 MB limit",
    });
    throw archiveUnavailable();
  }

  // Headers are built here, never copied from the upstream response.
  return new Response(streamWithLimits(upstream.body, transfer), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${archiveFilename(profileId)}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(length !== null ? { "Content-Length": String(length) } : {}),
    },
  });
}

export async function downloadBrowserProfile(c: Context): Promise<Response> {
  try {
    const { projectId, profileId } = parseWithSchema(
      downloadBodySchema,
      await readJsonBody(c),
    );
    const location = await resolveArchiveLocation(c, { projectId, profileId });
    return await streamArchive(c, location, profileId);
  } catch (error) {
    // The same mapping the proxied operations get from `handleRoute`.
    return webErrorFromRoute(c, mapRuntimeError(error));
  }
}
