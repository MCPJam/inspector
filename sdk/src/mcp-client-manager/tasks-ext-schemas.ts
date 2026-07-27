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
import type { InputRequests } from "./tasks-ext-types.js";

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
    // Plain strings on purpose. "ISO 8601" is a JSDoc comment in schema.ts;
    // `schema.json` carries ZERO `format: date-time` constraints, so adding
    // `.datetime()` here would reject servers the spec accepts.
    createdAt: z.string(),
    lastUpdatedAt: z.string(),
    // `null` means "no expiry" and is distinct from an absent field.
    // Deliberately NOT `.int()` / `.nonnegative()`: `schema.json` says plain
    // `"number"`, and both `ttlMs` and `pollIntervalMs` MAY change (including
    // shrink) over a task's lifetime (tasks.md:304, :340) — a changed value is
    // never an anomaly.
    ttlMs: z.number().nullable(),
    pollIntervalMs: z.number().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

/**
 * The three request methods `InputRequest` unions in `schema.ts:111-118`
 * (`CreateMessageRequest | ListRootsRequest | ElicitRequest`).
 *
 * They are a RECOGNITION list, not a validation list: `schema.json` renders
 * the union as `anyOf: [{}, {}, {}]` (fully unconstrained), and this is a
 * draft extension, so drift is expected. An unrecognized method therefore
 * never invalidates the payload — the entry is kept and callers mark it via
 * {@link isRecognizedInputRequestMethod}. Discarding the task (or the entry)
 * would hide work the user is waiting on; the MRTR driver's
 * "reject what this client cannot answer" rule (`mrtr-driver.ts:357`) is
 * deliberately NOT applied here, because a tasks input request must stay
 * VISIBLE-but-unanswerable rather than vanish.
 */
export const TASK_EXT_INPUT_REQUEST_METHODS = [
  "sampling/createMessage",
  "roots/list",
  "elicitation/create",
] as const;

export type TaskExtInputRequestMethod =
  (typeof TASK_EXT_INPUT_REQUEST_METHODS)[number];

export function isRecognizedInputRequestMethod(
  method: unknown
): method is TaskExtInputRequestMethod {
  return (
    typeof method === "string" &&
    (TASK_EXT_INPUT_REQUEST_METHODS as readonly string[]).includes(method)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Own, enumerable entries of an untrusted object — read through property
 * descriptors so a `__proto__` / `constructor` / `prototype` key is returned
 * as DATA rather than resolved through the prototype chain.
 */
function ownEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      continue;
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

/**
 * Copies the keyed map onto a NULL-PROTOTYPE object with `defineProperty`, the
 * same hostile-key defence `mrtr-driver.ts:271 toSafeMap` applies. Server-chosen
 * keys are arbitrary strings, so `__proto__` must land as an ordinary own
 * property (visible in the UI) and must not touch any prototype.
 */
function toSafeInputRequests(value: Record<string, unknown>): InputRequests {
  const safe = Object.create(null) as InputRequests;
  for (const [key, entry] of ownEntries(value)) {
    Object.defineProperty(safe, key, {
      value: entry,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return safe;
}

/**
 * `inputRequests` is a keyed snapshot map re-sent on every poll. Hand-rolled
 * rather than `z.record(...)` for two reasons: zod's record silently DROPS a
 * `__proto__` key (the entry would disappear from the debugger), and the
 * per-entry method check has to be non-fatal.
 */
export const inputRequestsSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (!isPlainRecord(value)) {
      ctx.addIssue({
        code: "custom",
        message: "expected an object of input requests",
      });
      return;
    }
    for (const [key, entry] of ownEntries(value)) {
      if (!isPlainRecord(entry)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "expected an input request object",
        });
        continue;
      }
      const method = Object.getOwnPropertyDescriptor(entry, "method")?.value;
      if (typeof method !== "string" || method.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: [key, "method"],
          message: "expected a non-empty string method",
        });
      }
      // An unrecognized method is intentionally NOT an issue — see the
      // TASK_EXT_INPUT_REQUEST_METHODS comment.
    }
  })
  .transform((value) => toSafeInputRequests(value as Record<string, unknown>));

