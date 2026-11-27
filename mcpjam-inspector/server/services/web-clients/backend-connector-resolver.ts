/**
 * Web connectors and their tool-call ledger as the backend keeps them. The
 * one file that knows how the Inspector reaches them: the backend's
 * Inspector-service functions (`webClientService:read` and `:apply`, one
 * Convex round trip behind the service credential), and the project
 * server's credential through the acting-as authorization the hosted harness
 * forward proxy uses (`createAuthorizedManager`, never connected: only its
 * config).
 *
 * It serves OAuth connectors: a capability connector names no user to act
 * as, so it forwards only from a local Inspector's registry.
 */
import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { z } from "zod";
import { WEB_CLIENT_VENDORS } from "../../../shared/web-clients.js";
import { createAuthorizedManager } from "../../routes/web/auth.js";
import { logger } from "../../utils/logger.js";
import { getServiceCredential } from "../service-credential.js";
import { resolveConfiguredXaaIssuer } from "../xaa-configured-issuer.js";
import type {
  UpstreamTarget,
  WebConnector,
  WebConnectorResolver,
} from "./connectors.js";
import { connectorTag } from "./forwarding-recorder.js";
import type { DurableToolCallLedger } from "./tool-call-ledger.js";

const SERVICE_TIMEOUT_MS = 10_000;
const UPSTREAM_TIMEOUT_MS = 300_000;
/** How long an unknown id is answered without asking the backend again. */
const UNKNOWN_TTL_MS = 30_000;
const MAX_UNKNOWN = 10_000;
/** Room for the backend's ids (32 hex characters); a longer unknown id is not kept. */
const MAX_KEPT_ID_LENGTH = 64;
/** Refusals that say this user may not use the connector, not that the check failed. */
const NOT_ALLOWED = new Set([
  "UNKNOWN_ACTOR",
  "GUEST_NOT_ALLOWED",
  "FORBIDDEN",
  "NOT_FOUND",
]);

/** One read or write through the backend's web-client service functions. */
export type WebClientService = {
  read(command: Record<string, unknown>): Promise<unknown>;
  apply(command: Record<string, unknown>): Promise<unknown>;
};

/** The backend's functions for this process, or undefined without the service credential. */
export function webClientService(
  env: NodeJS.ProcessEnv = process.env,
): WebClientService | undefined {
  const serviceToken = getServiceCredential(env);
  const url = env.CONVEX_URL?.trim();
  if (!serviceToken || !url) return undefined;
  let client: ConvexHttpClient;
  try {
    // No user bearer is ever set: the service credential is its only authority.
    client = new ConvexHttpClient(url, {
      logger: false,
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          // A redirect would carry the service credential in the body to
          // wherever it points.
          redirect: "error",
          signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
        }),
    });
  } catch (error) {
    // Runs at boot: a bad URL turns web connectors off, not the server.
    logger.warn("[web-clients] CONVEX_URL is not a deployment URL; backend connectors are off", {
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  return {
    read: (command) =>
      client.query(makeFunctionReference<"query">("webClientService:read"), {
        serviceToken,
        requestId: randomUUID(),
        command,
      }),
    apply: (command) =>
      client.mutation(
        makeFunctionReference<"mutation">("webClientService:apply"),
        { serviceToken, command },
        { skipQueue: true },
      ),
  };
}

/** The `code` of a backend refusal, or undefined for any other failure. */
export function refusalCode(error: unknown): string | undefined {
  if (
    !(error instanceof ConvexError) &&
    (error as Error | undefined)?.name !== "ConvexError"
  )
    return undefined;
  const code = (error as { data?: { code?: unknown } }).data?.code;
  return typeof code === "string" ? code : undefined;
}

const connectorRow = z
  .object({
    connectorId: z.string().min(1),
    projectId: z.string().min(1),
    organizationId: z.string().min(1).optional(),
    serverId: z.string().min(1),
    webAccountId: z.string().min(1),
    vendor: z.enum(WEB_CLIENT_VENDORS),
    auth: z.enum(["oauth", "capability"]),
  })
  .nullable();
const recordedCall = z.object({ id: z.string().min(1) });

/** Commands carry no undefined field: Convex refuses one. */
function defined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

export function createBackendConnectorResolver(
  service: WebClientService,
): WebConnectorResolver {
  const unknownUntil = new Map<string, number>();
  return {
    async resolve(connectorId) {
      const now = Date.now();
      if ((unknownUntil.get(connectorId) ?? 0) > now) return undefined;
      let row: z.infer<typeof connectorRow>;
      try {
        row = connectorRow.parse(
          await service.read({ action: "resolveWebConnector", connectorId }),
        );
      } catch (error) {
        // An id the backend can't even read (empty, too long) is unknown too.
        if (refusalCode(error) !== "INVALID_WEB_CLIENT_REQUEST") throw error;
        row = null;
      }
      if (row) return row;
      // Anyone can send any id before any check, so a long one is not kept,
      // and a full cache drops its oldest id rather than every other one.
      if (connectorId.length <= MAX_KEPT_ID_LENGTH) {
        if (unknownUntil.size >= MAX_UNKNOWN) {
          const oldest = unknownUntil.keys().next().value;
          if (oldest !== undefined) unknownUntil.delete(oldest);
        }
        unknownUntil.set(connectorId, now + UNKNOWN_TTL_MS);
      }
      return undefined;
    },
    /** `userId` is the WorkOS user id the vendor's AuthKit token names. */
    async mayUse(connector, userId) {
      try {
        const allowed = await service.read({
          action: "mayUseWebConnector",
          connectorId: connector.connectorId,
          actorExternalId: userId,
        });
        return allowed === true;
      } catch (error) {
        if (NOT_ALLOWED.has(refusalCode(error) ?? "")) return false;
        throw error;
      }
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
      // Without its egress-guarded fetch a user-typed URL would be dialled
      // unguarded, so a config that lacks one is not used at all.
      if (
        !config ||
        !("url" in config) ||
        !config.url ||
        config.preferSSE ||
        !config.baseFetch
      ) {
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
        fetch: config.baseFetch,
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
                    connector: connectorTag(connector.connectorId),
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

/** The backend's ledger, which recovery reads after a restart. */
export function createBackendToolCallLedger(
  service: WebClientService,
): DurableToolCallLedger {
  return {
    async record(entry) {
      const recorded = recordedCall.parse(
        await service.apply(
          defined({
            action: "recordWebToolCallForwarded",
            connectorId: entry.connectorId,
            turnId: entry.turnId,
            runId: entry.runId,
            jsonrpcId: String(entry.jsonrpcId),
            toolName: entry.toolName,
            toolUseId: entry.toolUseId,
            argsHash: entry.argsHash,
          }),
        ),
      );
      return recorded.id;
    },
    async settle(id, outcome) {
      await service.apply(
        defined({ action: "settleWebToolCall", id, ...outcome }),
      );
    },
  };
}
