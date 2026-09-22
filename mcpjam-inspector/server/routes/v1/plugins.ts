/**
 * Public v1 Agent Plugins surface — READ-ONLY.
 *
 * A plugin is an agent-plugins.org bundle imported into a project; each
 * immutable VERSION materializes MCP servers and skills as ordinary project
 * rows, and environments pin `pluginVersionIds` to run them. Import,
 * activation, enable/disable and uninstall are deliberately NOT here: they
 * are project-admin app flows, and this surface feeds unattended callers
 * (the platform MCP worker) where no plugin write belongs.
 *
 * Thin proxies over the Convex `plugins:*` member-gated reads, called with
 * the request's Convex bearer:
 *
 *   - `listProjectPlugins` takes the path's `projectId` and scopes inside
 *     Convex, like the environments routes.
 *   - `getPluginVersion` takes ONLY the version id; Convex gates on
 *     membership of the version's own project. The route therefore does NOT
 *     carry a `projectId` path segment it could not enforce — a decorative
 *     scope is worse than none. Historical versions of uninstalled plugins
 *     stay readable by backend design (eval snapshots and stale environment
 *     pins reference them).
 */
import { Hono } from "hono";
import { ConvexHttpClient } from "convex/browser";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { translateConvexReadError } from "./convex-read-errors.js";

const plugins = new Hono();

// ── Convex row shapes (hand-mirrored from convex/plugins.ts) ─────────────────

type PluginRow = {
  pluginId: string;
  projectId: string;
  name: string;
  displayName?: string;
  description?: string;
  enabled: boolean;
  activeVersionId?: string;
  /** Always absent here — `listProjectPlugins` filters uninstalled rows. */
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
};

type PluginVersionRow = {
  pluginVersionId: string;
  pluginId: string;
  declaredVersion?: string;
  bundleHash: string;
  manifestHash?: string;
  status: "staging" | "ready" | "invalid";
  componentCounts: {
    skills: number;
    servers: number;
    apps: number;
    assets: number;
    unsupported: number;
  };
  createdAt: number;
  readyAt?: number;
  servers?: Array<{
    componentId: string;
    componentKey: string;
    declaredName: string;
    placement: "remote" | "local" | "computer";
    authenticationPolicy: "on_install" | "on_use";
    materializedServerId: string;
  }>;
  skills?: Array<{
    componentId: string;
    componentKey: string;
    declaredName: string;
    modelRef: string;
    materializedSkillId: string;
  }>;
};

// ── Public DTO mappers (clean `id`; no Convex `pluginId` leak) ───────────────

function toPluginDto(row: PluginRow) {
  return {
    id: row.pluginId,
    projectId: row.projectId,
    name: row.name,
    ...(row.displayName !== undefined ? { displayName: row.displayName } : {}),
    ...(row.description !== undefined ? { description: row.description } : {}),
    enabled: row.enabled,
    ...(row.activeVersionId !== undefined
      ? { activeVersionId: row.activeVersionId }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPluginVersionDto(row: PluginVersionRow) {
  return {
    id: row.pluginVersionId,
    pluginId: row.pluginId,
    ...(row.declaredVersion !== undefined
      ? { declaredVersion: row.declaredVersion }
      : {}),
    bundleHash: row.bundleHash,
    ...(row.manifestHash !== undefined
      ? { manifestHash: row.manifestHash }
      : {}),
    status: row.status,
    componentCounts: row.componentCounts,
    servers: row.servers ?? [],
    skills: row.skills ?? [],
    createdAt: row.createdAt,
    ...(row.readyAt !== undefined ? { readyAt: row.readyAt } : {}),
  };
}

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

/**
 * The `plugins:*` reads throw structured `ConvexError` data (`fail()` in
 * convex/plugins.ts): `NOT_FOUND` for a missing/invalid id, `FORBIDDEN` for
 * a non-member. Both become 404 — confirming that a version id exists to
 * someone outside its project would be a free existence oracle. Everything
 * else goes through the shared read classifier (bad credential → 401,
 * anything of ours → redacted 502).
 */
function translatePluginReadError(error: unknown): WebRouteError {
  const data = (error as { data?: unknown } | null)?.data;
  const code =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as { code?: unknown }).code
      : undefined;
  if (code === "NOT_FOUND" || code === "FORBIDDEN") {
    return new WebRouteError(404, ErrorCode.NOT_FOUND, "Plugin not found");
  }
  return translateConvexReadError(error, {
    scope: "v1/plugins",
    notFoundMessage: "Plugin or project not found, or you do not have access.",
  });
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /v1/projects/:projectId/plugins — the LIVE (non-uninstalled) plugins
// installed in a project, disabled ones included (marked `enabled: false`).
plugins.get("/projects/:projectId/plugins", async (c) => {
  const projectId = c.req.param("projectId");
  const readClient = createConvexClient(await getConvexBearerForRequest(c));
  let rows: PluginRow[] | null | undefined;
  try {
    rows = (await readClient.query(
      "plugins:listProjectPlugins" as any,
      { projectId } as any
    )) as PluginRow[] | null | undefined;
  } catch (error) {
    throw translatePluginReadError(error);
  }
  return v1PageJson(c, (rows ?? []).map(toPluginDto));
});

// GET /v1/plugin-versions/:pluginVersionId — one imported version with its
// component projections. Membership of the version's project is enforced by
// Convex (`loadVersionForRead`).
plugins.get("/plugin-versions/:pluginVersionId", async (c) => {
  const pluginVersionId = c.req.param("pluginVersionId");
  const readClient = createConvexClient(await getConvexBearerForRequest(c));
  let row: PluginVersionRow | null | undefined;
  try {
    row = (await readClient.query(
      "plugins:getPluginVersion" as any,
      { pluginVersionId } as any
    )) as PluginVersionRow | null | undefined;
  } catch (error) {
    throw translatePluginReadError(error);
  }
  if (!row) {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "Plugin version not found"
    );
  }
  return v1Resource(c, toPluginVersionDto(row));
});

export default plugins;
