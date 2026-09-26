/** Hosted proxy for the durable browser-profile control plane. */
import { Hono } from "hono";
import { ErrorCode, WebRouteError, handleRoute, readJsonBody } from "./auth.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { downloadBrowserProfile } from "./browser-profile-download.js";
import { handleBrowserProfileUpload } from "./browser-profile-upload.js";

/**
 * Same 10s ceiling as the chat-history proxy, and for the same reason: a
 * stalled Convex call must fail as a 504 rather than hold the request open
 * until something upstream gives up. Without it the Save button spins for
 * minutes with nothing to show for it.
 *
 * Safe at 10s for every operation here because NONE of them carries archive
 * bytes — the (up to 256 MB) archive goes in through `/upload`
 * (`browser-profile-upload.ts`) and out through `/download`
 * (`browser-profile-download.ts`), each with its own bounds, so everything this
 * proxy sees is small metadata.
 */
const DEFAULT_PROXY_TIMEOUT_MS = 10_000;

const browserProfiles = new Hono();

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

async function proxyPost(
  c: Parameters<typeof getConvexBearerForRequest>[0],
  path: string,
  body: unknown,
): Promise<unknown> {
  const bearer = await getConvexBearerForRequest(c);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_PROXY_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${convexHttpUrl()}/browser-profiles/${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        // BOTH signals: the caller hanging up still cancels the upstream call,
        // and the timeout still fires when the caller is content to wait.
        signal: AbortSignal.any([controller.signal, c.req.raw.signal]),
      },
    );
    const responseBody = await response.json().catch(() => null);
    if (!response.ok) {
      const errorBody = responseBody as {
        error?: unknown;
        code?: unknown;
      } | null;
      throw new WebRouteError(
        response.status,
        typeof errorBody?.code === "string"
          ? (errorBody.code as ErrorCode)
          : ErrorCode.INTERNAL_ERROR,
        typeof errorBody?.error === "string" ? errorBody.error : "Backend error",
      );
    }
    return responseBody;
  } catch (error) {
    if (error instanceof WebRouteError) throw error;
    // Only OUR deadline becomes a 504. A caller that hung up gets its own
    // abort back, not a message claiming the backend was slow.
    if (
      error instanceof Error &&
      error.name === "AbortError" &&
      controller.signal.aborted
    ) {
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

for (const operation of ["commit", "list", "default", "delete"] as const) {
  browserProfiles.post(`/${operation}`, async (c) =>
    handleRoute(c, async () => proxyPost(c, operation, await readJsonBody(c))),
  );
}

// Archive bytes in, storage id out (MJ-006).
browserProfiles.post("/upload", handleBrowserProfileUpload);

// MJ-005. Streams the archive bytes after the backend's owner check, with its
// own deadlines (see browser-profile-download.ts).
browserProfiles.post("/download", downloadBrowserProfile);

export default browserProfiles;
