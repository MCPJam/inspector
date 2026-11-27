/**
 * One `api_v1_request_completed` PostHog event per Platform API request.
 *
 * Answers "which customers use the API, which operations, from which client,
 * with what failure rate", across the MCP worker, the CLI, the SDK and raw
 * HTTP. `requestLogContextMiddleware` calls this once the response is known,
 * because it already holds the route pattern, status and duration.
 *
 * Hosted only: a self-hosted install is not ours to count per request.
 *
 * Privacy: route PATTERNS, never paths; no bodies, query strings, error
 * messages or raw user agents. The agent is reduced to a known family
 * (`mcpClientFamily`). The transport's allowlist
 * (`shared/strict-server-analytics.ts`) drops anything else on the way out.
 */

import type { Context } from "hono";
import { mcpClientFamily } from "@mcpjam/sdk/internal/telemetry";
import { HOSTED_MODE } from "../config.js";
import { captureServerEventForActor } from "./analytics.js";
import { readClientDeclaration } from "./launch-context.js";
import type { RequestLogContext } from "./log-events.js";

export type V1UsageFacts = {
  /** Route pattern the request was aimed at, e.g. `/api/v1/projects/:id`. */
  route: string;
  status: number;
  durationMs: number;
  /** A stream reports at open, so `durationMs` is time to first byte. */
  streamed: boolean;
};

export type ApiSurface = "mcp" | "cli" | "sdk" | "api";

const SDK_USER_AGENT_TOKEN = "mcpjam-sdk/";

export function isV1Path(path: string): boolean {
  return path === "/api/v1" || path.startsWith("/api/v1/");
}

/**
 * What the client says it is. Declared, never verified: a caller can mislabel
 * its own traffic, which skews a chart and grants nothing.
 */
export function resolveSurface(
  declaredKind: string | undefined,
  userAgent: string | undefined,
): ApiSurface {
  if (declaredKind === "mcp") return "mcp";
  if (declaredKind === "cli" || declaredKind === "github_action") return "cli";
  if (userAgent?.includes(SDK_USER_AGENT_TOKEN)) return "sdk";
  return "api";
}

function outcomeFor(status: number): "ok" | "client_error" | "server_error" {
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "ok";
}

/**
 * The analytics actorKey: the WorkOS user id or the guest id, as the client
 * uses. `analyticsUserId` covers worker and CLI tokens, which bearer auth
 * passes through without a verified user.
 */
function resolveDistinctId(c: Context): string | undefined {
  const ctx = c.var.requestLogContext as RequestLogContext | undefined;
  return (
    c.get("analyticsUserId") ??
    c.get("workosUserId") ??
    ctx?.userExternalId ??
    ctx?.guestExternalId ??
    c.get("guestId") ??
    undefined
  );
}

export function recordV1Usage(c: Context, facts: V1UsageFacts): void {
  if (!HOSTED_MODE || !isV1Path(c.req.path)) return;
  const distinctId = resolveDistinctId(c);
  if (!distinctId) return;

  const ctx = c.var.requestLogContext as RequestLogContext | undefined;
  const client = readClientDeclaration(c);
  const meta =
    c.var.webErrorMeta?.status === facts.status ? c.var.webErrorMeta : undefined;
  const organizationId = c.get("mcpjamOrganizationId") ?? ctx?.orgId;
  const projectId = ctx?.projectId;
  const agent = mcpClientFamily(client?.client);

  captureServerEventForActor(
    { distinctId },
    "api_v1_request_completed",
    {
      method: c.req.method,
      operation: `${c.req.method} ${facts.route}`,
      http_status: facts.status,
      outcome: outcomeFor(facts.status),
      ...(meta?.code ? { error_code: meta.code } : {}),
      duration_ms: facts.durationMs,
      streamed: facts.streamed,
      auth_method: c.get("authMethod") ?? "none",
      surface: resolveSurface(client?.kind, c.req.header("user-agent")),
      ...(agent ? { mcp_client: agent } : {}),
      is_guest: c.get("authMethod") === "guest",
      ...(organizationId ? { organization_id: organizationId } : {}),
      ...(projectId ? { project_id: projectId } : {}),
    },
    { batched: true },
  );
}
