import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { ErrorCode, WebRouteError, parseWithSchema } from "../web/errors.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { v1Resource } from "./envelope.js";

import { readDeletionCapabilities } from "./deletion-capabilities.js";

const deletions = new Hono();
const requestSchema = z.strictObject({
  scope: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("organization"), id: z.string().min(1) }),
    z.strictObject({ type: z.literal("project"), id: z.string().min(1) }),
  ]),
});
const receiptSchema = z.object({
  requestId: z.string(),
  scope: z.object({
    type: z.enum(["organization", "project"]),
    id: z.string(),
  }),
  state: z.string(),
  acceptedAt: z.number(),
  purgeAfter: z.number().nullable(),
  statusUrl: z.string(),
  canCancel: z.boolean(),
  liveDataDeletedAt: z.number().nullable(),
  closedAt: z.number().nullable(),
  attentionCode: z.string().nullable(),
});

const requestDeletion = makeFunctionReference<"mutation">(
  "deletionRequests:request",
);
const getDeletion = makeFunctionReference<"query">("deletionRequests:status");
const authorizeDeletion = makeFunctionReference<"mutation">(
  "deletionRequests:authorizeReceipt",
);
const cancelDeletion = makeFunctionReference<"mutation">(
  "deletionRequests:cancel",
);

function client(token: string): ConvexHttpClient {
  const url = process.env.CONVEX_URL;
  if (!url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_URL configuration",
    );
  }
  const convex = new ConvexHttpClient(url);
  convex.setAuth(token);
  return convex;
}

function writeError(error: unknown): WebRouteError {
  const refusal = z
    .object({ data: z.object({ code: z.string() }) })
    .safeParse(error);
  const code = refusal.success ? refusal.data.data.code : undefined;
  if (code === "DELETION_UNAVAILABLE") {
    return new WebRouteError(
      422,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "Deletion requests are not available yet.",
      { code },
    );
  }
  if (code === "INVALID_IDEMPOTENCY_KEY") {
    return new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "A valid Idempotency-Key header is required.",
      { code },
    );
  }
  if (
    code === "DELETION_IN_PROGRESS" ||
    code === "DELETION_ALREADY_STARTED" ||
    code === "IDEMPOTENCY_KEY_REUSED"
  ) {
    return new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      code === "IDEMPOTENCY_KEY_REUSED"
        ? "This idempotency key belongs to a different deletion request."
        : "The deletion request cannot be changed in its current state.",
      { code },
    );
  }
  return translateConvexWriteError(error, {
    resource: "Deletion request",
    fallbackMessage: "Deletion request rejected",
  });
}

deletions.get("/deletions/capabilities", async (c) => {
  const token = await getConvexBearerForRequest(c);
  return v1Resource(c, await readDeletionCapabilities(client(token)));
});

deletions.post("/deletions", async (c) => {
  const rawKey = c.req.header("Idempotency-Key")?.trim();
  if (!rawKey || rawKey.length > 128) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "A valid Idempotency-Key header is required",
    );
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Invalid JSON body",
    );
  }
  const body = parseWithSchema(requestSchema, raw);
  const token = await getConvexBearerForRequest(c);
  try {
    const receipt = receiptSchema.parse(
      await client(token).mutation(requestDeletion, {
        scope: body.scope,
        idempotencyKey: rawKey,
      }),
    );
    const statusUrl = `/api/v1/deletions/${encodeURIComponent(receipt.requestId)}`;
    c.header("Location", statusUrl);
    return v1Resource(c, { ...(receipt as object), statusUrl }, 202);
  } catch (error) {
    throw writeError(error);
  }
});

deletions.get("/deletions/:requestId", async (c) => {
  const token = await getConvexBearerForRequest(c);
  try {
    const result = await client(token).query(getDeletion, {
      requestId: c.req.param("requestId"),
    });
    // Do not reveal whether an unknown request exists to an unauthorized user.
    if (!result)
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "Deletion request not found",
      );
    const receipt = receiptSchema.parse(result);
    return v1Resource(c, receipt);
  } catch (error) {
    if (error instanceof WebRouteError) throw error;
    throw writeError(error);
  }
});

deletions.post("/deletions/:requestId/authorize", async (c) => {
  const raw = await c.req.text();
  if (raw.trim()) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Authorize body must be empty",
    );
  }
  const token = await getConvexBearerForRequest(c);
  try {
    const receipt = receiptSchema.parse(
      await client(token).mutation(authorizeDeletion, {
        requestId: c.req.param("requestId"),
      }),
    );
    return v1Resource(c, receipt);
  } catch (error) {
    throw writeError(error);
  }
});

deletions.post("/deletions/:requestId/cancel", async (c) => {
  const raw = await c.req.text();
  if (raw.trim()) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Cancel body must be empty",
    );
  }
  const token = await getConvexBearerForRequest(c);
  try {
    const receipt = receiptSchema.parse(
      await client(token).mutation(cancelDeletion, {
        requestId: c.req.param("requestId"),
      }),
    );
    const state = receipt.state;
    return v1Resource(c, receipt, state === "cancel_pending" ? 202 : 200);
  } catch (error) {
    throw writeError(error);
  }
});

export default deletions;
