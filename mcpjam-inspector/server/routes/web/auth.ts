import { z } from "zod";
import { MCPClientManager } from "@mcpjam/sdk";
import type { HttpServerConfig } from "@mcpjam/sdk";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import {
  ErrorCode,
  WebRouteError,
  webError,
  parseErrorMessage,
  mapRuntimeError,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
} from "./errors.js";

// ── Zod Schemas ──────────────────────────────────────────────────────

export const workspaceServerSchema = z.object({
  workspaceId: z.string().min(1),
  serverId: z.string().min(1),
  oauthAccessToken: z.string().optional(),
});

export const toolsListSchema = workspaceServerSchema.extend({
  modelId: z.string().optional(),
  cursor: z.string().optional(),
});

export const toolsExecuteSchema = workspaceServerSchema.extend({
  toolName: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).default({}),
  taskOptions: z.record(z.string(), z.unknown()).optional(),
});

export const resourcesListSchema = workspaceServerSchema.extend({
  cursor: z.string().optional(),
});

export const resourcesReadSchema = workspaceServerSchema.extend({
  uri: z.string().min(1),
});

export const promptsListSchema = workspaceServerSchema.extend({
  cursor: z.string().optional(),
});

export const promptsListMultiSchema = z.object({
  workspaceId: z.string().min(1),
  serverIds: z.array(z.string().min(1)).min(1),
  oauthTokens: z.record(z.string(), z.string()).optional(),
});

export const promptsGetSchema = workspaceServerSchema.extend({
  promptName: z.string().min(1),
  arguments: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});

