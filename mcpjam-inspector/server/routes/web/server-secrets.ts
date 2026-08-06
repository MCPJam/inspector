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

async function callConvexReveal(
  authorization: string | undefined,
  payload: unknown
): Promise<Response> {
  const convexUrl = getConvexHttpUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EDIT_REVEAL_TIMEOUT_MS);
  try {
    return await fetch(`${convexUrl}/web/server/reveal-secrets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify({
        ...(payload && typeof payload === "object" ? payload : {}),
        purpose: "edit",
      }),
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
}

function passThrough(response: Response, body: string): Response {
  return new Response(body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") ?? "application/json",
    },
  });
}

/** Names of the keys in a `{ KEY: value }` secret record, values discarded. */
function recordKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value as Record<string, unknown>);
}

serverSecretsWeb.post("/reveal-secrets", async (c) => {
  try {
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

    const response = await callConvexReveal(authorization, payload);
    return passThrough(response, await response.text());
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webError(c, routeError.status, routeError.code, routeError.message);
  }
});

/**
 * Names of a server's stored env vars / headers, without their values.
 *
 * The redacted server record carries only `hasEnv: boolean`, so the edit form
 * cannot say *which* variables are set without asking. Asking for the values to
 * learn their names would put every secret in the browser for a question that
 * never needed them — so the reveal response is unwrapped here and only the key
 * names travel on. Values reach the browser only through `/reveal-secrets`,
 * which the user gets to by clicking a row's eye.
 *
 * Be clear about what that does and doesn't buy. This still calls the reveal
 * endpoint, so Convex decrypts the whole set to answer a question about names —
 * the saving is that the plaintext dies in this process instead of crossing to
 * the client. Expanding a disclosure therefore still *reaches* the reveal path,
 * which matters if it is audit-logged: an expand would look like a read.
 *
 * The fix for that is upstream and not in this repo: have the server record
 * carry `envKeys` / `headerKeys` next to `hasEnv`, on a payload already being
 * sent, and this route can go away entirely along with the request it costs.
 */
serverSecretsWeb.post("/secret-keys", async (c) => {
  try {
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

    const response = await callConvexReveal(authorization, payload);
    const body = await response.text();
    if (!response.ok) {
      // Upstream failures carry no secrets, and the client's retry affordance
      // reads their status.
      return passThrough(response, body);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new WebRouteError(
        502,
        ErrorCode.INTERNAL_ERROR,
        "Couldn't read this server's saved keys. Try again."
      );
    }

    const result =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    if (!result?.success) {
      throw new WebRouteError(
        502,
        ErrorCode.INTERNAL_ERROR,
        "Couldn't read this server's saved keys. Try again."
      );
    }

    return c.json({
      success: true,
      envKeys: recordKeys(result.env),
      headerKeys: recordKeys(result.headers),
    });
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webError(c, routeError.status, routeError.code, routeError.message);
  }
});

export default serverSecretsWeb;
