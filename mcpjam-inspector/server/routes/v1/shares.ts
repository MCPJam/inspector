/**
 * Generic share management. Guest-DENIED (no guest-allowed-paths entry).
 *
 * Preflight: getShareSettings must resolve AND projectId must match the path,
 * else 404. Writes are PROJECTED, never spread. sendInviteEmail is always
 * forwarded explicitly.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import { createConvexClient } from "./convex-client.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1Resource } from "./envelope.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { translateConvexReadError } from "./convex-read-errors.js";

const shares = new Hono();
const BASE = "/projects/:projectId/shares/:resourceType/:resourceId";

type ShareEnvelope = {
  resourceType?: string;
  resourceId: string;
  projectId?: string;
  mode?: string;
  maxShareMode?: string | null;
  policyVersion?: number;
  link?: { token?: string } | null;
  members?: Array<{ id: string; email: string }>;
};

const RESOURCE_TYPES = new Set(["scenario", "conformanceRun", "evalRun"]);

function translateReadError(error: unknown): WebRouteError {
  return translateConvexReadError(error, { scope: "v1.shares" });
}

function translatePreflightReadError(error: unknown): WebRouteError {
  return translateConvexReadError(error, {
    scope: "v1.shares",
    notFoundMessage: "Share not found",
    redactedIsRefusal: true,
  });
}

function translateWriteError(error: unknown): WebRouteError {
  return translateConvexWriteError(error, {
    resource: "Share",
    adminFailureIsForbidden: true,
  });
}

async function parseBody<T>(
  c: { req: { json: () => Promise<unknown> } },
  schema: z.ZodType<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Request body must be JSON",
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      parsed.error.issues[0]?.message ?? "Invalid request body",
    );
  }
  return parsed.data;
}

function requireResourceType(value: string): "scenario" | "conformanceRun" | "evalRun" {
  if (!RESOURCE_TYPES.has(value)) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Share not found");
  }
  return value as "scenario" | "conformanceRun" | "evalRun";
}

function projectEnvelope(
  envelope: ShareEnvelope,
  projectId: string,
): {
  resourceType: string;
  resourceId: string;
  projectId: string;
  mode: string | null;
  maxShareMode: string | null;
  policyVersion: number | null;
  link: { token?: string } | null;
  members: Array<{ id: string; email: string }>;
} {
  return {
    resourceType: envelope.resourceType ?? "",
    resourceId: envelope.resourceId,
    projectId,
    mode: envelope.mode ?? null,
    maxShareMode: envelope.maxShareMode ?? null,
    policyVersion: envelope.policyVersion ?? null,
    link: envelope.link ?? null,
    members: envelope.members ?? [],
  };
}

async function requireShareInProject(
  client: ConvexHttpClient,
  projectId: string,
  resourceType: string,
  resourceId: string,
): Promise<ShareEnvelope> {
  let row: ShareEnvelope | null;
  try {
    row = (await client.query(
      "shares:getShareSettings" as never,
      { resourceType, resourceId } as never,
    )) as ShareEnvelope | null;
  } catch (error) {
    throw translatePreflightReadError(error);
  }
  if (!row || String(row.projectId ?? "") !== projectId) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Share not found");
  }
  return row;
}

async function scopedShare(c: {
  req: { param: (k: string) => string };
}): Promise<{
  client: ConvexHttpClient;
  projectId: string;
  resourceType: "scenario" | "conformanceRun" | "evalRun";
  resourceId: string;
}> {
  const projectId = c.req.param("projectId");
  const resourceType = requireResourceType(c.req.param("resourceType"));
  const resourceId = c.req.param("resourceId");
  const client = createConvexClient(
    await getConvexBearerForRequest(c as never),
  );
  await requireShareInProject(client, projectId, resourceType, resourceId);
  return { client, projectId, resourceType, resourceId };
}

shares.get(BASE, async (c) => {
  const { client, projectId, resourceType, resourceId } = await scopedShare(c);
  let row: ShareEnvelope | null;
  try {
    row = (await client.query(
      "shares:getShareSettings" as never,
      { resourceType, resourceId } as never,
    )) as ShareEnvelope | null;
  } catch (error) {
    throw translateReadError(error);
  }
  if (!row) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Share not found");
  }
  return v1Resource(c, projectEnvelope(row, projectId));
});

const patchSchema = z.strictObject({
  mode: z.enum(["project_members", "invited_only", "anyone_with_link"]),
  allowGuestAccess: z.boolean().optional(),
});

shares.patch(BASE, async (c) => {
  const body = await parseBody(c, patchSchema);
  const { client, projectId, resourceType, resourceId } = await scopedShare(c);
  let result: ShareEnvelope;
  try {
    result = (await client.mutation(
      "shares:setShareMode" as never,
      {
        resourceType,
        resourceId,
        mode: body.mode,
        ...(body.allowGuestAccess !== undefined
          ? { allowGuestAccess: body.allowGuestAccess }
          : {}),
      } as never,
    )) as ShareEnvelope;
  } catch (error) {
    throw translateWriteError(error);
  }
  return v1Resource(c, projectEnvelope(result, projectId));
});

shares.post(`${BASE}/rotate-link`, async (c) => {
  const { client, projectId, resourceType, resourceId } = await scopedShare(c);
  let result: ShareEnvelope;
  try {
    result = (await client.mutation(
      "shares:rotateShareLink" as never,
      { resourceType, resourceId } as never,
    )) as ShareEnvelope;
  } catch (error) {
    throw translateWriteError(error);
  }
  return v1Resource(c, {
    resourceType,
    resourceId,
    projectId,
    rotated: true,
    link: result?.link ?? null,
    policyVersion: result?.policyVersion ?? null,
  });
});

const upsertMemberSchema = z.strictObject({
  email: z.string().trim().min(3).max(320),
  sendInviteEmail: z.boolean().optional(),
});

shares.put(`${BASE}/members`, async (c) => {
  const body = await parseBody(c, upsertMemberSchema);
  const { client, projectId, resourceType, resourceId } = await scopedShare(c);
  let result: ShareEnvelope;
  try {
    result = (await client.mutation(
      "shares:upsertShareMember" as never,
      {
        resourceType,
        resourceId,
        email: body.email,
        sendInviteEmail: body.sendInviteEmail ?? false,
      } as never,
    )) as ShareEnvelope;
  } catch (error) {
    throw translateWriteError(error);
  }
  return v1Resource(c, {
    resourceType,
    resourceId,
    projectId,
    email: body.email,
    members: result?.members ?? [],
    policyVersion: result?.policyVersion ?? null,
  });
});

shares.delete(`${BASE}/members/:memberIdOrEmail`, async (c) => {
  const { client, projectId, resourceType, resourceId } = await scopedShare(c);
  const memberIdOrEmail = c.req.param("memberIdOrEmail");
  let result: ShareEnvelope;
  try {
    result = (await client.mutation(
      "shares:removeShareMember" as never,
      { resourceType, resourceId, memberIdOrEmail } as never,
    )) as ShareEnvelope;
  } catch (error) {
    throw translateWriteError(error);
  }
  return v1Resource(c, {
    resourceType,
    resourceId,
    projectId,
    removed: memberIdOrEmail,
    members: result?.members ?? [],
    policyVersion: result?.policyVersion ?? null,
  });
});

export default shares;
