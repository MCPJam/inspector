import { Hono } from "hono";
import { runServerDoctor } from "@mcpjam/sdk";
import { WEB_CONNECT_TIMEOUT_MS } from "../../config.js";
import {
  ErrorCode,
  WebRouteError,
  mapRuntimeError,
  webError,
  workspaceServerSchema,
  guestServerInputSchema,
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
import { OAuthProxyError, validateUrl } from "../../utils/oauth-proxy.js";

const servers = new Hono();

servers.post("/validate", async (c) =>
  withEphemeralConnection(
    c,
    workspaceServerSchema,
    async (manager, body) => {
      await manager.getToolsForAiSdk([body.serverId]);
      const initInfo = manager.getInitializationInfo(body.serverId);
      return { success: true, status: "connected", initInfo: initInfo ?? null };
    },
    { timeoutMs: WEB_CONNECT_TIMEOUT_MS },
  ),
);

servers.post("/check-oauth", async (c) =>
  handleRoute(c, async () => {
    const rawBody = await readJsonBody<unknown>(c);
    const isDirectGuestRequest =
      !!rawBody &&
      typeof rawBody === "object" &&
      typeof (rawBody as { serverUrl?: unknown }).serverUrl === "string" &&
      !(rawBody as { workspaceId?: unknown }).workspaceId;

    // Direct guest sessions connect without Convex server records.
    if (isDirectGuestRequest) {
      return { useOAuth: false, serverUrl: null };
    }

    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(workspaceServerSchema, rawBody);
    const auth = await authorizeServer(
      bearerToken,
      body.workspaceId,
      body.serverId,
      {
        accessScope: body.accessScope,
        shareToken: body.shareToken,
        sandboxToken: body.sandboxToken,
      },
    );
    return {
      useOAuth: auth.serverConfig.useOAuth ?? false,
      serverUrl: auth.serverConfig.url ?? null,
    };
  }),
);

servers.post("/doctor", async (c) => {
  let rpcCollector: ReturnType<typeof createHostedRpcLogCollector> | undefined;

  try {
    const rawBody = await readJsonBody<Record<string, unknown>>(c);
    rpcCollector = createHostedRpcLogCollector(rawBody);
    const timeoutMs = WEB_CONNECT_TIMEOUT_MS;
    const isGuestRequest =
      !!rawBody &&
      typeof rawBody === "object" &&
      typeof rawBody.serverUrl === "string" &&
      !rawBody.workspaceId;

    const result = isGuestRequest
      ? await runGuestDoctor(c, rawBody, timeoutMs, rpcCollector?.rpcLogger)
      : await runHostedDoctor(c, rawBody, timeoutMs, rpcCollector?.rpcLogger);

    return c.json(attachHostedRpcLogs(result, rpcCollector), 200);
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details,
      rpcCollector?.buildEnvelope(),
    );
  }
});

export default servers;

async function runGuestDoctor(
  c: any,
  rawBody: Record<string, unknown>,
  timeoutMs: number,
  rpcLogger?: Parameters<typeof runServerDoctor>[0]["rpcLogger"],
) {
  const guestId = c.get("guestId") as string | undefined;
  if (!guestId) {
    throw new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      "Valid guest token required. Please refresh the page to obtain a new session.",
    );
  }

  const guestInput = parseWithSchema(guestServerInputSchema, rawBody);

  let validatedUrl: URL;
  try {
    ({ url: validatedUrl } = await validateUrl(guestInput.serverUrl, true));
  } catch (error) {
    if (error instanceof OAuthProxyError) {
      throw new WebRouteError(
        error.status,
        ErrorCode.VALIDATION_ERROR,
        error.message,
      );
    }
    throw error;
  }

  const canonicalUrl = validatedUrl.toString();
  const headers: Record<string, string> = {
    ...(guestInput.serverHeaders ?? {}),
  };
  const oauthAccessToken =
    typeof rawBody.oauthAccessToken === "string"
      ? rawBody.oauthAccessToken
      : undefined;

  if (oauthAccessToken) {
    headers["Authorization"] = `Bearer ${oauthAccessToken}`;
  }

  return runServerDoctor({
    config: {
      url: canonicalUrl,
      capabilities: guestInput.clientCapabilities,
      requestInit: { headers },
      timeout: timeoutMs,
    },
    target: {
      kind: "http",
      scope: "guest",
      label: guestInput.serverName ?? canonicalUrl,
      url: canonicalUrl,
    },
    timeout: timeoutMs,
    rpcLogger,
  });
}

async function runHostedDoctor(
  c: any,
  rawBody: Record<string, unknown>,
  timeoutMs: number,
  rpcLogger?: Parameters<typeof runServerDoctor>[0]["rpcLogger"],
) {
  const bearerToken = assertBearerToken(c);
  const body = parseWithSchema(workspaceServerSchema, rawBody);
  const auth = await authorizeServer(
    bearerToken,
    body.workspaceId,
    body.serverId,
    {
      accessScope: body.accessScope,
      shareToken: body.shareToken,
      sandboxToken: body.sandboxToken,
    },
  );

  const config = toHttpConfig(
    auth,
    timeoutMs,
    auth.oauthAccessToken ?? body.oauthAccessToken,
    body.clientCapabilities,
  );

  return runServerDoctor({
    config,
    target: {
      kind: "http",
      scope: "hosted",
      workspaceId: body.workspaceId,
      serverId: body.serverId,
      label: body.serverName ?? body.serverId,
      ...(auth.serverConfig.url ? { url: auth.serverConfig.url } : {}),
    },
    timeout: timeoutMs,
    rpcLogger,
  });
}
