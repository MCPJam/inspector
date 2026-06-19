/**
 * Public v1 host surface: CRUD over a project's MCP hosts.
 *
 * Hosts are project-scoped identity rows that point at a content-addressed
 * host config (model + capabilities + host context). These routes are thin
 * proxies over the same Convex `hosts:*` functions the hosted UI uses, called
 * with the request's Convex bearer (Convex enforces project membership). Each
 * mutating/detail route additionally cross-checks the host against the path's
 * projectId (by listing the project's hosts) so a valid id from another
 * project reads as NOT_FOUND.
 *
 * `create` seeds the host config two ways: from a built-in template
 * (resolved server-side via `@mcpjam/sdk/host-config/templates` — the same
 * Node-safe seeds the inspector UI uses) or from a full host config body.
 */
import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { seedHostTemplate } from "@mcpjam/sdk/host-config/templates";
import { parseWithSchema, ErrorCode, WebRouteError } from "../web/errors.js";
import { createConvexClients } from "../shared/evals.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { synthesizeServerBody } from "./adapter.js";

const hosts = new Hono();

// Stamped into the mcpjam template's mcpProfile version (cosmetic; only the
// mcpjam template reads it). Mirrors the inspector build version the UI threads
// in via the Vite `__APP_VERSION__` constant.
const INSPECTOR_VERSION = process.env.npm_package_version ?? "0.0.0";

const HOST_TEMPLATE_IDS = [
  "mcpjam",
  "claude",
  "claude-code",
  "chatgpt",
  "mistral",
  "cursor",
  "codex",
  "copilot",
  "vscode",
  "agentcore",
  "n8n",
  "perplexity",
] as const;

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
    return new WebRouteError(404, ErrorCode.NOT_FOUND, "Host not found");
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

/**
 * List the project's hosts and return the row matching `hostId`. Throws 404
 * when the host doesn't exist in this project — the per-request project-scope
 * guard for detail/update/delete (Convex `hosts:getHost` is keyed by hostId
 * alone, so a bare getHost would leak a host from another of the caller's
 * projects under this path).
 */
async function requireHostInProject(
  readClient: ConvexHttpClient,
  projectId: string,
  hostId: string
): Promise<HostListRow> {
  let rows: HostListRow[] | null | undefined;
  try {
    rows = (await readClient.query("hosts:listHosts" as any, {
      projectId,
    } as any)) as HostListRow[] | null | undefined;
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  const match = (rows ?? []).find((row) => row.hostId === hostId);
  if (!match) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Host not found");
  }
  return match;
}

async function readHostDetail(
  convexAuthToken: string,
  projectId: string,
  hostId: string
): Promise<HostDetailRow> {
  const readClient = createConvexReadClient(convexAuthToken);
  await requireHostInProject(readClient, projectId, hostId);
  let detail: HostDetailRow | null;
  try {
    detail = (await readClient.query("hosts:getHost" as any, {
      hostId,
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
    (value) => (value.template ? 1 : 0) + (value.config ? 1 : 0) === 1,
    { message: "Provide exactly one of `template` or `config`." }
  );

const updateHostSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    config: hostConfigSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.config !== undefined, {
    message: "Provide at least one of `name` or `config` to update.",
  });

const deleteHostSchema = z.object({ force: z.boolean().optional() });

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
  const readClient = createConvexReadClient(token);
  await requireHostInProject(readClient, projectId, hostId);

  const updateArgs: Record<string, unknown> = { hostId };
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
  const body = parseWithSchema(deleteHostSchema, await synthesizeServerBody(c));
  const token = await getConvexBearerForRequest(c);
  const readClient = createConvexReadClient(token);
  await requireHostInProject(readClient, projectId, hostId);
  const { convexClient } = createConvexClients(token);
  try {
    await convexClient.mutation("hosts:deleteHost" as any, {
      hostId,
      ...(body.force ? { force: true } : {}),
    });
  } catch (error) {
    throw translateConvexWriteError(error);
  }
  return v1Resource(c, { id: hostId, deleted: true });
});

export default hosts;
