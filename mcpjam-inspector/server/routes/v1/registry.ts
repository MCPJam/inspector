/**
 * Public v1 registry surface — directory reads (proxied to Convex `/v1`)
 * plus project-scoped card/connection reads and install/uninstall writes.
 *
 * Reads use the same `proxyConvexV1Read` pattern as `catalog.ts`: path-param
 * style on this host, query-param style on Convex, bearer swapped via
 * `getConvexBearerForRequest`. Writes go through userMutation adapters
 * (`connectCatalogServer`, `installRegistryServer`, `disconnectRegistryServer`)
 * with `readJsonObjectBody` + `z.strictObject`.
 *
 * There is no catalog-uninstall route. After the backend catalog-connection
 * cleanup, `DELETE /projects/:projectId/servers/:serverId` removes the
 * `servers` row and its `catalogServerConnections` provenance together.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { parseWithSchema, ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { createConvexClient } from "./convex-client.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { readJsonObjectBody } from "./adapter.js";
import { v1Resource } from "./envelope.js";
import {
  INTERNAL_TO_V1_CODE,
  V1_ERROR_STATUS,
  mapInternalCode,
} from "./contract.js";

const registry = new Hono();

const PROXY_TIMEOUT_MS = 15_000;

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

function forwardQueryParams(
  c: Context,
  target: URL,
  names: readonly string[]
): void {
  for (const name of names) {
    const value = c.req.query(name);
    if (typeof value === "string" && value.length > 0) {
      target.searchParams.set(name, value);
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      (error as { code?: string }).code === "ABORT_ERR")
  );
}

async function fetchConvexV1Read(
  c: Context,
  convexPath: string,
  configure?: (target: URL) => void
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }
  const bearer = await getConvexBearerForRequest(c);
  const target = new URL(convexPath, convexUrl);
  configure?.(target);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(target, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearer}` },
      signal: controller.signal,
    });
    try {
      body = await response.json();
    } catch (parseError) {
      if (isAbortError(parseError)) throw parseError;
      throw new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        `Catalog service returned a non-JSON response (${response.status})`
      );
    }
  } catch (error) {
    if (error instanceof WebRouteError) throw error;
    const isAbort = isAbortError(error);
    throw new WebRouteError(
      isAbort ? 504 : 502,
      isAbort ? ErrorCode.TIMEOUT : ErrorCode.SERVER_UNREACHABLE,
      isAbort
        ? `Catalog read timed out after ${PROXY_TIMEOUT_MS}ms`
        : "Failed to reach the catalog service"
    );
  } finally {
    clearTimeout(timeoutId);
  }

  const headers: Record<string, string> = {};
  for (const name of [
    "content-type",
    "x-next-cursor",
    "x-mcpjam-next-cursor",
    "x-mcpjam-export-complete",
    "access-control-expose-headers",
    "link",
  ] as const) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return { status: response.status, body, headers };
}

async function proxyConvexV1Read(
  c: Context,
  convexPath: string,
  configure?: (target: URL) => void
): Promise<Response> {
  const { status, body, headers } = await fetchConvexV1Read(
    c,
    convexPath,
    configure
  );
  for (const [name, value] of Object.entries(headers)) c.header(name, value);
  return c.json(body as Record<string, unknown>, status as 200);
}

/**
 * Convex document ids are long unhyphenated tokens. Directory `serverName`
 * values are short slugs (`linear`, `github`). A path segment that looks like
 * an id is forwarded as `catalogServerId`; anything else is `name`.
 */
function looksLikeConvexId(value: string): boolean {
  return /^[a-z0-9]{20,}$/i.test(value);
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
  return translateConvexWriteError(error, { resource: "Registry" });
}

// GET /registry/directory-servers
registry.get("/registry/directory-servers", (c) =>
  proxyConvexV1Read(c, "/v1/registry/directory-servers", (target) =>
    forwardQueryParams(c, target, DIRECTORY_SEARCH_PARAMS)
  )
);

// GET /registry/directory-servers/:idOrName
registry.get("/registry/directory-servers/:idOrName", (c) =>
  proxyConvexV1Read(c, "/v1/registry/directory-server", (target) => {
    const idOrName = c.req.param("idOrName");
    const source = c.req.query("source");
    if (source && source.length > 0) {
      target.searchParams.set("name", idOrName);
      target.searchParams.set("source", source);
      return;
    }
    if (looksLikeConvexId(idOrName)) {
      target.searchParams.set("catalogServerId", idOrName);
      return;
    }
    target.searchParams.set("name", idOrName);
  })
);

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
