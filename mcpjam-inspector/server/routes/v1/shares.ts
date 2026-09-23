/**
 * Generic share management. Guest-DENIED (no guest-allowed-paths entry).
 *
 * Preflight: getShareSettings must resolve AND projectId must match the path,
 * else 404. Writes are PROJECTED, never spread. sendInviteEmail is always
 * forwarded explicitly.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import {
  UNKNOWN_API_VOCABULARY_MESSAGE,
  apiVocabularyOf,
  hasUnknownApiVocabulary,
  projectNounValue,
  storageNounValue,
  type ApiVocabulary,
} from "./api-vocabulary.js";
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

/**
 * The stored resource types. `scenario` is spelled `study` on the wire under
 * `x-mcpjam-api-vocabulary: 2` — here that value is a PATH SEGMENT as well as
 * a response field, so both directions are projected: the segment folds back
 * onto the stored spelling before anything reads it, and the echo goes out in
 * whichever spelling the caller negotiated.
 */
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

function requireResourceType(
  value: string,
  vocabulary: ApiVocabulary,
): "scenario" | "conformanceRun" | "evalRun" {
  // Folded to the stored spelling FIRST: a vocabulary-2 caller addressing
  // `/shares/study/...` is asking for the same rows as `/shares/scenario/...`,
  // and everything below this line — the preflight, the Convex args, the
  // 404 — speaks storage. A vocabulary-1 caller sending `study` folds to
  // nothing and 404s, which is today's answer for an unknown segment.
  const stored = storageNounValue(value, vocabulary);
  if (!RESOURCE_TYPES.has(stored)) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Share not found");
  }
  return stored as "scenario" | "conformanceRun" | "evalRun";
}

function projectEnvelope(
  envelope: ShareEnvelope,
  projectId: string,
  vocabulary: ApiVocabulary,
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
    resourceType: envelope.resourceType
      ? projectNounValue(envelope.resourceType, vocabulary)
      : "",
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

async function scopedShare(c: Context): Promise<{
  client: ConvexHttpClient;
  projectId: string;
  resourceType: "scenario" | "conformanceRun" | "evalRun";
  resourceId: string;
  vocabulary: ApiVocabulary;
}> {
  if (hasUnknownApiVocabulary(c)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      UNKNOWN_API_VOCABULARY_MESSAGE,
    );
  }
  // Reads the header AND appends `Vary` — the resource type is echoed on
  // every response here, so every response varies on it.
  const vocabulary = apiVocabularyOf(c);
  const projectId = c.req.param("projectId");
  const resourceType = requireResourceType(
    c.req.param("resourceType"),
    vocabulary,
  );
  const resourceId = c.req.param("resourceId");
  const client = createConvexClient(
    await getConvexBearerForRequest(c as never),
  );
  await requireShareInProject(client, projectId, resourceType, resourceId);
  return { client, projectId, resourceType, resourceId, vocabulary };
}

shares.get(BASE, async (c) => {
  const { client, projectId, resourceType, resourceId, vocabulary } =
    await scopedShare(c);
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
  return v1Resource(c, projectEnvelope(row, projectId, vocabulary));
});

const patchSchema = z.strictObject({
  mode: z.enum(["project_members", "invited_only", "anyone_with_link"]),
  allowGuestAccess: z.boolean().optional(),
});

shares.patch(BASE, async (c) => {
  const body = await parseBody(c, patchSchema);
  const { client, projectId, resourceType, resourceId, vocabulary } =
    await scopedShare(c);
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
  return v1Resource(c, projectEnvelope(result, projectId, vocabulary));
});

shares.post(`${BASE}/rotate-link`, async (c) => {
  const { client, projectId, resourceType, resourceId, vocabulary } =
    await scopedShare(c);
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
    resourceType: projectNounValue(resourceType, vocabulary),
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
  const { client, projectId, resourceType, resourceId, vocabulary } =
    await scopedShare(c);
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
    resourceType: projectNounValue(resourceType, vocabulary),
    resourceId,
    projectId,
    email: body.email,
    members: result?.members ?? [],
    policyVersion: result?.policyVersion ?? null,
  });
});

shares.delete(`${BASE}/members/:memberIdOrEmail`, async (c) => {
  const { client, projectId, resourceType, resourceId, vocabulary } =
    await scopedShare(c);
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
    resourceType: projectNounValue(resourceType, vocabulary),
    resourceId,
    projectId,
    removed: memberIdOrEmail,
    members: result?.members ?? [],
    policyVersion: result?.policyVersion ?? null,
  });
});

export default shares;
