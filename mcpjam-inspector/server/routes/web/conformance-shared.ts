/**
 * Public read of a shared conformance run. The token in the URL is the whole
 * credential — same shape as `/api/web/score/runs/:token`.
 *
 * NO BEARER AUTH. A forwarded link must open in an incognito window. The
 * backend returns only the aggressively redacted public artifact.
 */
import { Hono } from "hono";
import { ErrorCode, WebRouteError } from "./errors.js";

const shared = new Hono();
const BACKEND_PATH = "/v1/conformance/shared";
const BACKEND_TIMEOUT_MS = 15_000;

shared.get("/:token", async (c) => {
  const token = c.req.param("token");
  if (!token) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "Missing token");
  }
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }

  let response: Response;
  try {
    const target = new URL(BACKEND_PATH, convexUrl);
    target.searchParams.set("token", token);
    response = await fetch(target, {
      method: "GET",
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
      redirect: "manual",
    });
  } catch {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      "Failed to load shared conformance run"
    );
  }

  if (response.status >= 300 && response.status < 400) {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      "Shared conformance lookup redirected"
    );
  }

  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new WebRouteError(
      response.status === 404 ? 404 : 502,
      response.status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.SERVER_UNREACHABLE,
      "Shared conformance run not found"
    );
  }

  c.header("x-robots-tag", "noindex, nofollow");
  c.header("cache-control", "private, no-store");
  return c.json(body ?? {}, response.status as never);
});

export default shared;
