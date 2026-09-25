import { Hono } from "hono";
import {
  ErrorCode,
  WebRouteError,
  assertBearerToken,
  readJsonBody,
} from "./errors.js";
import { handleRoute } from "./auth.js";
import { backendFailureRouteError } from "./backend-error.js";

const DEFAULT_PROXY_TIMEOUT_MS = 10_000;

/**
 * Fixed copy per backend status (MJ-020, MJ-021). The status and a recognized
 * code are what the backend decides; the words are ours.
 */
const FAILURE_MESSAGES: Record<number, string> = {
  400: "The chat history request was not valid.",
  401: "Sign in again to load chat history.",
  403: "You do not have access to this chat.",
  404: "Chat not found.",
  409: "This chat changed since it was loaded. Refresh and try again.",
  429: "Too many requests. Wait a moment and try again.",
};

function chatHistoryFailure(status: number, body: unknown) {
  return backendFailureRouteError({
    source: "chat-history",
    status,
    body,
    message: FAILURE_MESSAGES[status] ?? "Chat history request failed.",
  });
}

const chatHistory = new Hono();

function getConvexUrl(): string {
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

async function proxyGet(
  bearerToken: string,
  path: string,
  params: Record<string, string | undefined>,
): Promise<unknown> {
  const convexUrl = getConvexUrl();
  const url = new URL(`${convexUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    DEFAULT_PROXY_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    const body = await response.json();
    if (!response.ok) {
      throw chatHistoryFailure(response.status, body);
    }
    return body;
  } catch (error) {
    if (error instanceof WebRouteError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new WebRouteError(
        504,
        ErrorCode.TIMEOUT,
        "Chat history request timed out",
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function proxyPost(
  bearerToken: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  const convexUrl = getConvexUrl();

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    DEFAULT_PROXY_TIMEOUT_MS,
  );

  try {
    const response = await fetch(`${convexUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const responseBody = await response.json();
    if (!response.ok) {
      throw chatHistoryFailure(response.status, responseBody);
    }
    return responseBody;
  } catch (error) {
    if (error instanceof WebRouteError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new WebRouteError(
        504,
        ErrorCode.TIMEOUT,
        "Chat history request timed out",
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// GET /chat-history/list?projectId=...&status=active|archived&limit=50&before=...
chatHistory.get("/list", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const { projectId, status, limit, before } = c.req.query();
    return await proxyGet(bearerToken, "/direct-chat/list", {
      projectId,
      status,
      limit,
      before,
    });
  }),
);

// GET /chat-history/detail?sessionId=...&chatSessionId=...&projectId=...
chatHistory.get("/detail", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const { sessionId, chatSessionId, projectId } = c.req.query();
    if (!sessionId && !chatSessionId) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "sessionId or chatSessionId is required",
      );
    }
    const detail = await proxyGet(bearerToken, "/direct-chat/detail", {
      sessionId,
      chatSessionId,
      projectId,
    });
    // The detail carries short-lived artifact links minted for this caller;
    // nothing between here and the browser may keep a copy.
    c.header("cache-control", "private, no-store");
    return detail;
  }),
);

// POST /chat-history/action
// Body: { action: string, sessionId: string, ...params }
chatHistory.post("/action", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = await readJsonBody<Record<string, unknown>>(c);
    return await proxyPost(bearerToken, "/direct-chat/action", body);
  }),
);

// POST /chat-history/widget-snapshot/generate-upload-url
// Body: { chatSessionId: string }
chatHistory.post("/widget-snapshot/generate-upload-url", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = await readJsonBody<Record<string, unknown>>(c);
    return await proxyPost(
      bearerToken,
      "/direct-chat/widget-snapshot/generate-upload-url",
      body,
    );
  }),
);

// POST /chat-history/widget-snapshot/create
// Body: { chatSessionId, toolCallId, toolName, serverId, widgetHtmlBlobId, ... }
chatHistory.post("/widget-snapshot/create", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = await readJsonBody<Record<string, unknown>>(c);
    return await proxyPost(
      bearerToken,
      "/direct-chat/widget-snapshot/create",
      body,
    );
  }),
);

export default chatHistory;
