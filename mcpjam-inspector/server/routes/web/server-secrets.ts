import { Hono } from "hono";
import {
  ErrorCode,
  WebRouteError,
  mapRuntimeError,
  webError,
} from "./errors.js";

const serverSecretsWeb = new Hono();
const EDIT_REVEAL_TIMEOUT_MS = 20_000;

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

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      EDIT_REVEAL_TIMEOUT_MS
    );
    let response: Response;
    try {
      response = await fetch(`${convexUrl}/web/server/reveal-secrets`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify({ ...payload, purpose: "edit" }),
        signal: controller.signal,
      });
    } catch (error) {
      const isAbort =
        error instanceof Error &&
        (error.name === "AbortError" ||
          (error as { code?: string }).code === "ABORT_ERR");
      if (isAbort) {
        throw new WebRouteError(
          504,
          ErrorCode.TIMEOUT,
          "Couldn't reveal saved secrets. Try again."
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

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
