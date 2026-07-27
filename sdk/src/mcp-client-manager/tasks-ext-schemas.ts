/**
 * PIN: modelcontextprotocol/ext-tasks @ 2c1425d9a288b9b1f489430fe1e00bb392b47e48
 * (`schema/draft/schema.json`). Re-diff against that commit when re-syncing.
 */
/**
 * Runtime validation for `io.modelcontextprotocol/tasks` (SEP-2663) payloads.
 *
 * VENDORED-FROM-SEP-2663-DRAFT — zod mirrors of the extension's
 * `schema/draft/schema.json`. Task payloads come from an untrusted server, so
 * a hand-written `resultType` + `taskId` sniff is not enough: every field the
 * UI renders (statuses, timestamps, the JSON-RPC error object, the keyed
 * `inputRequests` map) is validated at the wire boundary here. Zod is already
 * an SDK dependency and is browser-safe, unlike the Ajv-backed dialect-aware
 * validator; the full conformance product lives in the tasks conformance
 * suite.
 *
 * Unknown keys are PASSED THROUGH (`.passthrough()` semantics): a debugger
 * must show whatever the server actually sent, and the extension is a draft
 * that may grow fields.
 */

import { z } from "zod";

export const taskExtStatusSchema = z.enum([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);

export const taskExtErrorSchema = z
  .object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
  })
  .loose();

export const taskExtSchema = z
  .object({
    taskId: z.string().min(1),
    status: taskExtStatusSchema,
    statusMessage: z.string().optional(),
    createdAt: z.string(),
    lastUpdatedAt: z.string(),
    // `null` means "no expiry" and is distinct from an absent field.
    ttlMs: z.number().nullable(),
    pollIntervalMs: z.number().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

/**
 * `inputRequests` is a keyed snapshot map re-sent on every poll. The values
 * are the same `InputRequest` objects the MRTR driver already handles, so they
 * are validated only as method-bearing objects here — the driver owns the
 * per-method (Decision-8) checks.
 */
export const inputRequestsSchema = z.record(
  z.string(),
  z.object({ method: z.string() }).loose()
);

export const detailedTaskExtSchema = taskExtSchema.extend({
  result: z.unknown().optional(),
  error: taskExtErrorSchema.optional(),
  inputRequests: inputRequestsSchema.optional(),
});

/** Flat `CreateTaskResult` (`resultType: "task"`). */
export const createTaskExtResultSchema = taskExtSchema.extend({
  resultType: z.literal("task"),
});

export const getTaskExtResultSchema = detailedTaskExtSchema;

/**
 * `notifications/tasks` params. SEP-2663 delivers a full `DetailedTask`, so the
 * notification body validates against the same schema as `tasks/get`.
 */
export const taskExtNotificationParamsSchema = detailedTaskExtSchema;
