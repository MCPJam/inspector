/**
 * Public v1 tunnel surface: register a relay tunnel as a first-class project
 * server and hand the caller everything it needs to host the connection.
 *
 * POST /projects/:projectId/tunnels mints a relay grant for a (created-if-
 * missing) `servers` record and PERSISTS the bearer URL (`?k=` plaintext
 * secret) onto `servers.url` so evals/chatboxes can target the tunnel like
 * any remote server. That persistence is a deliberate MVP trade-off — the
 * backend otherwise stores only the secret hash, and the hosted web flow
 * keeps the plaintext URL in inspector memory. Mitigations: every create
 * rotates the secret and revokes the previous grant at the edge, and the
 * close route revokes on demand. The caller (the CLI) hosts the relay
 * WebSocket itself; this route never touches the in-process tunnel-manager.
 */
import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import {
  ErrorCode,
  WebRouteError,
  parseWithSchema,
  readJsonBody,
} from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  closeTunnelGrant,
  fetchRelayGrant,
  requireConvexHttpUrl,
} from "../../services/tunnel-grants.js";
import { logger } from "../../utils/logger.js";
import { v1Resource } from "./envelope.js";

const tunnels = new Hono();

const createTunnelSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "name is required")
    .max(128, "name must be at most 128 characters"),
});

function createConvexClient(convexAuthToken: string): ConvexHttpClient {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_URL configuration"
    );
  }
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(convexAuthToken);
  return client;
}

type ProjectServerDto = {
  id?: unknown;
  name?: unknown;
  transportType?: unknown;
  url?: unknown;
};

/**
 * The project's saved servers via the same Convex `/v1/project-servers`
 * read the catalog routes proxy. Doubles as the project membership check
 * (Convex 404s/403s projects the caller can't see) and is how `existed`
 * is derived — `servers:createServerIfMissing` returns only an id.
 */
async function fetchProjectServers(
  projectId: string,
  bearer: string
): Promise<ProjectServerDto[]> {
  const convexUrl = requireConvexHttpUrl();
  const response = await fetch(
    `${convexUrl}/v1/project-servers?projectId=${encodeURIComponent(projectId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${bearer}` },
    }
  );

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const upstream = (body ?? {}) as { code?: string; message?: string };
    const status =
      response.status === 401 || response.status === 403
        ? 403
        : response.status === 404 || response.status === 400
          ? 404
          : 502;
    throw new WebRouteError(
      status,
      status === 403
        ? ErrorCode.FORBIDDEN
        : status === 404
          ? ErrorCode.NOT_FOUND
          : ErrorCode.INTERNAL_ERROR,
      upstream.message || `Project lookup failed (${response.status})`
    );
  }

  const items = (body as { items?: unknown })?.items;
  return Array.isArray(items) ? (items as ProjectServerDto[]) : [];
}

// POST /v1/projects/:projectId/tunnels
// Create (or revive) a tunnel for a named server in the project. Re-calling
// is the rotation path: each mint rotates the secret, revokes the previous
// grant at the edge, and updates the stored URL.
tunnels.post("/projects/:projectId/tunnels", async (c) => {
  const projectId = c.req.param("projectId");
  const { name } = parseWithSchema(
    createTunnelSchema,
    await readJsonBody<unknown>(c)
  );

  const bearer = await getConvexBearerForRequest(c);
  const existing = (await fetchProjectServers(projectId, bearer)).find(
    (server) => server.name === name
  );
  const existed = existing !== undefined;
  const previousUrl =
    typeof existing?.url === "string" && existing.url.length > 0
      ? existing.url
      : undefined;
  const previousTransportType =
    typeof existing?.transportType === "string"
      ? existing.transportType
      : undefined;

  const convex = createConvexClient(bearer);
  let serverId: string;
  try {
    serverId = (await convex.mutation("servers:createServerIfMissing" as any, {
      projectId,
      name,
      enabled: true,
      transportType: "http",
    })) as string;
  } catch (error) {
    logger.error("v1 tunnels: createServerIfMissing failed", error, {
      projectId,
    });
    throw new WebRouteError(
      502,
      ErrorCode.INTERNAL_ERROR,
      `Failed to register the tunnel server: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  let grant;
  try {
    grant = await fetchRelayGrant(serverId, `Bearer ${bearer}`);
  } catch (error) {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      error instanceof Error ? error.message : "Failed to fetch tunnel grant"
    );
  }

  // Point the record at the live tunnel. `transportType: "http"` converts a
  // name-colliding stdio record — without it the platform would keep trying
  // to launch the local command and ignore the URL.
  try {
    await convex.mutation("servers:updateServer" as any, {
      serverId,
      url: grant.url,
      transportType: "http",
      enabled: true,
    });
  } catch (error) {
    logger.error("v1 tunnels: updateServer failed", error, { serverId });
    throw new WebRouteError(
      502,
      ErrorCode.INTERNAL_ERROR,
      `Tunnel grant was minted but storing the URL on the server record failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  // Explicit whitelist — the upstream grant also carries the plaintext
  // `secret` and the `secretHash`, which must not pass through.
  return v1Resource(
    c,
    {
      serverId,
      name,
      existed,
      ...(previousUrl !== undefined && previousUrl !== grant.url
        ? { previousUrl }
        : {}),
      ...(previousTransportType !== undefined
        ? { previousTransportType }
        : {}),
      slug: grant.slug,
      url: grant.url,
      connectToken: grant.connectToken,
      ...(grant.connectTokenExpiresAt !== undefined
        ? { connectTokenExpiresAt: grant.connectTokenExpiresAt }
        : {}),
      relayWsUrl: grant.relayWsUrl,
      ...(grant.secretVersion !== undefined
        ? { secretVersion: grant.secretVersion }
        : {}),
    },
    201
  );
});

// POST /v1/projects/:projectId/tunnels/:serverId/close
// Revoke the live grant (edge denies the secret, socket drops). The server
// record — including its now-dead URL — is intentionally left untouched so
// the tunnel revives with the same slug on the next create.
tunnels.post("/projects/:projectId/tunnels/:serverId/close", async (c) => {
  const projectId = c.req.param("projectId");
  const serverId = c.req.param("serverId");

  const bearer = await getConvexBearerForRequest(c);
  // Convex authorizes by user identity; this check just makes the path's
  // project scope real so a serverId from another project reads NOT_FOUND.
  const servers = await fetchProjectServers(projectId, bearer);
  if (!servers.some((server) => server.id === serverId)) {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "Server not found in this project"
    );
  }

  try {
    await closeTunnelGrant(serverId, `Bearer ${bearer}`);
  } catch (error) {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      error instanceof Error ? error.message : "Failed to close tunnel"
    );
  }

  return v1Resource(c, { serverId, status: "closed" });
});

export default tunnels;
