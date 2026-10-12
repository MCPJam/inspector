import { Hono, type Context } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { bodyLimit } from "hono/body-limit";
import {
  accountDeletionCapabilitiesSchema,
  accountDeletionInspectionSchema,
  accountDeletionReceiptSchema,
} from "@mcpjam/sdk/account-deletion";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { passthroughRateLimitMiddleware } from "../../middleware/passthrough-rate-limit.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { getAttestedClientIp } from "../../utils/client-ip.js";
import { HOSTED_MODE } from "../../config.js";

const route = new Hono();
const recoverySchema = z.strictObject({
  receiptSecret: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => value.trim() === value),
});
const requestSchema = recoverySchema.extend({
  ownershipCheckpointSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const windows = new Map<string, { count: number; until: number }>();

function receiptAllowed(c: Context): boolean {
  if (!HOSTED_MODE) return true;
  const now = Date.now();
  for (const [key, entry] of windows)
    if (entry.until <= now) windows.delete(key);
  const key = getAttestedClientIp(c) ?? "unattested";
  const entry = windows.get(key);
  if (entry) {
    if (entry.count >= 30) return false;
    entry.count++;
    return true;
  }
  if (windows.size >= 10_000) return false;
  windows.set(key, { count: 1, until: now + 60_000 });
  return true;
}
function client(): ConvexHttpClient {
  if (!process.env.CONVEX_URL) throw new Error("ACCOUNT_DELETION_UNAVAILABLE");
  return new ConvexHttpClient(process.env.CONVEX_URL);
}
function failure(c: Context, error: unknown): Response {
  // Never relay validation diagnostics containing the secret-bearing arguments.
  const parsed = z
    .object({ data: z.object({ code: z.string() }) })
    .safeParse(error);
  const code = parsed.success
    ? parsed.data.data.code
    : "ACCOUNT_DELETION_TRANSPORT_FAILED";
  const conflicts = new Set([
    "ACCOUNT_OWNERSHIP_REQUIRED",
    "ACCOUNT_OWNERSHIP_CHANGED",
    "ACCOUNT_IDENTITY_COVERAGE_REQUIRED",
    "ACCOUNT_DELETION_ALREADY_ACCEPTED",
  ]);
  if (conflicts.has(code)) return c.json({ code }, 409);
  if (code === "ACCOUNT_DELETION_ARGUMENTS_INVALID")
    return c.json({ code }, 400);
  if (code === "ACCOUNT_DELETION_UNAVAILABLE") return c.json({ code }, 503);
  if (code === "ACCOUNT_DELETION_PERSON_REQUIRED") return c.json({ code }, 403);
  return c.json({ code: "ACCOUNT_DELETION_TRANSPORT_FAILED" }, 503);
}
route.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  return next();
});
route.use(
  "*",
  bodyLimit({
    maxSize: 2048,
    onError: (c) => c.json({ code: "ACCOUNT_DELETION_ARGUMENTS_INVALID" }, 413),
  }),
);

/** Public receipt-only authority; no bearer verification, delegation or user lookup. */
route.post("/receipt", async (c) => {
  if (!receiptAllowed(c))
    return c.json({ code: "ACCOUNT_RECEIPT_RATE_LIMITED" }, 429);
  try {
    const text = await c.req.text();
    if (text.length > 2048) return c.json(null);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return c.json(null);
    }
    const args = recoverySchema.safeParse(raw);
    if (!args.success) return c.json(null);
    const value = await client().action(
      makeFunctionReference<"action">("accountDeletion:receipt"),
      args.data,
    );
    const receipt = accountDeletionReceiptSchema.nullable().safeParse(value);
    return receipt.success ? c.json(receipt.data) : failure(c, null);
  } catch {
    return failure(c, null);
  }
});

for (const path of ["/capabilities", "/inspect", "/request"]) {
  route.use(path, bearerAuthMiddleware, passthroughRateLimitMiddleware);
}
async function authenticated(c: Context): Promise<ConvexHttpClient> {
  const method = c.get("authMethod");
  if (method !== "authkit_jwt" && method !== "unverified_passthrough") {
    throw { data: { code: "ACCOUNT_DELETION_PERSON_REQUIRED" } };
  }
  const convex = client();
  convex.setAuth(await getConvexBearerForRequest(c));
  return convex;
}
route.get("/capabilities", async (c) => {
  try {
    const value = await (
      await authenticated(c)
    ).query(makeFunctionReference<"query">("accountDeletion:capabilities"), {});
    const result = accountDeletionCapabilitiesSchema.safeParse(value);
    return result.success ? c.json(result.data) : failure(c, null);
  } catch (error) {
    return failure(c, error);
  }
});
route.get("/inspect", async (c) => {
  try {
    const value = await (
      await authenticated(c)
    ).query(makeFunctionReference<"query">("accountDeletion:inspect"), {});
    const result = accountDeletionInspectionSchema.safeParse(value);
    return result.success ? c.json(result.data) : failure(c, null);
  } catch (error) {
    return failure(c, error);
  }
});
route.post("/request", async (c) => {
  try {
    const text = await c.req.text();
    if (text.length > 2048)
      return c.json({ code: "ACCOUNT_DELETION_ARGUMENTS_INVALID" }, 400);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return c.json({ code: "ACCOUNT_DELETION_ARGUMENTS_INVALID" }, 400);
    }
    const args = requestSchema.safeParse(raw);
    if (!args.success)
      return c.json({ code: "ACCOUNT_DELETION_ARGUMENTS_INVALID" }, 400);
    const value = await (
      await authenticated(c)
    ).mutation(
      makeFunctionReference<"mutation">("accountDeletion:request"),
      args.data,
    );
    const result = accountDeletionReceiptSchema.safeParse(value);
    return result.success ? c.json(result.data, 202) : failure(c, null);
  } catch (error) {
    return failure(c, error);
  }
});
export default route;
