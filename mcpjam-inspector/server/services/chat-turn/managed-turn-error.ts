import type { Context } from "hono";
import { isMCPAuthError } from "@mcpjam/sdk";
import { pluginChatRefusal } from "../../routes/web/chat-v2-plugin-refusal.js";
import type { createHostedRpcLogCollector } from "../../routes/web/hosted-rpc-logs.js";
import {
  ErrorCode,
  webError,
  webErrorFromRoute,
  mapTargetServerError,
  projectRouteFailure,
} from "../../routes/web/auth.js";

/** Map a managed turn failure without changing its response origin or log scope. */
export function managedTurnFailureResponse(
  c: Context,
  error: unknown,
  oauthServerUrls: Record<string, string>,
  rpcCollector?: Pick<ReturnType<typeof createHostedRpcLogCollector>, "buildEnvelope">,
): Response {
  // Enrich MCPAuthError with OAuth server URL so the client can initiate OAuth
  if (isMCPAuthError(error) && Object.keys(oauthServerUrls).length > 0) {
    const firstUrl = Object.values(oauthServerUrls)[0];
    const msg = error instanceof Error ? error.message : String(error);
    return webError(
      c,
      401,
      ErrorCode.UNAUTHORIZED,
      msg,
      {
        oauthRequired: true,
        serverUrl: firstUrl,
      },
      rpcCollector?.buildEnvelope() as Record<string, unknown> | undefined,
    );
  }
  const pluginRefusal = pluginChatRefusal(error);
  if (pluginRefusal)
    return webError(
      c,
      pluginRefusal.status,
      pluginRefusal.code,
      pluginRefusal.message,
      pluginRefusal.details,
    );
  // Keep the normalized origin verdict and project upstream response bodies.
  // This route talks to caller-selected MCP servers, so target-server errors
  // are classified here rather than on unrelated Convex-only routes.
  const routeError = mapTargetServerError(error);
  const envelope = rpcCollector?.buildEnvelope() as
    Record<string, unknown> | undefined;
  const projected =
    routeError.code === ErrorCode.UPSTREAM_HTTP_ERROR
      ? projectRouteFailure(routeError, error, envelope)
      : { routeError, logs: envelope };
  return webErrorFromRoute(c, projected.routeError, projected.logs);
}
