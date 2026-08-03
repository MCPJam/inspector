import { Hono } from "hono";
import { z } from "zod";
import {
  MCP_PROTOCOL_VERSIONS,
  oauthConformanceProfileSchema,
  type MCPServerConfig,
} from "@mcpjam/sdk";
import {
  handleRoute,
  projectServerSchema,
} from "./auth.js";
import {
  ErrorCode,
  WebRouteError,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
} from "./errors.js";
import {
  OAuthConformanceSessionFailedError,
  OAuthConformanceSessionNotFoundError,
  UnsupportedTransportError,
  completeOAuthConformance,
  runAppsConformance,
  runProtocolConformance,
  runTasksConformance,
  startOAuthConformance,
  submitOAuthConformanceCode,
} from "../shared/conformance";
import { authorizeServer, toHttpConfig } from "./auth.js";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";

const conformanceWeb = new Hono();

// ── Helpers ─────────────────────────────────────────────────────────────

/** Resolve HTTP server URL and headers for conformance from authorized config. */
async function resolveHostedHttpConfig(
  c: any,
  bearerToken: string,
  body: Record<string, unknown>
): Promise<{
  serverUrl: string;
  accessToken?: string;
  customHeaders?: Record<string, string>;
}> {
  const wsBody = parseWithSchema(projectServerSchema, body);
  const auth = await authorizeServer(
    c,
    bearerToken,
    wsBody.projectId,
    wsBody.serverId,
    {
      accessScope: wsBody.accessScope,
      chatboxId: wsBody.chatboxId,
      accessVersion: wsBody.accessVersion,
    }
  );

  if (auth.serverConfig.transportType !== "http") {
    throw new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "Protocol conformance requires HTTP transport"
    );
  }

  if (!auth.serverConfig.url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Authorized server is missing URL"
    );
  }

  const oauthToken =
    typeof wsBody.oauthAccessToken === "string"
      ? wsBody.oauthAccessToken
      : undefined;
  const headers: Record<string, string> = {
    ...(auth.serverConfig.headers ?? {}),
  };
  if (oauthToken) {
    headers["Authorization"] = `Bearer ${oauthToken}`;
  }

  return {
    serverUrl: auth.serverConfig.url,
    accessToken: undefined, // OAuth token goes in headers
    customHeaders: Object.keys(headers).length > 0 ? headers : undefined,
  };
}

/** Resolve any-transport server config for Apps/Tasks conformance on hosted. */
async function resolveHostedServerConfig(
  c: any,
  bearerToken: string,
  body: Record<string, unknown>
): Promise<MCPServerConfig> {
  const wsBody = parseWithSchema(projectServerSchema, body);
  const auth = await authorizeServer(
    c,
    bearerToken,
    wsBody.projectId,
    wsBody.serverId,
    {
      accessScope: wsBody.accessScope,
      chatboxId: wsBody.chatboxId,
      accessVersion: wsBody.accessVersion,
    }
  );

  const httpConfig = toHttpConfig(
    auth,
    WEB_CALL_TIMEOUT_MS,
    typeof wsBody.oauthAccessToken === "string"
      ? wsBody.oauthAccessToken
      : undefined,
    wsBody.clientCapabilities as Record<string, unknown> | undefined
  );

  return httpConfig as MCPServerConfig;
}

/**
 * Bound a whole conformance run by wall-clock, not just its individual legs.
 * Losing the race rejects with a 504 so the route always answers inside the
 * hosted budget; the run itself keeps unwinding in the background (its legs
 * are individually timed out) and closes its own client.
 */
async function withHostedDeadline<T>(
  run: Promise<T>,
  deadlineMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new WebRouteError(504, ErrorCode.TIMEOUT, message)),
      deadlineMs
    );
  });
  // Never leave the losing run as an unhandled rejection.
  run.catch(() => {});
  try {
    return await Promise.race([run, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toWebError(error: unknown): WebRouteError {
  if (error instanceof WebRouteError) return error;
  if (error instanceof UnsupportedTransportError) {
    return new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      error.message
    );
  }
  if (error instanceof OAuthConformanceSessionNotFoundError) {
    return new WebRouteError(404, ErrorCode.NOT_FOUND, error.message);
  }
  if (error instanceof OAuthConformanceSessionFailedError) {
    return new WebRouteError(500, ErrorCode.INTERNAL_ERROR, error.message);
  }
  return new WebRouteError(
    500,
    ErrorCode.INTERNAL_ERROR,
    error instanceof Error ? error.message : "Unknown error"
  );
}

// ── POST /protocol ──────────────────────────────────────────────────────

const protocolSchema = z
  .object({
    /** Pin the run to one protocol version; absent ⇒ adopt the negotiated one. */
    protocolVersion: z.enum(MCP_PROTOCOL_VERSIONS).optional(),
  })
  .passthrough(); // project/guest fields pass through to resolveHostedHttpConfig

conformanceWeb.post("/protocol", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = await readJsonBody<Record<string, unknown>>(c);
    const resolved = await resolveHostedHttpConfig(c, bearerToken, body);
    const parsed = parseWithSchema(protocolSchema, body);

    try {
      const { result } = await runProtocolConformance({
        ...resolved,
        protocolVersion: parsed.protocolVersion,
      });
      return { success: true, result };
    } catch (error) {
      throw toWebError(error);
    }
  })
);

// ── POST /apps ──────────────────────────────────────────────────────────

conformanceWeb.post("/apps", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = await readJsonBody<Record<string, unknown>>(c);
    const config = await resolveHostedServerConfig(c, bearerToken, body);

    try {
      const { result } = await runAppsConformance(config);
      return { success: true, result };
    } catch (error) {
      throw toWebError(error);
    }
  })
);

