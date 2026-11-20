/**
 * Web connectors as the backend keeps them. The one file that knows how the
 * Inspector reaches them: the backend's `resolveWebConnector` and
 * `mayUseWebConnector` behind the service token, and the project server's
 * credential through the acting-as authorization the hosted harness forward
 * proxy uses (`createAuthorizedManager`, never connected: only its config).
 *
 * It serves OAuth connectors: a capability connector names no user to act
 * as, so it forwards only from a local Inspector's registry.
 */
import { z } from "zod";
import { WEB_CLIENT_VENDORS } from "../../../shared/web-clients.js";
import { createAuthorizedManager } from "../../routes/web/auth.js";
import { logger } from "../../utils/logger.js";
import { getInternalBackendConfig } from "../internal-backend.js";
import { INSPECTOR_SERVICE_TOKEN_HEADER } from "../service-credential.js";
import { resolveConfiguredXaaIssuer } from "../xaa-configured-issuer.js";
import type {
  UpstreamTarget,
  WebConnector,
  WebConnectorResolver,
} from "./connectors.js";

/** HTTP routes over `resolveWebConnector` and `mayUseWebConnector` (`convex/webClients.ts`). */
const RESOLVE_PATH = "/internal/v1/web-clients/connectors/resolve";
const MAY_USE_PATH = "/internal/v1/web-clients/connectors/may-use";
const FEATURE = "Claude web and ChatGPT web";
const LOOKUP_TIMEOUT_MS = 10_000;
const UPSTREAM_TIMEOUT_MS = 300_000;

const resolveAnswer = z.object({
  connector: z
    .object({
      connectorId: z.string().min(1),
      projectId: z.string().min(1),
      organizationId: z.string().min(1).optional(),
      serverId: z.string().min(1),
      webAccountId: z.string().min(1).optional(),
      vendor: z.enum(WEB_CLIENT_VENDORS).optional(),
      auth: z.enum(["oauth", "capability"]),
    })
    .nullable(),
});
const mayUseAnswer = z.object({ allowed: z.boolean() });

async function backend<T>(
  path: string,
  body: object,
  schema: z.ZodType<T>,
): Promise<T> {
  const { convexUrl, serviceToken } = getInternalBackendConfig(FEATURE);
  const response = await fetch(`${convexUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [INSPECTOR_SERVICE_TOKEN_HEADER]: serviceToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`Web connector lookup failed (${response.status})`);
  return schema.parse(await response.json());
}

export function createBackendConnectorResolver(): WebConnectorResolver {
  return {
    async resolve(connectorId) {
      const { connector } = await backend(
        RESOLVE_PATH,
        { connectorId },
        resolveAnswer,
      );
      return connector ?? undefined;
    },
    /** `userId` is the WorkOS user id the vendor's AuthKit token names. */
    async mayUse(connector, userId) {
      const { allowed } = await backend(
        MAY_USE_PATH,
        { connectorId: connector.connectorId, userId },
        mayUseAnswer,
      );
      return allowed;
    },
    async upstream(connector: WebConnector, { userId }): Promise<UpstreamTarget> {
      if (!userId || !connector.organizationId)
        throw new Error("A backend connector forwards only for a signed-in user.");
      const authorized = await createAuthorizedManager(
        {
          authMethod: "workos_api_key",
          workosUserId: userId,
          mcpjamOrganizationId: connector.organizationId,
        },
        "", // the acting-as exchange ignores the bearer
        connector.projectId,
        [connector.serverId],
        UPSTREAM_TIMEOUT_MS,
        undefined,
        undefined,
        { lazyConnect: true, xaaIssuer: resolveConfiguredXaaIssuer() },
      );
      const release = () => authorized.manager.disconnectAllServers();
      const config = authorized.authorizedServerConfigs?.[connector.serverId];
      if (!config || !("url" in config) || !config.url || config.preferSSE) {
        await release();
        throw new Error("The project's server has no Streamable HTTP endpoint.");
      }
      const headers: Record<string, string> = {};
      new Headers(config.requestInit?.headers).forEach((value, name) => {
        headers[name] = value;
      });
      if (config.accessToken) headers.authorization = `Bearer ${config.accessToken}`;
      const refresh = config.onUnauthorized;
      return {
        url: String(config.url),
        headers,
        ...(config.baseFetch ? { fetch: config.baseFetch } : {}),
        ...(refresh
          ? {
              onUnauthorized: async () => {
                try {
                  const { accessToken } = await refresh({
                    serverId: connector.serverId,
                    error: new Error("MCP authorization was rejected."),
                  });
                  return accessToken;
                } catch (error) {
                  logger.warn("[web-clients] the server credential could not be refreshed", {
                    connectorId: connector.connectorId,
                    message: error instanceof Error ? error.message : String(error),
                  });
                  return undefined;
                }
              },
            }
          : {}),
        release,
      };
    },
  };
}
