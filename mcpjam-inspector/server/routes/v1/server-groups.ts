/**
 * Public v1 server-group surface: list and create a project's standalone
 * server groups.
 *
 * A server group is an immutable SNAPSHOT of a set of saved servers — the
 * backend's `serverAttachment` rows with `scope: 'standalone'`. Pinning one on
 * an environment is what stops a run from following its host's live server
 * list, so a composed eval keeps testing the servers it was composed against
 * even after somebody edits the shared host.
 *
 * "Server group" is the user-facing vocabulary (it matches the `serverGroup`
 * compose field and the web `ServerGroupPicker`); `serverAttachment` is the
 * backend's internal name and stays out of the public contract.
 *
 * These are thin proxies over the same Convex `serverAttachments:*` functions
 * the hosted UI calls, with the request's Convex bearer — Convex enforces
 * project membership (guest to list, member to create) and rejects servers
 * from another project, soft-deleted servers, and plugin-managed ones. There
 * is no update route because standalone rows are create-only by design: an
 * editable group would reintroduce exactly the drift the pin exists to close.
 */
import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { parseWithSchema, ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { readJsonObjectBody } from "./adapter.js";

const serverGroups = new Hono();

// ── Convex row shape (mirrors serverAttachments:listServerAttachments) ──────
type ServerGroupRow = {
  _id: string;
  name?: string;
  description?: string;
  serverIds?: string[];
  resolvedServerNames?: string[];
  createdAt?: number;
  updatedAt?: number;
};

const createServerGroupSchema = z.strictObject({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  serverIds: z.array(z.string().trim().min(1)).min(1),
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

function translateServerGroupError(error: unknown): WebRouteError {
  return translateConvexWriteError(error, {
    resource: "Server group",
    conflictMessage:
      "A server group with that name already exists in this project.",
    fallbackMessage: "Server group write rejected",
  });
}

function toServerGroupDto(row: ServerGroupRow) {
  return {
    id: String(row._id),
    name: row.name ?? "",
    description: row.description ?? null,
    serverIds: (row.serverIds ?? []).map(String),
    // Hydrated by the backend through the live-edge resolver, so a renamed
    // server reads under its current name and a deleted one is labelled
    // rather than dropped — the id list stays authoritative either way.
    serverNames: row.resolvedServerNames ?? [],
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

// GET /v1/projects/:projectId/server-groups — list live standalone groups.
serverGroups.get("/projects/:projectId/server-groups", async (c) => {
  const projectId = c.req.param("projectId");
  const readClient = createConvexClient(await getConvexBearerForRequest(c));
  let rows: ServerGroupRow[] | null | undefined;
  try {
    rows = (await readClient.query(
      "serverAttachments:listServerAttachments" as any,
      { projectId } as any
    )) as ServerGroupRow[] | null | undefined;
  } catch (error) {
    throw translateServerGroupError(error);
  }
  return v1PageJson(c, (rows ?? []).map(toServerGroupDto));
});

// POST /v1/projects/:projectId/server-groups — snapshot a set of servers.
serverGroups.post("/projects/:projectId/server-groups", async (c) => {
  const projectId = c.req.param("projectId");
  const body = parseWithSchema(
    createServerGroupSchema,
    await readJsonObjectBody(c)
  );
  const convexClient = createConvexClient(await getConvexBearerForRequest(c));
  let created: ServerGroupRow;
  try {
    created = (await convexClient.mutation(
      "serverAttachments:createServerAttachment" as any,
      {
        projectId,
        name: body.name,
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        serverIds: body.serverIds,
      } as any
    )) as ServerGroupRow;
  } catch (error) {
    throw translateServerGroupError(error);
  }
  return v1Resource(c, toServerGroupDto(created), 201);
});

export default serverGroups;
