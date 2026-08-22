/**
 * Bearer-forwarded proxies for the unified share redeem + artifact routes.
 * Token-in-URL HMAC serving stays on /conformance-shared until I6.
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  ErrorCode,
  WebRouteError,
  assertBearerToken,
  handleRoute,
  parseWithSchema,
  readJsonBody,
} from "./auth.js";
import {
  fetchShareArtifact,
  redeemShareToken,
} from "../../utils/share-redeem.js";

const shared = new Hono();
const BACKEND_TIMEOUT_MS = 15_000;

const redeemSchema = z.object({
  resourceType: z.enum(["scenario", "conformanceRun", "evalRun"]),
  token: z.string().min(1),
});

function mapStatus(status: number): ErrorCode {
  if (status === 401) return ErrorCode.UNAUTHORIZED;
  if (status === 403) return ErrorCode.FORBIDDEN;
  if (status === 404) return ErrorCode.NOT_FOUND;
  if (status === 429) return ErrorCode.RATE_LIMITED;
  if (status === 502 || status === 503 || status === 504) {
    return ErrorCode.SERVER_UNREACHABLE;
  }
  return ErrorCode.INTERNAL_ERROR;
}

shared.post("/redeem", async (c) =>
  handleRoute(c, async () => {
    if (!process.env.CONVEX_HTTP_URL) {
      throw new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        "Server missing CONVEX_HTTP_URL configuration",
      );
    }
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(redeemSchema, await readJsonBody<unknown>(c));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
    let result;
    try {
      result = await redeemShareToken({
        resourceType: body.resourceType,
        token: body.token,
        bearer: bearerToken,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!result.ok) {
      throw new WebRouteError(
        result.status || 502,
        mapStatus(result.status),
        result.error,
      );
    }
    c.header("x-robots-tag", "noindex, nofollow");
    c.header("cache-control", "private, no-store");
    return result;
  }),
);

shared.get("/:type/:id/artifact", async (c) => {
  if (!process.env.CONVEX_HTTP_URL) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration",
    );
  }
  const resourceType = c.req.param("type");
  const resourceId = c.req.param("id");
  if (
    resourceType !== "conformanceRun" &&
    resourceType !== "evalRun" &&
    resourceType !== "scenario"
  ) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "Invalid type");
  }
  const bearerToken = assertBearerToken(c);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
  let result;
  try {
    result = await fetchShareArtifact({
      resourceType,
      resourceId,
      bearer: bearerToken,
      signal: controller.signal,
    });
  } catch {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      "Failed to load shared artifact",
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!result.ok) {
    throw new WebRouteError(
      result.status === 403 ? 403 : result.status === 404 ? 404 : 502,
      result.status === 403
        ? ErrorCode.FORBIDDEN
        : result.status === 404
          ? ErrorCode.NOT_FOUND
          : ErrorCode.SERVER_UNREACHABLE,
      result.error,
    );
  }
  c.header("x-robots-tag", "noindex, nofollow");
  c.header("cache-control", "private, no-store");
  return c.json(result.body ?? {}, 200);
});

export default shared;
