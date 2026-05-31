import { Hono } from "hono";
import { runServerDoctor } from "@mcpjam/sdk";
import { ConvexHttpClient } from "convex/browser";
import { WEB_CONNECT_TIMEOUT_MS } from "../../config.js";
import {
  mapRuntimeError,
  webError,
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
import { getInspectorClientRuntimeConfig } from "../../env.js";
import { logger } from "../../utils/logger.js";

const servers = new Hono();

servers.post("/validate", async (c) =>
  withEphemeralConnection(
    c,
    projectServerSchema,
    async (manager, body) => {
      await manager.getToolsForAiSdk([body.serverId]);
      // Capture the inspection snapshot synchronously while the ephemeral
      // manager is still live — `withManager`'s `finally` will call
      // `disconnectAllServers()` the moment we return, which would race any
      // `listTools` we left pending here. Only the Convex write is
      // fire-and-forget, so persistence failures still don't affect the
      // validate response. (Port of PR #1731's `use-inspection-coordinator`.)
      const snapshot = await exportSingleServerForInspection(
        manager,
        body.serverId,
        body.serverId,
        { logPrefix: "hosted-connect-inspection" },
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
      // Same success envelope as the local /api/mcp/connect path so the
      // inspector client's `storeInitInfo` takes one code path on both
      // surfaces and we don't drift on the success shape.
      return buildConnectSuccessEnvelope(manager, body.serverId);
    },
    { timeoutMs: WEB_CONNECT_TIMEOUT_MS }
  )
);

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
        chatboxId: body.chatboxId,
        accessVersion: body.accessVersion,
      }
    );
    return {
      useOAuth: auth.serverConfig.useOAuth ?? false,
      serverUrl: auth.serverConfig.url ?? null,
    };
  })
);

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
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details,
      rpcCollector?.buildEnvelope()
    );
  }
});

export default servers;

async function runHostedDoctor(
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
      chatboxId: body.chatboxId,
      accessVersion: body.accessVersion,
    }
  );

  const config = toHttpConfig(
    auth,
    timeoutMs,
    auth.oauthAccessToken ?? body.oauthAccessToken,
    body.clientCapabilities
  );

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
  });
}
