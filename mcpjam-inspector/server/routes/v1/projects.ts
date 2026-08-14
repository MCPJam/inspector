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
 * The mutations address a project by id, and the backend resolves access from
 * the acting USER (`resolveProjectAccess`), never from the delegated token's
 * org — so an `sk_` key bound to org A, minted by someone who also belongs to
 * org B, can otherwise rename or delete B's projects. `getMyProjects` returns
 * the user's projects across ALL their orgs, which is exactly why the id
 * resolves at all and exactly why this check is needed.
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

  // Org clamp for delegated (`sk_` / service) callers, applied HERE because
  // the backend mutation does not: `projects:createProject` checks the acting
  // USER's membership in the requested org (`requireOrgRole`), and
  // `userMutation` never reads the delegated-org claim. So a key bound to org
  // A, minted by someone who also belongs to org B, could otherwise create in
  // B. This mirrors the clamp the Convex `/v1/projects` READ route already
  // applies (convex/publicApi/routes.ts).
  //
  // Two cases, and the SECOND is the common one: an explicit mismatch is
  // rejected, and an ABSENT organizationId is filled in rather than left to
  // the backend's "the user's default org" fallback — which for a delegated
  // key is not necessarily the org the key is bound to. An agent calling
  // create_project with just a name is the likely path, and it must land in
  // the key's org.
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
