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
import { redeemChatboxToken } from "../../utils/chatbox-redeem.js";

const chatboxes = new Hono();

// Token redemption. The landing page calls this on mount to exchange its
// URL token for `{ chatboxId, role, mode, projectId, accessVersion,
// bootstrap }`. Once the inspector stores `chatboxId` + `accessVersion`,
// subsequent calls do NOT need the token — every read-path route accepts
// `chatboxId` directly.
//
// Thin forward to the Convex /web/chatbox/redeem endpoint; the backend
// handles rate limits, audit, and access-grant writes. The fetch/parse
// logic lives in utils/chatbox-redeem.ts so non-route callers can reuse
// it.
const chatboxRedeemSchema = z.object({
  chatboxToken: z.string().min(1),
});

function mapRedeemStatusToErrorCode(status: number): ErrorCode {
  if (status === 401) return ErrorCode.UNAUTHORIZED;
  if (status === 403) return ErrorCode.FORBIDDEN;
  if (status === 404) return ErrorCode.NOT_FOUND;
  if (status === 429) return ErrorCode.RATE_LIMITED;
  if (status === 502 || status === 503 || status === 504) {
    return ErrorCode.SERVER_UNREACHABLE;
  }
  return ErrorCode.INTERNAL_ERROR;
}

chatboxes.post("/redeem", async (c) =>
  handleRoute(c, async () => {
    if (!process.env.CONVEX_HTTP_URL) {
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let result;
    try {
      result = await redeemChatboxToken({
        chatboxToken: body.chatboxToken,
        bearer: bearerToken,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!result.ok) {
      throw new WebRouteError(
        result.status || 500,
        mapRedeemStatusToErrorCode(result.status),
        result.error,
      );
    }

    return {
      chatboxId: result.chatboxId,
      role: result.role,
      mode: result.mode,
      projectId: result.projectId,
      accessVersion: result.accessVersion,
      bootstrap: result.bootstrap,
    };
  }),
);

export default chatboxes;
