/**
 * Public v1 host surface: CRUD over a project's MCP hosts.
 *
 * Hosts are project-scoped identity rows that point at a content-addressed
 * host config (model + capabilities + host context). These routes are thin
 * proxies over the same Convex `hosts:*` functions the hosted UI uses, called
 * with the request's Convex bearer (Convex enforces project membership). The
 * detail/update/delete `hosts:*` functions take the path's projectId and scope
 * the host to it inside Convex, so a valid id from another of the caller's
 * projects reads as NOT_FOUND.
 *
 * `create` seeds the host config two ways: from a built-in template
 * (resolved server-side via `@mcpjam/sdk/host-config/templates` — the same
 * Node-safe seeds the inspector UI uses) or from a full host config body.
 */
import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { createRequire } from "module";
import {
  seedHostTemplate,
  HOST_TEMPLATE_IDS,
} from "@mcpjam/sdk/host-config/templates";
import { parseWithSchema, ErrorCode, WebRouteError } from "../web/errors.js";
import { createConvexClients } from "../shared/evals.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { synthesizeServerBody } from "./adapter.js";

const hosts = new Hono();
const require = createRequire(import.meta.url);
const inspectorPkg = require("@mcpjam/inspector/package.json") as {
  version?: string;
};

// Stamped into the mcpjam template's mcpProfile version (cosmetic; only the
// mcpjam template reads it). Mirrors the inspector build version the UI threads
// in via the Vite `__APP_VERSION__` constant (both derive from this same
// package.json), so a server-created mcpjam host matches a UI-created one.
const INSPECTOR_VERSION = inspectorPkg.version ?? "0.0.0";

// ── Convex row shapes (mirrored from client/src/hooks/useClients.ts) ────────
type HostListRow = {
  hostId: string;
  name: string;
  hostConfigId: string;
  modelId: string;
  serverCount: number;
  createdAt: number;
  updatedAt: number;
};

type HostDetailRow = {
  hostId: string;
  name: string;
  config: Record<string, unknown>;
};

// ── Public DTO mappers (clean names; no Convex `hostId` leak) ────────────────
function toHostDto(row: HostListRow) {
  return {
    id: row.hostId,
    name: row.name,
    hostConfigId: row.hostConfigId,
    modelId: row.modelId,
    serverCount: row.serverCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toHostDetailDto(detail: HostDetailRow) {
  return { id: detail.hostId, name: detail.name, config: detail.config };
}

function createConvexReadClient(convexAuthToken: string): ConvexHttpClient {
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

function translateConvexWriteError(error: unknown): WebRouteError {
  if (error instanceof WebRouteError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|unauthorized|not a member/i.test(message)) {
    // Convex collapses "project missing", "not a project member", and "host
    // missing" into the same generic error, and the v1 surface deliberately
    // doesn't leak which. Keep the message neutral rather than asserting
    // "Host not found" — the failure on the list/create paths is usually the
    // PROJECT (bad id or no membership), where a host-specific message misleads.
    return new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "Project or host not found, or you do not have access to it."
    );
  }
  const cleaned = message
    .replace(/\[Request ID:[^\]]*\]\s*/g, "")
    .replace(/^Server Error\s*/i, "")
    .replace(/Uncaught (Error|ConvexError):\s*/i, "")
    .split("\n")[0]!
    .trim();
  return new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    cleaned || "Host write rejected by the platform"
  );
}

async function readHostDetail(
  convexAuthToken: string,
  projectId: string,
  hostId: string
): Promise<HostDetailRow> {
  const readClient = createConvexReadClient(convexAuthToken);
  let detail: HostDetailRow | null;
  try {
    // Convex `hosts:getHost` enforces project scope: passing `projectId` means
    // a host id from another of the caller's projects returns null (→ 404
    // below) instead of leaking across projects.
    detail = (await readClient.query("hosts:getHost" as any, {
      hostId,
      projectId,
    } as any)) as HostDetailRow | null;
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  if (!detail) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Host not found");
  }
  return detail;
}

// ── Schemas ─────────────────────────────────────────────────────────────────
const hostConfigSchema = z.record(z.string(), z.unknown());

const createHostSchema = z
  .object({
    name: z.string().trim().min(1),
    template: z.enum(HOST_TEMPLATE_IDS).optional(),
    theme: z.enum(["light", "dark"]).optional(),
    config: hostConfigSchema.optional(),
  })
  .refine(
    (value) => {
      // An empty `{}` is a truthy object but not a usable host config; count
      // config only when it actually carries fields so `--json '{}'` can't
      // satisfy the XOR and mint a degenerate host.
      const hasConfig =
        value.config !== undefined && Object.keys(value.config).length > 0;
      return (value.template ? 1 : 0) + (hasConfig ? 1 : 0) === 1;
    },
    { message: "Provide exactly one of `template` or a non-empty `config`." }
  );

const updateHostSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    config: hostConfigSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.config !== undefined, {
    message: "Provide at least one of `name` or `config` to update.",
  });

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /v1/projects/:projectId/hosts — list a project's hosts.
hosts.get("/projects/:projectId/hosts", async (c) => {
  const projectId = c.req.param("projectId");
  const readClient = createConvexReadClient(await getConvexBearerForRequest(c));
  let rows: HostListRow[] | null | undefined;
  try {
    rows = (await readClient.query("hosts:listHosts" as any, {
      projectId,
    } as any)) as HostListRow[] | null | undefined;
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return v1PageJson(c, (rows ?? []).map(toHostDto));
});

// GET /v1/projects/:projectId/hosts/:hostId — full host detail + config.
hosts.get("/projects/:projectId/hosts/:hostId", async (c) => {
  const projectId = c.req.param("projectId");
  const hostId = c.req.param("hostId");
  const token = await getConvexBearerForRequest(c);
  return v1Resource(c, toHostDetailDto(await readHostDetail(token, projectId, hostId)));
});

// POST /v1/projects/:projectId/hosts — create from a template or a full config.
hosts.post("/projects/:projectId/hosts", async (c) => {
  const projectId = c.req.param("projectId");
  const body = parseWithSchema(createHostSchema, await synthesizeServerBody(c));
  const token = await getConvexBearerForRequest(c);
  const { convexClient } = createConvexClients(token);

  const input = body.template
    ? seedHostTemplate(body.template, {
        theme: body.theme,
        appVersion: INSPECTOR_VERSION,
      })
    : body.config;

  let created: { hostId: string };
  try {
    created = (await convexClient.mutation("hosts:createHost" as any, {
      projectId,
      name: body.name,
      input,
    } as any)) as { hostId: string };
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return v1Resource(
    c,
    toHostDetailDto(await readHostDetail(token, projectId, created.hostId)),
    201
  );
});

// PATCH /v1/projects/:projectId/hosts/:hostId — rename and/or replace config.
hosts.patch("/projects/:projectId/hosts/:hostId", async (c) => {
  const projectId = c.req.param("projectId");
  const hostId = c.req.param("hostId");
  const body = parseWithSchema(updateHostSchema, await synthesizeServerBody(c));
  const token = await getConvexBearerForRequest(c);

  // `hosts:updateHost` enforces project scope from `projectId` (a host from
  // another project throws not-found → 404), so there is no separate preflight.
  const updateArgs: Record<string, unknown> = { hostId, projectId };
  if (body.name !== undefined) updateArgs.name = body.name;
  if (body.config !== undefined) updateArgs.input = body.config;
  const { convexClient } = createConvexClients(token);
  try {
    await convexClient.mutation("hosts:updateHost" as any, updateArgs);
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return v1Resource(c, toHostDetailDto(await readHostDetail(token, projectId, hostId)));
});

// DELETE /v1/projects/:projectId/hosts/:hostId
hosts.delete("/projects/:projectId/hosts/:hostId", async (c) => {
  const projectId = c.req.param("projectId");
  const hostId = c.req.param("hostId");
  // Delete takes no body. Read the raw payload directly (NOT via
  // synthesizeServerBody, which injects the path projectId/serverId) so the
  // contract is truly bodyless: reject ANY field — a legacy `force`, or even a
  // stray `projectId` — as VALIDATION_ERROR rather than accepting or dropping it.
  const rawDeleteBody = await c.req.text();
  if (rawDeleteBody.trim()) {
    let parsedDeleteBody: unknown;
    try {
      parsedDeleteBody = JSON.parse(rawDeleteBody);
    } catch {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Invalid JSON body"
      );
    }
    if (
      !parsedDeleteBody ||
      typeof parsedDeleteBody !== "object" ||
      Array.isArray(parsedDeleteBody)
    ) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Request body must be a JSON object"
      );
    }
    const strayDeleteFields = Object.keys(parsedDeleteBody).sort();
    if (strayDeleteFields.length > 0) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        `Unexpected field(s) in delete body: ${strayDeleteFields.join(", ")}`
      );
    }
  }
  const token = await getConvexBearerForRequest(c);
  // `hosts:deleteHost` enforces project scope from `projectId`.
  const { convexClient } = createConvexClients(token);
  try {
    await convexClient.mutation("hosts:deleteHost" as any, {
      hostId,
      projectId,
    });
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return v1Resource(c, { id: hostId, deleted: true });
});

export default hosts;
