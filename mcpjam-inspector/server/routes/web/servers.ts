import { Hono } from "hono";
import {
  connectServerWithReport,
  type ConnectContext,
  runServerDoctor,
} from "@mcpjam/sdk";
import { WEB_CONNECT_TIMEOUT_MS } from "../../config.js";
import {
  ErrorCode,
  WebRouteError,
  mapRuntimeError,
  webError,
  workspaceServerSchema,
  guestServerInputSchema,
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

servers.post("/validate", async (c) => {
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

    const report = isGuestRequest
      ? await runGuestValidate(c, rawBody, timeoutMs, rpcCollector?.rpcLogger)
      : await runHostedValidate(c, rawBody, timeoutMs, rpcCollector?.rpcLogger);

    return c.json(
      attachHostedRpcLogs(
        {
          success: report.success,
          status: report.status,
          report,
          initInfo: report.initInfo,
          ...(report.issue ? { error: report.issue.message } : {}),
        },
        rpcCollector,
      ),
      200,
    );
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details,
      rpcCollector?.buildEnvelope() as Record<string, unknown> | undefined,
    );
  }
});

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
      rpcCollector?.buildEnvelope() as Record<string, unknown> | undefined,
    );
  }
});

export default servers;

function parseOAuthContext(
  rawBody: Record<string, unknown>,
): ConnectContext["oauth"] | undefined {
  const oauthContext = rawBody.oauthContext;
  if (!oauthContext || typeof oauthContext !== "object") {
    return undefined;
  }

  const candidate = oauthContext as Record<string, unknown>;
  const protocolVersion = candidate.protocolVersion;
  const registrationStrategy = candidate.registrationStrategy;

  if (protocolVersion !== "2025-06-18" && protocolVersion !== "2025-11-25") {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Invalid oauthContext.protocolVersion: ${String(protocolVersion)}`,
    );
  }

  if (
    registrationStrategy !== "dcr" &&
    registrationStrategy !== "preregistered" &&
    registrationStrategy !== "cimd"
  ) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Invalid oauthContext.registrationStrategy: ${String(registrationStrategy)}`,
    );
  }

  return {
    protocolVersion,
    registrationStrategy,
    usedCustomClientCredentials: candidate.usedCustomClientCredentials === true,
    useRegistryOAuthProxy: candidate.useRegistryOAuthProxy === true,
  };
}

async function runGuestValidate(
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

  const headers: Record<string, string> = {
    ...(guestInput.serverHeaders ?? {}),
  };
  const oauthAccessToken =
    typeof rawBody.oauthAccessToken === "string"
      ? rawBody.oauthAccessToken
      : undefined;

  if (oauthAccessToken) {
    headers.Authorization = `Bearer ${oauthAccessToken}`;
  }

  const oauthContext = parseOAuthContext(rawBody);

  return connectServerWithReport({
    config: {
      url: validatedUrl.toString(),
      capabilities: guestInput.clientCapabilities,
      requestInit: { headers },
      timeout: timeoutMs,
    },
    target: guestInput.serverName ?? validatedUrl.toString(),
    timeout: timeoutMs,
    rpcLogger,
    ...(oauthContext ? { context: { oauth: oauthContext } } : {}),
  });
}

async function runHostedValidate(
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
    body.oauthAccessToken,
    body.clientCapabilities,
  );
  const oauthContext = parseOAuthContext(rawBody);

  return connectServerWithReport({
    config,
    target: body.serverName ?? body.serverId,
    timeout: timeoutMs,
    rpcLogger,
    ...(oauthContext ? { context: { oauth: oauthContext } } : {}),
  });
}

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
    body.oauthAccessToken,
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
