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

const chatboxes = new Hono();

const chatboxBootstrapSchema = z.object({
  token: z.string().min(1),
});

chatboxes.post("/bootstrap", async (c) =>
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
      chatboxBootstrapSchema,
      await readJsonBody<unknown>(c),
    );

    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      response = await fetch(`${convexUrl}/chatbox/bootstrap`, {
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
          "Chatbox bootstrap service timed out",
        );
      }
      throw new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        `Failed to reach chatbox bootstrap service: ${parseErrorMessage(error)}`,
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
              `Chatbox bootstrap failed (${response.status})`;
      if (response.status === 404 && message === "No matching routes found") {
        message =
          "Configured Convex deployment does not expose /chatbox/bootstrap. Check CONVEX_HTTP_URL and VITE_CONVEX_URL.";
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
        "Chatbox bootstrap response was missing payload",
      );
    }

    return payload.payload;
  }),
);

// Phase E: token redemption. The landing page calls this on mount to
// exchange its URL token for `{ chatboxId, role, mode, projectId,
// accessVersion, bootstrap }`. Once the inspector stores `chatboxId` +
// `accessVersion`, subsequent calls do NOT need the token.
//
// Implementation is a thin forward to the Convex /web/chatbox/redeem
// endpoint — the backend handles rate limits, audit, and access grants.
const chatboxRedeemSchema = z.object({
  chatboxToken: z.string().min(1),
});

chatboxes.post("/redeem", async (c) =>
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
      chatboxRedeemSchema,
      await readJsonBody<unknown>(c),
    );

    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      response = await fetch(`${convexUrl}/web/chatbox/redeem`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({ chatboxToken: body.chatboxToken }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new WebRouteError(
          504,
          ErrorCode.SERVER_UNREACHABLE,
          "Chatbox redeem service timed out",
        );
      }
      throw new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        `Failed to reach chatbox redeem service: ${parseErrorMessage(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    const responseText = await response.text();
    const trimmed = responseText.trim();
    let payload: any = null;
    try {
      payload = trimmed ? JSON.parse(trimmed) : null;
    } catch {
      // ignored
    }

    if (!response.ok || payload?.ok !== true) {
      const message =
        typeof payload?.error === "string"
          ? payload.error
          : trimmed || `Chatbox redeem failed (${response.status})`;
      const code =
        response.status === 401
          ? ErrorCode.UNAUTHORIZED
          : response.status === 403
            ? ErrorCode.FORBIDDEN
            : response.status === 404
              ? ErrorCode.NOT_FOUND
              : response.status === 429
                ? ErrorCode.UNAUTHORIZED
                : ErrorCode.INTERNAL_ERROR;
      throw new WebRouteError(response.status || 500, code, message);
    }

    return {
      chatboxId: payload.chatboxId,
      role: payload.role,
      mode: payload.mode,
      projectId: payload.projectId ?? null,
      accessVersion: payload.accessVersion,
      bootstrap: payload.bootstrap,
    };
  }),
);

export default chatboxes;
