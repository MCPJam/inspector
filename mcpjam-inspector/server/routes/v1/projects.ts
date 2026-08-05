import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { ErrorCode, WebRouteError, parseWithSchema } from "../web/errors.js";
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
  const data =
    typeof error === "object" && error !== null
      ? (error as { data?: unknown }).data
      : undefined;
  if (typeof data === "object" && data !== null) {
    const structured = data as { code?: unknown; message?: unknown };
    if (structured.code === "FORBIDDEN") {
      return new WebRouteError(
        403,
        ErrorCode.FORBIDDEN,
        String(structured.message ?? "Project write forbidden")
      );
    }
    if (structured.code === "NOT_FOUND") {
      return new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        String(structured.message ?? "Project not found")
      );
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|not a member/i.test(message)) {
    return new WebRouteError(404, ErrorCode.NOT_FOUND, "Project not found");
  }
  if (/permission|forbidden|admin/i.test(message)) {
    return new WebRouteError(403, ErrorCode.FORBIDDEN, message);
  }
  return new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    message.split("\n")[0] || "Project write rejected"
  );
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
    await convexClient(token).mutation("projects:deleteProject" as any, {
      projectId,
    });
    return v1Resource(c, { id: projectId, deleted: true });
  } catch (error) {
    throw translateProjectWriteError(error);
  }
});

export default projects;