/** A key/method/recognized view of an `inputRequests` map, for UI + logs. */
export function describeTaskExtInputRequests(
  requests: InputRequests | undefined
): Array<{ key: string; method: string; recognized: boolean }> {
  if (!requests) return [];
  return ownEntries(requests as unknown as Record<string, unknown>).map(
    ([key, entry]) => {
      const method = isPlainRecord(entry)
        ? Object.getOwnPropertyDescriptor(entry, "method")?.value
        : undefined;
      const methodText = typeof method === "string" ? method : "";
      return {
        key,
        method: methodText,
        recognized: isRecognizedInputRequestMethod(methodText),
      };
    }
  );
}

/*
 * The five status variants. `schema.json` renders `DetailedTask` as an `anyOf`
 * with per-variant `required`, and tasks.md:330-336 states each as a MUST:
 * `working` / `cancelled` carry no status payload, `input_required` REQUIRES
 * `inputRequests`, `completed` REQUIRES `result`, `failed` REQUIRES `error`
 * (`statusMessage` is only a SHOULD, so it stays optional everywhere).
 *
 * Unknown keys still pass through (`.loose()` is inherited from
 * `taskExtSchema`) even though the JSON Schema marks the variants
 * `additionalProperties: false` — a debugger must render what the server
 * actually sent, and this is also what lets the prose-only
 * `resultType: "complete"` key through. See `GetTaskExtResult` for that
 * schema-vs-prose conflict.
 */
export const workingTaskExtSchema = taskExtSchema.extend({
  status: z.literal("working"),
});

export const inputRequiredTaskExtSchema = taskExtSchema.extend({
  status: z.literal("input_required"),
  inputRequests: inputRequestsSchema,
});

export const completedTaskExtSchema = taskExtSchema.extend({
  status: z.literal("completed"),
  // `{ [key: string]: unknown }` in schema.ts — the original request's result.
  // A tool result with `isError: true` is a COMPLETED task, never a failed one
  // (tasks.md:837, :891-892); nothing here reclassifies it.
  result: z.record(z.string(), z.unknown()),
});

export const failedTaskExtSchema = taskExtSchema.extend({
  status: z.literal("failed"),
  // JSON-RPC error object. `schema.json` only says `"type": "object"` (that is
  // ts-to-zod's rendering of an index signature), but JSON-RPC itself requires
  // `code` + `message`, which is what every consumer renders.
  error: taskExtErrorSchema,
});

export const cancelledTaskExtSchema = taskExtSchema.extend({
  status: z.literal("cancelled"),
});

/** `DetailedTask` (schema.ts:217-222) — discriminated on `status`. */
export const detailedTaskExtSchema = z.discriminatedUnion("status", [
  workingTaskExtSchema,
  inputRequiredTaskExtSchema,
  completedTaskExtSchema,
  failedTaskExtSchema,
  cancelledTaskExtSchema,
]);

/**
 * Flat `CreateTaskResult` (`resultType: "task"`). `Result & Task` is NOT a
 * DetailedTask: it never carries a status payload, so the union above must not
 * be applied to it.
 */
export const createTaskExtResultSchema = taskExtSchema.extend({
  resultType: z.literal("task"),
});

export const getTaskExtResultSchema = detailedTaskExtSchema;

/**
 * `notifications/tasks` params. SEP-2663 delivers a full `DetailedTask`, so the
 * notification body validates against the same schema as `tasks/get`.
 */
export const taskExtNotificationParamsSchema = detailedTaskExtSchema;

/**
 * `UpdateTaskResult` / `CancelTaskResult` — both are a bare `Result`
 * (`{"type": "object", "additionalProperties": {}}`, no required fields). The
 * ack carries NO task state, so it is validated only as an object: a non-object
 * (array, string, `null`) is a wire violation, while any object — empty or not
 * — is accepted and passed through verbatim. Callers must re-poll `tasks/get`.
 */
export const taskExtAckSchema = z.object({}).loose();
