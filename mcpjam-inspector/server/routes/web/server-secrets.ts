import { Hono } from "hono";
import {
  ErrorCode,
  WebRouteError,
  mapRuntimeError,
  webError,
} from "./errors.js";

const serverSecretsWeb = new Hono();

function getConvexHttpUrl(): string {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }
  return convexUrl;
}

serverSecretsWeb.post("/reveal-secrets", async (c) => {
  try {
    const convexUrl = getConvexHttpUrl();
    const authorization = c.req.header("authorization");
    const payload = await c.req.json();
    if (payload?.purpose === "runtime") {
      return webError(
        c,
        403,
        ErrorCode.FORBIDDEN,
        "Runtime secret reveal is not available from browser routes"
      );
    }

    const response = await fetch(`${convexUrl}/web/server/reveal-secrets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify({ ...payload, purpose: "edit" }),
    });

    return new Response(await response.text(), {
      status: response.status,
      headers: {
        "Content-Type":
          response.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webError(c, routeError.status, routeError.code, routeError.message);
  }
});

export default serverSecretsWeb;
