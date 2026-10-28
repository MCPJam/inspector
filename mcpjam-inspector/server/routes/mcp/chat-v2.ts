import { Hono } from "hono";
import { HOSTED_MODE } from "../../config.js";
import { localManagedIngress } from "../../services/chat-turn/local-managed-ingress.js";
import {
  assertStandaloneConversation,
  normalizeLocalManagedRequest,
} from "../../services/chat-turn/local-request.js";
import { runStandaloneTurn } from "../../services/chat-turn/standalone-turn.js";
import { handleManagedChatTurn } from "../web/chat-v2.js";
import {
  WebRouteError,
  webErrorFromRoute,
  mapRuntimeError,
} from "../web/errors.js";
import {
  AppToolValidationError,
  PageToolValidationError,
  WidgetModelContextValidationError,
} from "../../utils/chat-v2-orchestration.js";
import {
  ClientInputError,
  readRequestJson,
  reportRouteFailureForResponse,
} from "../../utils/route-error-report.js";

const chatV2 = new Hono();
chatV2.post("/", async (c) => {
  if (HOSTED_MODE)
    return c.json(
      { error: "Local chat is unavailable on a hosted service." },
      410,
    );
  try {
    const raw: unknown = await readRequestJson(c);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return c.json({ error: "A chat request object is required" }, 400);
    }
    const body = raw as Record<string, unknown>;
    if (
      body.projectId !== undefined ||
      body.executionTarget !== undefined ||
      body.hostId !== undefined ||
      body.scenarioId !== undefined ||
      (Array.isArray(body.selectedServerIds) && body.selectedServerIds.length)
    ) {
      return await localManagedIngress(c, async (context) =>
        handleManagedChatTurn(
          context,
          "local",
          await normalizeLocalManagedRequest(context, body),
        ),
      );
    }
    if (
      process.env.CONVEX_HTTP_URL &&
      c.req.header("authorization") &&
      typeof body.chatSessionId === "string" &&
      body.chatSessionId
    ) {
      return await localManagedIngress(c, async (context) => {
        await assertStandaloneConversation(
          context,
          body.chatSessionId as string,
        );
        return runStandaloneTurn(context, {
          ...body,
          messages: Array.isArray(body.messages) ? body.messages : [],
        });
      });
    }
    return await runStandaloneTurn(c, {
      ...body,
      messages: Array.isArray(body.messages) ? body.messages : [],
    });
  } catch (error) {
    if (error instanceof ClientInputError)
      return c.json({ error: error.message }, 400);
    if (error instanceof WebRouteError) {
      const response = webErrorFromRoute(c, mapRuntimeError(error));
      const envelope = await response.json();
      return new Response(
        JSON.stringify({
          ...envelope,
          error: error.message,
          code:
            typeof error.details?.code === "string"
              ? error.details.code
              : error.code,
        }),
        response,
      );
    }
    if (
      error instanceof AppToolValidationError ||
      error instanceof PageToolValidationError ||
      error instanceof WidgetModelContextValidationError
    ) {
      return c.json({ error: error.message }, 400);
    }
    const { origin } = reportRouteFailureForResponse(
      "[mcp/chat-v2] failed to process chat request",
      error,
      {
        source: "mcp.chat-v2",
        hop: "mcpjam_internal",
      },
    );
    c.header("x-mcpjam-error-origin", origin);
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to process chat request",
      },
      500,
    );
  }
});
export default chatV2;
