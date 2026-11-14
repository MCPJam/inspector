import { isPersistRetryHandle, MAX_PERSIST_RETRY_HANDLE_CHARS } from "../../../shared/persist-receipt.js";
import { abortable } from "../../services/sessionSimulation/target-discovery.js";
import { Hono } from "hono";
import { z } from "zod";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { requireVerifiedAuth } from "../../middleware/require-verified-auth.js";
import { completedTurnPersistence } from "../../services/completed-turn-persistence.js";
import {
  attemptChatIngest,
  buildPersistReceiptData,
} from "../../utils/chat-ingestion.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  authorizeProject,
  callerContextFromHono,
  readJsonBody,
  parseWithSchema,
  webErrorFromRoute,
} from "./auth.js";
import { mapWebBoundaryError } from "./boundary-error.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";

const bodySchema = z
  .object({
    retryHandle: z.string().max(MAX_PERSIST_RETRY_HANDLE_CHARS).refine(isPersistRetryHandle),
    projectId: z.string().min(1),
    chatSessionId: z.string().min(1),
    turnId: z.string().min(1),
  })
  .strict();
const routes = new Hono();
routes.use("*", bearerAuthMiddleware, requireVerifiedAuth());
routes.post("/", async (c) => {
  try {
    const body = parseWithSchema(bodySchema, await readJsonBody(c));
    const subject = c.get("workosUserId");
    if (typeof subject !== "string" || !subject || c.get("guestId"))
      return c.json({ error: "Sign in to save this reply." }, 401);
    const result = await completedTurnPersistence.retry(
      body.retryHandle,
      {
        subject,
        projectId: body.projectId,
        chatSessionId: body.chatSessionId,
        turnId: body.turnId,
      },
      async (serialized, signal) => {
        const token = await abortable(getConvexBearerForRequest(c), signal);
        await abortable(
          authorizeProject(callerContextFromHono(c), token, body.projectId),
          signal,
        );
        signal.throwIfAborted();
        const attempt = await attemptChatIngest(
          `${process.env.CONVEX_HTTP_URL}/ingest-chat`,
          {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          serialized,
          10_000,
          signal,
        );
        return attempt.kind === "settled"
          ? attempt.outcome
          : {
              outcome: "failed",
              failureKind: attempt.failureKind,
              status: attempt.status,
            };
      },
    );
    if (result === "missing")
      return c.json({ error: "This reply can no longer be saved here." }, 404);
    if (result === "busy")
      return c.json({ error: "This reply is already being saved." }, 409);
    return c.json(buildPersistReceiptData(result, body));
  } catch (error) {
    reportRouteFailure("Failed to save a completed chat turn", error, {
      source: "chat.persistence.retry",
      hop: "mcpjam_internal",
    });
    return webErrorFromRoute(c, mapWebBoundaryError(error));
  }
});
export default routes;
