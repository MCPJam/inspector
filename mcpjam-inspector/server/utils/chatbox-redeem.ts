/**
 * Chatbox token redemption (Phase E scaffolding).
 *
 * Calls `/web/chatbox/redeem` on the Convex HTTP layer to exchange a
 * chatbox link token for a `chatboxId` + `chatboxAccess` grant. Once
 * redeemed, the inspector forwards the `chatboxId` (NOT the token) on
 * every subsequent hot-path request.
 *
 * Usage from a route handler:
 *
 *   const result = await redeemChatboxToken({
 *     chatboxToken,
 *     bearer: req.headers.get("authorization") ?? "",
 *   });
 *   if (!result.ok) return c.json({ error: result.error }, result.status);
 *   // result.chatboxId, result.role, result.mode, result.projectId,
 *   // result.accessVersion, result.bootstrap
 *
 * The bearer is required: WorkOS bearer for signed-in viewers, or a
 * guest JWT obtained via `/guest/session` for anonymous viewers in
 * `anyone_with_link` mode. Anonymous redemption is rejected by the
 * backend with 401.
 *
 * TODO(chatbox-followup): wire this into:
 *   - server/routes/web/chat-v2.ts (replace `chatboxToken` plumbing
 *     with `chatboxId`; redeem first if frontend has only a token)
 *   - server/routes/web/auth.ts `fetchAuthorizeBatch` /
 *     `createAuthorizedManager` (drop `chatboxToken` arg)
 *   - server/routes/mcp/chat-v2.ts (owner-preview parity)
 *   - server/utils/hosted-oauth-refresh.ts (`forceRefreshHostedOAuthAccessToken`,
 *     `buildHostedOAuthUnauthorizedHandler` re-keyed by `chatboxId`)
 *   - server/utils/org-model-config.ts (cache key:
 *     `(chatboxId, projectId, userId, serverIds, accessVersion)`)
 *   - client/src/lib/chatbox-session.ts and the chatbox-link landing
 *     page (call this helper on mount, store
 *     `{ chatboxId, accessVersion, bootstrap }` in session state).
 */

import { logger } from "./logger.js";

export type ChatboxRedeemBootstrapServer = {
  serverId: string;
  serverName: string;
  useOAuth: boolean;
  serverUrl: string | null;
  clientId: string | null;
};

export type ChatboxRedeemBootstrap = {
  chatboxId: string;
  name: string;
  description: string | null;
  mode: "project_members" | "invited_only" | "anyone_with_link";
  welcomeDialog: unknown | null;
  feedbackDialog: unknown | null;
  servers: ChatboxRedeemBootstrapServer[];
};

export type ChatboxRedeemSuccess = {
  ok: true;
  chatboxId: string;
  role: "chat" | "admin";
  mode: "project_members" | "invited_only" | "anyone_with_link";
  projectId: string | null;
  accessVersion: number;
  bootstrap: ChatboxRedeemBootstrap;
};

export type ChatboxRedeemFailure = {
  ok: false;
  status: number;
  error: string;
};

export type ChatboxRedeemResult = ChatboxRedeemSuccess | ChatboxRedeemFailure;

function getConvexHttpUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is required for chatbox redeem");
  }
  return convexHttpUrl;
}

function buildRedeemUrl(): string {
  return (
    process.env.MCPJAM_CHATBOX_REDEEM_URL ||
    new URL("/web/chatbox/redeem", getConvexHttpUrl()).toString()
  );
}

export async function redeemChatboxToken(args: {
  chatboxToken: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<ChatboxRedeemResult> {
  const url = buildRedeemUrl();
  const authorization = args.bearer.startsWith("Bearer ")
    ? args.bearer
    : `Bearer ${args.bearer}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization,
      },
      body: JSON.stringify({ chatboxToken: args.chatboxToken }),
      signal: args.signal,
    });
  } catch (err) {
    logger.error("[chatbox-redeem] network error", err);
    return {
      ok: false,
      status: 502,
      error: "Failed to reach chatbox redeem endpoint",
    };
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.status,
      error: `Chatbox redeem returned ${response.status} with non-JSON body`,
    };
  }

  if (!response.ok || payload?.ok !== true) {
    return {
      ok: false,
      status: response.status,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : `Chatbox redeem failed (${response.status})`,
    };
  }

  return {
    ok: true,
    chatboxId: payload.chatboxId,
    role: payload.role,
    mode: payload.mode,
    projectId: payload.projectId ?? null,
    accessVersion: payload.accessVersion,
    bootstrap: payload.bootstrap,
  };
}