export const hostedChatSchema = z
  .object({
    workspaceId: z.string().min(1),
    selectedServerIds: z.array(z.string().min(1)),
    oauthTokens: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

// ── Helpers ──────────────────────────────────────────────────────────

export function buildSingleServerOAuthTokens(serverId: string, token?: string) {
  return token ? { [serverId]: token } : undefined;
}

// ── Authorization ────────────────────────────────────────────────────

export type ConvexAuthorizeResponse = {
  authorized: boolean;
  role: "owner" | "admin" | "member";
  serverConfig: {
    transportType: "stdio" | "http";
    url?: string;
    headers?: Record<string, string>;
    useOAuth?: boolean;
  };
};

export async function authorizeServer(
  bearerToken: string,
  workspaceId: string,
  serverId: string,
): Promise<ConvexAuthorizeResponse> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration",
    );
  }

  let response: Response;
  try {
    response = await fetch(`${convexUrl}/web/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({ workspaceId, serverId }),
    });
  } catch (error) {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      `Failed to reach authorization service: ${parseErrorMessage(error)}`,
    );
  }

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // ignored
  }

  if (!response.ok) {
    const code =
      typeof body?.code === "string" ? body.code : ErrorCode.INTERNAL_ERROR;
    const message =
      typeof body?.message === "string"
        ? body.message
        : `Authorization failed (${response.status})`;
    throw new WebRouteError(response.status, code as ErrorCode, message);
  }

  if (!body?.authorized || !body?.serverConfig) {
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "Authorization denied for server",
    );
  }

  return body as ConvexAuthorizeResponse;
}

function toHttpConfig(
  authResponse: ConvexAuthorizeResponse,
  timeoutMs: number,
  oauthAccessToken?: string,
): HttpServerConfig {
  if (authResponse.serverConfig.transportType !== "http") {
    throw new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "Only HTTP transport is supported in hosted mode",
    );
  }

  if (!authResponse.serverConfig.url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Authorized server is missing URL",
    );
  }

  const headers: Record<string, string> = {
    ...(authResponse.serverConfig.headers ?? {}),
  };

  if (oauthAccessToken) {
    headers["Authorization"] = `Bearer ${oauthAccessToken}`;
  }

  return {
    url: authResponse.serverConfig.url,
    requestInit: {
      headers,
    },
    timeout: timeoutMs,
  };
}

export async function createAuthorizedManager(
  bearerToken: string,
  workspaceId: string,
  serverIds: string[],
  timeoutMs: number,
  oauthTokens?: Record<string, string>,
): Promise<MCPClientManager> {
  const uniqueServerIds = Array.from(new Set(serverIds));
  const configEntries = await Promise.all(
    uniqueServerIds.map(async (serverId) => {
      const auth = await authorizeServer(bearerToken, workspaceId, serverId);
      const oauthToken = oauthTokens?.[serverId];

      if (auth.serverConfig.useOAuth && !oauthToken) {
        throw new WebRouteError(
          401,
          ErrorCode.UNAUTHORIZED,
          `Server "${serverId}" requires OAuth authentication. Please complete the OAuth flow first.`,
        );
      }

      return [serverId, toHttpConfig(auth, timeoutMs, oauthToken)] as const;
    }),
  );

  return new MCPClientManager(Object.fromEntries(configEntries), {
    defaultTimeout: timeoutMs,
  });
}

export async function withManager<T>(
  managerPromise: Promise<MCPClientManager>,
  fn: (manager: MCPClientManager) => Promise<T>,
): Promise<T> {
  const manager = await managerPromise;
  try {
    return await fn(manager);
  } finally {
    await manager.disconnectAllServers();
  }
}

export async function handleRoute<T>(
  c: any,
  handler: () => Promise<T>,
  successStatus = 200,
) {
  try {
    const result = await handler();
    return c.json(result, successStatus);
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webError(c, routeError.status, routeError.code, routeError.message);
  }
}

// ── Ephemeral Connection Helper ──────────────────────────────────────

/**
 * Resolve server IDs and OAuth tokens from parsed request body.
 *
 * Supports two shapes:
 *   - Single-server: { serverId, oauthAccessToken? }
 *   - Multi-server:  { serverIds, oauthTokens? }
 */
function resolveConnectionParams(body: Record<string, unknown>): {
  serverIds: string[];
  oauthTokens: Record<string, string> | undefined;
} {
  if (Array.isArray(body.serverIds)) {
    return {
      serverIds: body.serverIds as string[],
      oauthTokens: body.oauthTokens as Record<string, string> | undefined,
    };
  }
  return {
    serverIds: [body.serverId as string],
    oauthTokens: buildSingleServerOAuthTokens(
      body.serverId as string,
      body.oauthAccessToken as string | undefined,
    ),
  };
}

/**
 * Stateless per-request lifecycle: authorize → connect → execute → disconnect.
 *
 * Creates an ephemeral MCPClientManager scoped to a single request. Connections
 * are always torn down in `finally`, even on error. This is the hosted-mode
 * counterpart to the persistent singleton manager used by local /api/mcp routes.
 *
 * Handles the full request pipeline:
 *   1. Extract bearer token from Authorization header
 *   2. Parse + validate request body against the given Zod schema
 *   3. Resolve server IDs and OAuth tokens from the parsed body
 *   4. Authorize each server via Convex and create ephemeral MCP connections
 *   5. Execute `fn` with the live manager and parsed body
 *   6. Disconnect all servers (finally)
 *   7. Return JSON response (or structured error)
 *
 * Not suitable for streaming routes (chat-v2) — those need manual lifecycle
 * management via `onStreamComplete` because the Response is returned before
 * the stream finishes.
 */
export async function withEphemeralConnection<S extends z.ZodTypeAny, T>(
  c: any,
  schema: S,
  fn: (
    manager: InstanceType<typeof MCPClientManager>,
    body: z.infer<S>,
  ) => Promise<T>,
  options?: { timeoutMs?: number },
) {
  return handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(schema, await readJsonBody<unknown>(c));
    // Cast for internal plumbing — all web schemas include workspaceId + serverId(s).
    // The strongly-typed `body` is passed through to `fn` unchanged.
    const raw = body as Record<string, unknown>;
    const { serverIds, oauthTokens } = resolveConnectionParams(raw);
    const timeoutMs = options?.timeoutMs ?? WEB_CALL_TIMEOUT_MS;

    return withManager(
      createAuthorizedManager(
        bearerToken,
        raw.workspaceId as string,
        serverIds,
        timeoutMs,
        oauthTokens,
      ),
      (manager) => fn(manager, body as z.infer<S>),
    );
  });
}

// Re-export commonly used error utilities for convenience
export {
  ErrorCode,
  WebRouteError,
  webError,
  parseErrorMessage,
  mapRuntimeError,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
};
