import { Hono } from "hono";
import { runServerDoctor } from "@mcpjam/sdk";
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

const servers = new Hono();

servers.post("/validate", async (c) =>
  withEphemeralConnection(
    c,
    projectServerSchema,
    async (manager, body) => {
      await manager.getToolsForAiSdk([body.serverId]);
      // Same success envelope as the local /api/mcp/connect path so the
      // inspector client's `storeInitInfo` takes one code path on both
      // surfaces and we don't drift on the success shape.
      return buildConnectSuccessEnvelope(manager, body.serverId);
    },
    { timeoutMs: WEB_CONNECT_TIMEOUT_MS }
  )
);

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
        workspaceId:
          typeof (body as { workspaceId?: unknown }).workspaceId === "string"
            ? (body as unknown as { workspaceId: string }).workspaceId
            : undefined,
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
      workspaceId:
        typeof (body as { workspaceId?: unknown }).workspaceId === "string"
          ? (body as unknown as { workspaceId: string }).workspaceId
          : undefined,
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
