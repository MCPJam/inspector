import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import {
  getConvexBearerForRequest,
  getDelegatedOrganizationId,
} from "../../utils/v1-convex-token.js";
import { ErrorCode, WebRouteError, parseWithSchema } from "../web/errors.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { v1Resource } from "./envelope.js";

const projects = new Hono();

const createProjectSchema = z.strictObject({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  organizationId: z.string().trim().min(1).optional(),
  icon: z.string().optional(),
  visibility: z.enum(["public", "private"]).optional(),
});

const updateProjectSchema = z
  .strictObject({
    name: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
    visibility: z.enum(["public", "private"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one project field to update.",
  });

function convexClient(token: string): ConvexHttpClient {
  const url = process.env.CONVEX_URL;
  if (!url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_URL configuration"
    );
  }
  const client = new ConvexHttpClient(url);
  client.setAuth(token);
  return client;
}

function translateProjectWriteError(error: unknown): WebRouteError {
  return translateConvexWriteError(error, {
    resource: "Project",
    fallbackMessage: "Project write rejected",
  });
}

async function readProject(token: string, projectId: string) {
  const rows = ((await convexClient(token).query(
    "projects:getMyProjects" as any,
    {} as any
  )) ?? []) as Array<Record<string, unknown>>;
  const row = rows.find(
    (candidate) => String(candidate._id ?? candidate.id) === projectId
  );
  if (!row) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Project not found");
  }
  return {
    id: projectId,
    name: String(row.name ?? ""),
    description: row.description ?? null,
    icon: row.icon ?? null,
    organizationId: row.organizationId ?? null,
    visibility: row.visibility ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

/**
 * Refuse to touch a project outside a delegated caller's organization.
 *
 * DEFENSE-IN-DEPTH, not the only barrier. The backend enforces the delegated
 * token's org claim inside membership resolution itself
 * (`delegatedScopeAllowsOrganization` in mcpjam-backend
 * `convex/lib/authorization.ts`, applied by `getOrgMembership` and therefore
 * by `resolveProjectAccess`/`requireProjectRole`), so a cross-org mutation
 * already fails there. What the chokepoint does NOT cover is
 * `projects:getMyProjects`, which enumerates the user's memberships directly
 * — `readProject` resolves ids across ALL the user's orgs, and this guard is
 * what keeps that resolver from widening the gateway's answer. It also pins
 * the status: a clean 404 here, instead of whatever the backend's rejection
 * translates to.
 *
 * 404, not 403: the existing miss for an unknown id is already 404, and
 * answering 403 here would confirm that a project the key may not see exists.
 *
 * Session-JWT callers skip this — they are confined to nothing.
 */
async function assertProjectWritableByCaller(
  c: Context,
  token: string,
  projectId: string
): Promise<void> {
  const delegatedOrganizationId = getDelegatedOrganizationId(c);
  if (!delegatedOrganizationId) return;
  const project = await readProject(token, projectId);
  if (project.organizationId !== delegatedOrganizationId) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Project not found");
  }
}

// POST /v1/projects — create a project for the caller's organization.
projects.post("/projects", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Invalid JSON body"
    );
  }
  const body = parseWithSchema(createProjectSchema, raw);

  // Org clamp for delegated (`sk_` / service) callers.
  //
  // Two cases, and the SECOND is the load-bearing one. An explicit mismatch
  // is rejected with a clean 403 — the backend's own org chokepoint
  // (`delegatedScopeAllowsOrganization` inside membership resolution) would
  // refuse it anyway, but as a translated backend error rather than this
  // deliberate copy. An ABSENT organizationId is filled in with the key's
  // org: left alone, the backend falls back to the acting user's DEFAULT
  // org, which need not be the key's — and since the chokepoint then rejects
  // the mismatch, `create_project` with just a name (the likely agent call)
  // would ERROR instead of landing in the key's org. The fill-in is what
  // makes the bare call work.
  //
  // Session-JWT callers are untouched: they are confined to nothing and may
  // still create in any org they belong to.
  const delegatedOrganizationId = getDelegatedOrganizationId(c);
  if (delegatedOrganizationId) {
    if (
      body.organizationId &&
      body.organizationId !== delegatedOrganizationId
    ) {
      throw new WebRouteError(
        403,
        ErrorCode.FORBIDDEN,
        "API key is not scoped to this organization"
      );
    }
    body.organizationId = delegatedOrganizationId;
  }

  const token = await getConvexBearerForRequest(c);
  try {
    const id = String(
      await convexClient(token).mutation("projects:createProject" as any, body)
    );
    return v1Resource(c, await readProject(token, id), 201);
  } catch (error) {
    throw translateProjectWriteError(error);
  }
});

// PATCH /v1/projects/:projectId — update project metadata only. Server maps
// are intentionally absent: the backend treats them as a destructive replace.
projects.patch("/projects/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Invalid JSON body"
    );
  }
  const body = parseWithSchema(updateProjectSchema, raw);
  const token = await getConvexBearerForRequest(c);
  try {
    // INSIDE the try: the scope preflight is itself an upstream read, and a
    // network failure of it must answer like every other upstream failure on
    // this route rather than escaping raw. The guard's own 404 is unaffected —
    // `translateConvexWriteError` returns a `WebRouteError` untouched.
    await assertProjectWritableByCaller(c, token, projectId);
    await convexClient(token).mutation("projects:updateProject" as any, {
      projectId,
      ...body,
    });
    return v1Resource(c, await readProject(token, projectId));
  } catch (error) {
    throw translateProjectWriteError(error);
  }
});

// DELETE /v1/projects/:projectId — cascades project-owned resources and
// schedules asynchronous cleanup of large hosted task tables.
projects.delete("/projects/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const raw = await c.req.text();
  if (raw.trim()) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Delete body must be empty"
    );
  }
  const token = await getConvexBearerForRequest(c);
  try {
    // Inside the try for the same reason as the PATCH above.
    await assertProjectWritableByCaller(c, token, projectId);
    await convexClient(token).mutation("projects:deleteProject" as any, {
      projectId,
    });
    return v1Resource(c, { id: projectId, deleted: true });
  } catch (error) {
    throw translateProjectWriteError(error);
  }
});

export default projects;
