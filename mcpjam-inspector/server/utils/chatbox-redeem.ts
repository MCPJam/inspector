/**
 * Chatbox token redemption.
 *
 * Calls `/web/chatbox/redeem` on the Convex HTTP layer to exchange a
 * chatbox link token for a `chatboxId` + `chatboxAccess` grant. Once
 * redeemed, the inspector forwards the `chatboxId` (NOT the token) on
 * every subsequent hot-path request.
 *
 * The bearer is required: WorkOS bearer for signed-in viewers, or a
 * guest JWT obtained via `/guest/session` for anonymous viewers in
 * `anyone_with_link` mode. Anonymous redemption is rejected by the
 * backend with 401.
 */

import { logger } from "./logger.js";

export type ChatboxRedeemBootstrapServer = {
  serverId: string;
  serverName: string;
  useOAuth: boolean;
  serverUrl: string | null;
  clientId: string | null;
  oauthScopes: string[] | null;
  optional: boolean;
};

/**
 * Full bootstrap payload returned by `/web/chatbox/redeem`. Mirrors the
 * shape inspector clients previously fetched from `/chatbox/bootstrap`,
 * so the landing page can validate this directly against
 * `ChatboxBootstrapPayload` before persisting the session.
 */
export type ChatboxRedeemBootstrap = {
  projectId: string | null;
  chatboxId: string;
  name: string;
  description: string | null;
  hostStyle: "claude" | "chatgpt" | string;
  mode: "project_members" | "invited_only" | "anyone_with_link";
  allowGuestAccess: boolean;
  viewerIsProjectMember: boolean;
  systemPrompt: string;
  modelId: string;
  temperature: number;
  requireToolApproval: boolean;
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
      // If the upstream returned 2xx but no parseable JSON, that's an
      // upstream contract violation — surface it as 502 so callers don't
      // treat the missing body as success.
      status: response.ok ? 502 : response.status,
      error: `Chatbox redeem returned ${response.status} with non-JSON body`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : `Chatbox redeem failed (${response.status})`,
    };
  }

  if (payload?.ok !== true) {
    // 2xx with `ok: false` (or missing) is also an upstream contract
    // violation — coerce to 502 so callers don't bubble a misleading 200.
    return {
      ok: false,
      status: 502,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : "Chatbox redeem response was missing ok=true",
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
