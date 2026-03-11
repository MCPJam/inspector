import { Hono } from "hono";
import { z } from "zod";
import {
  ErrorCode,
  WebRouteError,
  assertBearerToken,
  handleRoute,
  parseErrorMessage,
  parseWithSchema,
  readJsonBody,
} from "./auth.js";

const sandboxes = new Hono();

const sandboxBootstrapSchema = z.object({
  token: z.string().min(1),
});

sandboxes.post("/bootstrap", async (c) =>
  handleRoute(c, async () => {
    const convexUrl = process.env.CONVEX_HTTP_URL;
    if (!convexUrl) {
      throw new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        "Server missing CONVEX_HTTP_URL configuration",
      );
    }

    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      sandboxBootstrapSchema,
      await readJsonBody<unknown>(c),
    );

    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      response = await fetch(`${convexUrl}/sandbox/bootstrap`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({ token: body.token }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new WebRouteError(
          504,
          ErrorCode.SERVER_UNREACHABLE,
          "Sandbox bootstrap service timed out",
        );
      }
      throw new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        `Failed to reach sandbox bootstrap service: ${parseErrorMessage(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    const responseText = await response.text();
    const trimmedResponseText = responseText.trim();
    let payload: any = null;
    try {
      payload = trimmedResponseText ? JSON.parse(trimmedResponseText) : null;
    } catch {
      // ignored
    }

    if (!response.ok) {
      let message =
        typeof payload?.error === "string"
          ? payload.error
          : typeof payload?.message === "string"
            ? payload.message
            : trimmedResponseText ||
              `Sandbox bootstrap failed (${response.status})`;
      if (response.status === 404 && message === "No matching routes found") {
        message =
          "Configured Convex deployment does not expose /sandbox/bootstrap. Check CONVEX_HTTP_URL and VITE_CONVEX_URL.";
      }
      const code =
        response.status === 401
          ? ErrorCode.UNAUTHORIZED
          : response.status === 403
            ? ErrorCode.FORBIDDEN
            : response.status === 404
              ? ErrorCode.NOT_FOUND
              : ErrorCode.INTERNAL_ERROR;
      throw new WebRouteError(response.status, code, message);
    }

    if (!payload?.ok || !payload?.payload) {
      throw new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        "Sandbox bootstrap response was missing payload",
      );
    }

    return payload.payload;
  }),
);

export default sandboxes;
