/**
 * Public v1 registry surface — directory reads (proxied to Convex `/v1`)
 * plus project-scoped card/connection reads and install/uninstall writes.
 *
 * Reads use the shared `proxyConvexV1Read` plumbing (`convex-v1-proxy.ts`,
 * same as `catalog.ts`): path-param style on this host, query-param style on
 * Convex, bearer swapped via `getConvexBearerForRequest`. Writes go through
 * userMutation adapters (`connectCatalogServer`, `installRegistryServer`,
 * `disconnectRegistryServer`) with `readJsonObjectBody` + `z.strictObject`.
 *
 * There is no catalog-uninstall route. After the backend catalog-connection
 * cleanup, `DELETE /projects/:projectId/servers/:serverId` removes the
 * `servers` row and its `catalogServerConnections` provenance together.
 */
import { Hono } from "hono";
import { z } from "zod";
import { parseWithSchema, ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { createConvexClient } from "./convex-client.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { readJsonObjectBody } from "./adapter.js";
import { v1Resource } from "./envelope.js";
import { logger } from "../../utils/logger.js";
import { redactForLog } from "./redact-log-message.js";
import {
  fetchConvexV1Read,
  forwardQueryParams,
  proxyConvexV1Read,
} from "./convex-v1-proxy.js";
import {
  INTERNAL_TO_V1_CODE,
  V1_ERROR_STATUS,
  mapInternalCode,
} from "./contract.js";

const registry = new Hono();

const DIRECTORY_SEARCH_PARAMS = [
  "q",
  "source",
  "rowType",
  "endpointKind",
  "verifiedTier",
  "connectableOnly",
  "cursor",
  "limit",
] as const;

const installDirectorySchema = z.strictObject({
  catalogServerId: z.string().trim().min(1),
  endpointUrl: z.string().trim().min(1).optional(),
  expectedContentHash: z.string().trim().min(1).optional(),
});

const installRegistrySchema = z.strictObject({
  registryServerId: z.string().trim().min(1),
  expectedUpdatedAt: z.number().finite().optional(),
});

/**
 * Convex document ids are lowercase unhyphenated base32-ish tokens of ~32
 * characters. Directory `serverName` values are usually short slugs
 * (`linear`, `github`). A path segment that looks like an id is tried as
 * `catalogServerId` FIRST, with a name-lookup fallback below for the scraped
 * `serverName` that happens to be id-shaped; anything else is `name`.
 */
function looksLikeConvexId(value: string): boolean {
  return /^[a-z0-9]{30,36}$/.test(value);
}

function convexErrorData(
  error: unknown
): { code?: unknown; message?: unknown } | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data as { code?: unknown; message?: unknown };
}

/**
 * Map a registry/catalog ConvexError onto v1, preserving `details.code` as
 * the internal code. Codes outside the mapped family fall through to the
 * shared write translator.
 */
function translateRegistryWriteError(error: unknown): WebRouteError {
  if (error instanceof WebRouteError) return error;
  const data = convexErrorData(error);
  const code = typeof data?.code === "string" ? data.code : undefined;
  if (
    code &&
    Object.prototype.hasOwnProperty.call(INTERNAL_TO_V1_CODE, code) &&
    !/^[A-Z_]+$/.test(code)
  ) {
    const publicCode = mapInternalCode(code);
    const status = V1_ERROR_STATUS[publicCode];
    const message =
      typeof data?.message === "string" && data.message.length > 0
        ? data.message
        : "Registry write rejected by the platform";
    const details: Record<string, unknown> = { code };
    if (data && typeof data === "object") {
      for (const key of [
        "updatedAt",
        "latestContentHash",
        "connectedUrl",
        "serverId",
      ] as const) {
        const extra = (data as Record<string, unknown>)[key];
        if (extra !== undefined) details[key] = extra;
      }
    }
    return new WebRouteError(
      status,
      publicCode as (typeof ErrorCode)[keyof typeof ErrorCode],
      message,
      details
    );
  }
  // Convex rejected the ARGUMENTS before the mutation ran — a caller-shaped
  // id that does not match `v.id(...)` (a malformed path segment, a
  // directory id passed to the card shelf). That surfaces as a plain Error
  // (no `data.code`), which the shared translator would report as OUR
  // unrecognized 500 — a caller-mintable Sentry warn. It is the caller's bad
  // input: 400, with a stable message rather than Convex's prose, which
  // names functions and echoes the arguments back. Same recognition as
  // `convex-read-errors.ts::ARGUMENT_VALIDATION_FAILURE`; the warn keeps
  // deploy skew (a validator that gained a required argument) visible in
  // Axiom without paging.
  const raw = error instanceof Error ? error.message : String(error);
  if (/\bArgumentValidationError\b/i.test(raw)) {
    logger.warn("[v1.registry] convex rejected write arguments", {
      detail: redactForLog(error),
    });
    return new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Invalid identifier in request"
    );
  }
  return translateConvexWriteError(error, { resource: "Registry" });
}

