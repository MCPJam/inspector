import { Hono } from "hono";
import { ErrorCode, WebRouteError } from "../web/errors.js";

const publicModels = new Hono();
const TIMEOUT_MS = 15_000;

// GET /v1/models — intentionally mounted before bearer auth. The backing
// catalog is public and contains no user/project data.
publicModels.get("/models", async (c) => {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(new URL("/v1/models", convexUrl), {
      method: "GET",
      signal: controller.signal,
    });
    const body = await response.json();
    const contentType = response.headers.get("content-type");
    if (contentType) c.header("content-type", contentType);
    return c.json(body as Record<string, unknown>, response.status as any);
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new WebRouteError(
      aborted ? 504 : 502,
      aborted ? ErrorCode.TIMEOUT : ErrorCode.SERVER_UNREACHABLE,
      aborted
        ? `Models catalog timed out after ${TIMEOUT_MS}ms`
        : "Failed to reach the models catalog"
    );
  } finally {
    clearTimeout(timeoutId);
  }
});

export default publicModels;
