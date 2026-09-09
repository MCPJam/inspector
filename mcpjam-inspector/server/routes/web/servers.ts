import { Hono } from "hono";
import { runServerDoctor } from "@mcpjam/sdk";
import { ConvexHttpClient } from "convex/browser";
import { WEB_CONNECT_TIMEOUT_MS } from "../../config.js";
import {
  mapRuntimeError,
  webErrorFromRoute,
  projectServerSchema,
  withEphemeralConnection,
  handleRoute,
  authorizeServer,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
  toHttpConfig,
} from "./auth.js";
import {
  attachHostedRpcLogs,
  createHostedRpcLogCollector,
} from "./hosted-rpc-logs.js";
import { buildConnectSuccessEnvelope } from "../../utils/local-server-resolver.js";
import {
  exportSingleServerForInspection,
  type ServerToolSnapshot,
} from "../../utils/export-helpers.js";
import {
  BlockedEgressTargetError,
  EgressResolutionError,
  assertAllowedHostedTargetUrl,
  createGuardedFetch,
} from "../../utils/hosted-egress-guard.js";
import { ErrorCode, WebRouteError } from "./errors.js";
import { getInspectorClientRuntimeConfig } from "../../env.js";
import { resolveEffectiveAuthMethod } from "../../utils/effective-auth.js";
import { logger } from "../../utils/logger.js";

const servers = new Hono();

servers.post("/validate", async (c) =>
  withEphemeralConnection(
    c,
    projectServerSchema,
    (manager, body) => validateServerCore(c, manager, body),
    { timeoutMs: WEB_CONNECT_TIMEOUT_MS }
  )
);

/**
 * Connect-and-inspect core shared by POST /api/web/servers/validate and the
 * public POST /v1/projects/:projectId/servers/:serverId/validate adapter.
 * Captures the inspection snapshot synchronously while the ephemeral manager is
 * still live — `withManager`'s `finally` disconnects the moment we return,
 * which would race any pending listTools. Only the Convex write is
 * fire-and-forget, so persistence failures don't affect the validate response.
 * (Port of PR #1731's `use-inspection-coordinator`.)
 */