// GET /registry/directory-servers
registry.get("/registry/directory-servers", (c) =>
  proxyConvexV1Read(c, "/v1/registry/directory-servers", (target) =>
    forwardQueryParams(c, target, DIRECTORY_SEARCH_PARAMS)
  )
);

// GET /registry/directory-servers/:idOrName
registry.get("/registry/directory-servers/:idOrName", async (c) => {
  const idOrName = c.req.param("idOrName");
  const source = c.req.query("source");
  const byName = (target: URL) => {
    target.searchParams.set("name", idOrName);
    if (source && source.length > 0) target.searchParams.set("source", source);
  };
  if ((source && source.length > 0) || !looksLikeConvexId(idOrName)) {
    return proxyConvexV1Read(c, "/v1/registry/directory-server", byName);
  }
  // Id-shaped: try `catalogServerId` first, but fall back to a name lookup
  // when the id read misses. A scraped `serverName` can be id-shaped, and
  // the upstream answers a wrong-shaped or unknown id with 400
  // (`v.id` cast rejection) or 404 (`catalog_server_not_found`) — both mean
  // "no row by that id", never "the name would also miss".
  const byId = await fetchConvexV1Read(
    c,
    "/v1/registry/directory-server",
    (t) => t.searchParams.set("catalogServerId", idOrName)
  );
  if (byId.status !== 400 && byId.status !== 404) {
    for (const [name, value] of Object.entries(byId.headers)) {
      c.header(name, value);
    }
    return c.json(byId.body as Record<string, unknown>, byId.status as 200);
  }
  return proxyConvexV1Read(c, "/v1/registry/directory-server", byName);
});

// GET /registry/directory-sources
registry.get("/registry/directory-sources", (c) =>
  proxyConvexV1Read(c, "/v1/registry/directory-sources")
);

// GET /projects/:projectId/registry/servers?scope=
registry.get("/projects/:projectId/registry/servers", (c) =>
  proxyConvexV1Read(c, "/v1/registry/servers", (target) => {
    target.searchParams.set("projectId", c.req.param("projectId"));
    forwardQueryParams(c, target, ["scope"]);
  })
);

// GET /projects/:projectId/registry/connections
registry.get("/projects/:projectId/registry/connections", (c) =>
  proxyConvexV1Read(c, "/v1/registry/connections", (target) => {
    target.searchParams.set("projectId", c.req.param("projectId"));
  })
);

// POST /projects/:projectId/registry/directory-installs
registry.post(
  "/projects/:projectId/registry/directory-installs",
  async (c) => {
    const projectId = c.req.param("projectId");
    const body = parseWithSchema(
      installDirectorySchema,
      await readJsonObjectBody(c)
    );
    const convexClient = createConvexClient(await getConvexBearerForRequest(c));
    try {
      const result = await convexClient.mutation(
        "serverCatalogConnect:connectCatalogServer" as never,
        {
          projectId,
          catalogServerId: body.catalogServerId,
          ...(body.endpointUrl !== undefined
            ? { endpointUrl: body.endpointUrl }
            : {}),
          ...(body.expectedContentHash !== undefined
            ? { expectedContentHash: body.expectedContentHash }
            : {}),
        } as never
      );
      return v1Resource(c, result, 201);
    } catch (error) {
      throw translateRegistryWriteError(error);
    }
  }
);

// POST /projects/:projectId/registry/installs
registry.post("/projects/:projectId/registry/installs", async (c) => {
  const projectId = c.req.param("projectId");
  const body = parseWithSchema(
    installRegistrySchema,
    await readJsonObjectBody(c)
  );
  const convexClient = createConvexClient(await getConvexBearerForRequest(c));
  try {
    const result = await convexClient.mutation(
      "registryServers:installRegistryServer" as never,
      {
        projectId,
        registryServerId: body.registryServerId,
        ...(body.expectedUpdatedAt !== undefined
          ? { expectedUpdatedAt: body.expectedUpdatedAt }
          : {}),
      } as never
    );
    return v1Resource(c, result, 201);
  } catch (error) {
    throw translateRegistryWriteError(error);
  }
});

// DELETE /projects/:projectId/registry/installs/:registryServerId
registry.delete(
  "/projects/:projectId/registry/installs/:registryServerId",
  async (c) => {
    const projectId = c.req.param("projectId");
    const registryServerId = c.req.param("registryServerId");
    const convexClient = createConvexClient(await getConvexBearerForRequest(c));
    try {
      const result = await convexClient.mutation(
        "registryServers:disconnectRegistryServer" as never,
        { projectId, registryServerId } as never
      );
      return v1Resource(c, result ?? { deleted: true });
    } catch (error) {
      throw translateRegistryWriteError(error);
    }
  }
);

export default registry;
export { looksLikeConvexId, translateRegistryWriteError };