// ── POST /tasks ─────────────────────────────────────────────────────────

/**
 * Tasks conformance provokes a real task and polls it to a terminal status,
 * all inside this single request — the runner opens its own ephemeral client,
 * so it needs no long-lived connection.
 *
 * Fitting that into the hosted budget takes three bounds, not one. Capping the
 * poll window alone leaves connect, `tools/list` and the provoking
 * `tools/call` free to burn a full `WEB_CALL_TIMEOUT_MS` *each* before polling
 * even starts, so the request could run for minutes:
 *
 * - `HOSTED_TASKS_CALL_TIMEOUT_MS` bounds each individual MCP leg, replacing
 *   the route-wide `WEB_CALL_TIMEOUT_MS` this run's config would otherwise
 *   carry.
 * - `HOSTED_TASKS_POLL_TIMEOUT_MS` bounds the poll window regardless of what
 *   the caller asks for.
 * - `HOSTED_TASKS_DEADLINE_MS` bounds the *whole* run, so however the legs
 *   compose, the route answers with a 504 instead of hanging past the budget.
 *   The abandoned run still unwinds on its own — every leg inside it is
 *   bounded by the per-call timeout — so its ephemeral client is closed by
 *   `withEphemeralClient`'s own teardown shortly after.
 */
const HOSTED_TASKS_POLL_TIMEOUT_MS = 20_000;
/** Per-MCP-call ceiling inside a hosted tasks run (connect, list, call). */
const HOSTED_TASKS_CALL_TIMEOUT_MS = 10_000;
/** Wall-clock ceiling for the whole run, held just under the call budget. */
const HOSTED_TASKS_DEADLINE_MS = WEB_CALL_TIMEOUT_MS - 2_000;

const tasksSchema = z
  .object({
    /** Tool used to provoke a task; required on the extension wire, where
     *  tools carry no task metadata to pick from. */
    toolName: z.string().min(1).optional(),
    toolArguments: z.record(z.string(), z.unknown()).optional(),
    pollTimeoutMs: z.number().int().positive().max(120_000).optional(),
  })
  .passthrough(); // project/guest fields pass through to resolveHostedServerConfig

conformanceWeb.post("/tasks", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = await readJsonBody<Record<string, unknown>>(c);
    const config = await resolveHostedServerConfig(c, bearerToken, body);
    const parsed = parseWithSchema(tasksSchema, body);

    try {
      const result = await withHostedDeadline(
        runTasksConformance({
          ...config,
          timeout: HOSTED_TASKS_CALL_TIMEOUT_MS,
          ...(parsed.toolName ? { toolName: parsed.toolName } : {}),
          ...(parsed.toolArguments
            ? { toolArguments: parsed.toolArguments }
            : {}),
          pollTimeoutMs: Math.min(
            parsed.pollTimeoutMs ?? HOSTED_TASKS_POLL_TIMEOUT_MS,
            HOSTED_TASKS_POLL_TIMEOUT_MS
          ),
        }),
        HOSTED_TASKS_DEADLINE_MS,
        `Tasks conformance exceeded the hosted request budget (${HOSTED_TASKS_DEADLINE_MS}ms); run it from the local inspector for a longer poll window`
      ).then((r) => r.result);
      return { success: true, result };
    } catch (error) {
      throw toWebError(error);
    }
  })
);

// ── POST /oauth/start ───────────────────────────────────────────────────

const oauthStartSchema = z
  .object({
    oauthProfile: oauthConformanceProfileSchema.optional(),
    callbackOrigin: z.string().optional(),
  })
  .passthrough(); // project/guest fields pass through to resolveHostedHttpConfig

conformanceWeb.post("/oauth/start", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = await readJsonBody<Record<string, unknown>>(c);
    const resolved = await resolveHostedHttpConfig(c, bearerToken, body);
    const parsed = parseWithSchema(oauthStartSchema, body);

    if (!parsed.callbackOrigin) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "callbackOrigin is required to run OAuth conformance"
      );
    }

    try {
      return await startOAuthConformance({
        defaultServerUrl: resolved.serverUrl,
        defaultCustomHeaders: resolved.customHeaders,
        redirectUrl: `${parsed.callbackOrigin.replace(
          /\/$/,
          ""
        )}/oauth/callback/debug`,
        oauthProfile: parsed.oauthProfile,
      });
    } catch (error) {
      throw toWebError(error);
    }
  })
);

// ── POST /oauth/authorize ───────────────────────────────────────────────

const oauthAuthorizeSchema = z.object({
  sessionId: z.string().min(1),
  code: z.string().min(1),
  state: z.string().optional(),
});

conformanceWeb.post("/oauth/authorize", async (c) =>
  handleRoute(c, async () => {
    const body = await readJsonBody<Record<string, unknown>>(c);
    const parsed = parseWithSchema(oauthAuthorizeSchema, body);

    const delivered = submitOAuthConformanceCode(parsed);
    if (!delivered) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "Session not found or not waiting for authorization"
      );
    }
    return { success: true };
  })
);

// ── POST /oauth/complete ────────────────────────────────────────────────

const oauthCompleteSchema = z.object({
  sessionId: z.string().min(1),
});

conformanceWeb.post("/oauth/complete", async (c) =>
  handleRoute(c, async () => {
    const body = await readJsonBody<Record<string, unknown>>(c);
    const parsed = parseWithSchema(oauthCompleteSchema, body);
    try {
      return await completeOAuthConformance(parsed);
    } catch (error) {
      throw toWebError(error);
    }
  })
);

export default conformanceWeb;