export async function validateServerCore(
  c: any,
  manager: any,
  body: { projectId: string; serverId: string }
) {
  await manager.getToolsForAiSdk([body.serverId]);
  const snapshot = await exportSingleServerForInspection(
    manager,
    body.serverId,
    body.serverId,
    { logPrefix: "hosted-connect-inspection" }
  );
  void persistHostedConnectInspection(c, {
    projectId: body.projectId,
    snapshot,
  }).catch((error) => {
    logger.debug("Failed to persist hosted connect-time inspection", {
      serverId: body.serverId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  // Same success envelope as the local /api/mcp/connect path so the inspector
  // client's `storeInitInfo` takes one code path on both surfaces.
  return buildConnectSuccessEnvelope(manager, body.serverId);
}

async function persistHostedConnectInspection(
  c: any,
  args: { projectId: string; snapshot: ServerToolSnapshot },
): Promise<void> {
  // Only `CONVEX_HTTP_URL` is boot-enforced; the convex-client URL is
  // derived from it (suffix swap) by the runtime config helper so that
  // production env (which sets only CONVEX_HTTP_URL) works.
  const { convexUrl } = getInspectorClientRuntimeConfig();
  if (!convexUrl) return;
  const bearer = c.req.header("authorization");
  if (!bearer) return;
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(bearer.replace(/^Bearer\s+/i, ""));
  await client.mutation("serverInspections:recordFromConnect" as any, {
    projectId: args.projectId,
    snapshot: args.snapshot,
  });
}

servers.post("/check-oauth", async (c) =>
  handleRoute(c, async () => {
    const rawBody = await readJsonBody<unknown>(c);
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(projectServerSchema, rawBody);
    const auth = await authorizeServer(
      c,
      bearerToken,
      body.projectId,
      body.serverId,
      {
        accessScope: body.accessScope,
        scenarioId: body.scenarioId,
        accessVersion: body.accessVersion,
      }
    );
    return buildOAuthRequirementProjection(auth.serverConfig);
  })
);

/**
 * What a caller asking "does this server need authorizing before I can use
 * it?" must read.
 *
 * `useOAuth` is a DERIVED COMPAT MIRROR of the canonical `authMethod`
 * (mcpjam-backend `deriveAuthBooleans`): an `auto` row that is not
 * XAA-configured is stored with `useOAuth: true` even though `auto` resolves
 * to the discover ladder — connect unauthenticated, and escalate only when the
 * target actually answers 401. So the mirror answers "could this server ever
 * use OAuth", never "must someone authorize it first", and a caller that gates
 * on it demands consent from servers that have no authorization server at all.
 * `requiresAuthorization` is that second question, resolved through the shared
 * connect-time predicate; the mirror stays on the response for existing
 * consumers.
 */
export function buildOAuthRequirementProjection(serverConfig: {
  useOAuth?: boolean;
  url?: string;
  authMethod?: "auto" | "oauth" | "xaa" | "bearer" | "none";
  useXaa?: boolean;
  authServerMode?: "mcpjam" | "own";
  clientId?: string;
}) {
  const effectiveAuthMethod = resolveEffectiveAuthMethod(serverConfig);
  return {
    useOAuth: serverConfig.useOAuth ?? false,
    requiresAuthorization: effectiveAuthMethod === "oauth",
    effectiveAuthMethod,
    serverUrl: serverConfig.url ?? null,
  };
}

servers.post("/doctor", async (c) => {
  let rpcCollector: ReturnType<typeof createHostedRpcLogCollector> | undefined;

  try {
    const rawBody = await readJsonBody<Record<string, unknown>>(c);
    rpcCollector = createHostedRpcLogCollector(rawBody);
    const timeoutMs = WEB_CONNECT_TIMEOUT_MS;
    const result = await runHostedDoctor(
      c,
      rawBody,
      timeoutMs,
      rpcCollector?.rpcLogger
    );

    return c.json(attachHostedRpcLogs(result, rpcCollector), 200);
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webErrorFromRoute(
      c,
      routeError,
      rpcCollector?.buildEnvelope() as Record<string, unknown> | undefined
    );
  }
});

export default servers;

/**
 * Refuse a doctor target the hosted inspector must not dial, mapping the two
 * guard outcomes the way the conformance routes do: a blocked address is the
 * caller's problem (400), a resolver failure is ours (503).
 */
async function assertHostedDoctorTarget(url: string): Promise<void> {
  try {
    await assertAllowedHostedTargetUrl(url, "Server URL");
  } catch (error) {
    if (error instanceof BlockedEgressTargetError) {
      throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, error.message);
    }
    if (error instanceof EgressResolutionError) {
      throw new WebRouteError(503, ErrorCode.SERVER_UNREACHABLE, error.message);
    }
    throw error;
  }
}

export async function runHostedDoctor(
  c: any,
  rawBody: Record<string, unknown>,
  timeoutMs: number,
  rpcLogger?: Parameters<typeof runServerDoctor>[0]["rpcLogger"]
) {
  const bearerToken = assertBearerToken(c);
  const body = parseWithSchema(projectServerSchema, rawBody);
  const auth = await authorizeServer(
    c,
    bearerToken,
    body.projectId,
    body.serverId,
    {
      accessScope: body.accessScope,
      scenarioId: body.scenarioId,
      accessVersion: body.accessVersion,
    }
  );

  const config = toHttpConfig(
    auth,
    timeoutMs,
    auth.oauthAccessToken ?? body.oauthAccessToken,
    body.clientCapabilities
  );

  // The guarded `fetchFn` below covers the probe's own requests and nothing
  // else: `runServerDoctor` records a failed probe and connects anyway, over an
  // MCP transport that takes no fetch. So a target the guard would refuse still
  // gets dialed by the connection step. Judge the target once, here, before
  // either step runs — the same check the conformance routes make, and a no-op
  // outside hosted mode.
  await assertHostedDoctorTarget(config.url);

  return runServerDoctor({
    config,
    target: {
      kind: "http",
      scope: "hosted",
      projectId: body.projectId,
      serverId: body.serverId,
      label: body.serverName ?? body.serverId,
      ...(auth.serverConfig.url ? { url: auth.serverConfig.url } : {}),
    },
    timeout: timeoutMs,
    rpcLogger,
    // The probe follows two destinations the target names for itself — the RFC
    // 9728 pointer in its challenge and the authorization server that document
    // advertises. The SDK guard classifies IP literals, but only a resolver can
    // catch a hostname that answers with a private address, and only per-hop
    // checking can catch a redirect. Both live here. Outside hosted mode this
    // is the identity function, so localhost and LAN probing is unaffected.
    fetchFn: createGuardedFetch(),
  });
}
