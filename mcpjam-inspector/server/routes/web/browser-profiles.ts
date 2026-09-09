/** Hosted proxy for the durable browser-profile control plane. */
import { Hono } from "hono";
import { ErrorCode, WebRouteError, handleRoute, readJsonBody } from "./auth.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";

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
  const response = await fetch(`${convexHttpUrl()}/browser-profiles/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: c.req.raw.signal,
  });
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
}

for (const operation of [
  "upload-url",
  "commit",
  "list",
  "default",
  "download-url",
  "delete",
] as const) {
  browserProfiles.post(`/${operation}`, async (c) =>
    handleRoute(c, async () => proxyPost(c, operation, await readJsonBody(c))),
  );
}

export default browserProfiles;
