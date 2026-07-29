/**
 * `input_required` driver for the tasks extension.
 *
 * A task's input channel is **not** more trusted than a direct server→client
 * request. `inputRequests` can carry `elicitation/create`, `roots/list`, and
 * `sampling/createMessage` — the same three methods a server could have asked
 * for out of band — so each one is routed through the same policy, consent,
 * schema validation, and handler as its standalone counterpart. This module is
 * the seam that enforces that, so no surface can accidentally grant a task
 * channel privileges the standalone path would have refused.
 *
 * Two rules shape everything here:
 *
 * 1. **Declare only what you can fulfil.** A surface may declare the tasks
 *    extension only when it has a complete handler path for each standalone
 *    capability it declares. A request for a method the client did not declare
 *    is rejected with a typed error and surfaced as actionable — never hung on,
 *    and never quietly marked handled.
 * 2. **Answered means acknowledged.** A key is marked responded only after the
 *    `tasks/update` carrying it succeeds. Marking optimistically would silently
 *    discard a user's answer whenever the update failed.
 *
 * The keyed `inputRequests` map is a **snapshot re-sent on every poll**, and it
 * may grow between polls. Partial responses are legal: a caller answers what it
 * can, updates, and observes the next snapshot.
 */

import { specTypeSchemas } from "@modelcontextprotocol/client";
import type { InputRequests, InputResponses } from "./tasks-ext-types.js";
import type { ClientCapabilityOptions } from "./types.js";
import type { ElicitationContentValidator } from "./mrtr-driver.js";
import {
  SUPPORTED_ELICITATION_MODES,
  type ElicitationMode,
} from "./mrtr-driver.js";

/** The three request methods an `input_required` task may embed. */
export const TASK_INPUT_METHODS = [
  "elicitation/create",
  "roots/list",
  "sampling/createMessage",
] as const;

export type TaskInputMethod = (typeof TASK_INPUT_METHODS)[number];

export function isTaskInputMethod(method: unknown): method is TaskInputMethod {
  return (
    typeof method === "string" &&
    (TASK_INPUT_METHODS as readonly string[]).includes(method)
  );
}

/**
 * Why a key could not be answered. Every one of these is *displayable state*,
 * not a silent drop: an unanswerable key stays visible and stays unanswered.
 */
export type TaskInputRejectionReason =
  /** The client never declared the capability this request needs. */
  | "undeclared-capability"
  /** The method is not one of the extension's three. */
  | "unsupported-method"
  /** `elicitation/create` asked for a mode this client cannot render. */
  | "unsupported-elicitation-mode"
  /** No handler was wired for a capability the client did declare. */
  | "no-handler"
  /** A size/count limit rejected the request before it was rendered. */
  | "limit-exceeded"
  /** The handler threw. */
  | "handler-failed"
  /** The request's own shape was invalid. */
  | "malformed-request"
  /** The handler's response failed the method's canonical result schema. */
  | "malformed-response";

export class TaskInputRejectedError extends Error {
  readonly code = "TASK_INPUT_REJECTED";
  constructor(
    readonly reason: TaskInputRejectionReason,
    readonly inputKey: string,
    readonly method: string,
    message: string
  ) {
    super(message);
    this.name = "TaskInputRejectedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The canonical spec-type schemas for each embedded method — the SAME
 * validation the upstream client applies to a standalone server→client request
 * before any app handler runs (SEP-2663 tasks.md: task `inputRequests` route
 * through the standalone trust rules, not a laxer copy). A task channel must
 * not accept a request the direct channel would have refused, and must not
 * submit a response via `tasks/update` that the direct channel could not have
 * produced.
 */
type CanonicalIssues = ReadonlyArray<{
  readonly message?: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}>;

/**
 * The spec-type schemas are typed as Standard Schema (their zod identity is a
 * runtime detail), so validation goes through the `~standard` interface.
 */
interface CanonicalSchema {
  readonly "~standard": {
    validate(value: unknown): unknown;
  };
}

function validateCanonical(
  schema: CanonicalSchema,
  value: unknown
): { ok: true } | { ok: false; detail: string } {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    // Spec-type schemas validate synchronously today; an async one cannot be
    // awaited here, and unvalidated input must fail closed, not sail through.
    return { ok: false, detail: "schema validated asynchronously" };
  }
  const issues = (result as { issues?: CanonicalIssues }).issues;
  if (!issues || issues.length === 0) return { ok: true };
  const issue = issues[0];
  const path = issue?.path?.length
    ? ` at ${issue.path
        .map((segment) =>
          typeof segment === "object" && segment !== null && "key" in segment
            ? String(segment.key)
            : String(segment)
        )
        .join(".")}`
    : "";
  return { ok: false, detail: `${issue?.message ?? "invalid"}${path}` };
}

const TASK_INPUT_REQUEST_SCHEMAS: Record<TaskInputMethod, CanonicalSchema> = {
  "elicitation/create": specTypeSchemas.ElicitRequest,
  "roots/list": specTypeSchemas.ListRootsRequest,
  "sampling/createMessage": specTypeSchemas.CreateMessageRequest,
};

// Sampling accepts either result flavor: plain, or the tool-use variant the
// modern spec allows a sampling handler to produce.
const TASK_INPUT_RESPONSE_SCHEMAS: Record<
  TaskInputMethod,
  readonly CanonicalSchema[]
> = {
  "elicitation/create": [specTypeSchemas.ElicitResult],
  "roots/list": [specTypeSchemas.ListRootsResult],
  "sampling/createMessage": [
    specTypeSchemas.CreateMessageResult,
    specTypeSchemas.CreateMessageResultWithTools,
  ],
};

/** A key this driver could not answer, with the reason to show the user. */
export interface TaskInputRejection {
  inputKey: string;
  method: string;
  reason: TaskInputRejectionReason;
  message: string;
}

export interface TaskInputHandlerContext {
  readonly taskId: string;
  readonly serverId: string;
  readonly inputKey: string;
  readonly signal?: AbortSignal;
}

/**
 * Handlers for the three methods. Each must be the *same* handler the
 * standalone request path uses, so trust rules cannot diverge between the two
 * channels. An absent handler is a `no-handler` rejection, never a silent skip.
 */
export interface TaskInputHandlers {
  elicitation?: (
    params: Record<string, unknown>,
    ctx: TaskInputHandlerContext
  ) => Promise<Record<string, unknown>>;
  roots?: (
    params: Record<string, unknown>,
    ctx: TaskInputHandlerContext
  ) => Promise<Record<string, unknown>>;
  sampling?: (
    params: Record<string, unknown>,
    ctx: TaskInputHandlerContext
  ) => Promise<Record<string, unknown>>;
}

/**
 * Bounds applied *before* a request is rendered or forwarded. `inputRequests`
 * is attacker-influenced: it comes from the server verbatim.
 */
export interface TaskInputLimits {
  maxRequests?: number;
  maxKeyLength?: number;
  maxSerializedRequestBytes?: number;
  maxResponsesPerUpdate?: number;
}

export const DEFAULT_TASK_INPUT_LIMITS: Required<TaskInputLimits> = {
  maxRequests: 50,
  maxKeyLength: 512,
  maxSerializedRequestBytes: 256 * 1024,
  maxResponsesPerUpdate: 50,
};

export interface TaskInputDriverOptions {
  /** What this connection actually advertised. Governs which methods are legal. */
  declaredCapabilities: ClientCapabilityOptions | undefined;
  handlers: TaskInputHandlers;
  /**
   * Strict, dialect-aware validator for accepted elicitation content, matching
   * the standalone elicitation path. Absent means content is not self-validated
   * — acceptable only where the standalone path also does not validate.
   */
  validateElicitationContent?: ElicitationContentValidator;
  supportedElicitationModes?: readonly ElicitationMode[];
  limits?: TaskInputLimits;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Capabilities a connection declared, as booleans. Read from the exact object
 * handed to `new Client(...)` so this can never disagree with the wire.
 */
export interface DeclaredInputCapabilities {
  elicitation: boolean;
  roots: boolean;
  sampling: boolean;
}

export function readDeclaredInputCapabilities(
  capabilities: ClientCapabilityOptions | undefined
): DeclaredInputCapabilities {
  const caps = (capabilities ?? {}) as Record<string, unknown>;
  return {
    elicitation: isRecord(caps.elicitation),
    roots: isRecord(caps.roots),
    sampling: isRecord(caps.sampling),
  };
}

/**
 * Whether a surface may declare the tasks extension at all.
 *
 * The rule from the plan: a surface may declare the extension only when it has
 * a complete handler path for the standalone capabilities it declares. A
 * connection that advertises `sampling` but wires no sampling handler would
 * strand any task that asks for it, so declaring tasks there is a bug we can
 * detect statically.
 */
export function canDeclareTasksExtension(
  declaredCapabilities: ClientCapabilityOptions | undefined,
  handlers: TaskInputHandlers
): { ok: true } | { ok: false; missing: TaskInputMethod[] } {
  const declared = readDeclaredInputCapabilities(declaredCapabilities);
  const missing: TaskInputMethod[] = [];
  if (declared.elicitation && !handlers.elicitation) {
    missing.push("elicitation/create");
  }
  if (declared.roots && !handlers.roots) missing.push("roots/list");
  if (declared.sampling && !handlers.sampling) {
    missing.push("sampling/createMessage");
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/** One key's outcome. */
export type TaskInputKeyOutcome =
  | { inputKey: string; status: "answered"; response: Record<string, unknown> }
  | { inputKey: string; status: "rejected"; rejection: TaskInputRejection };

export interface CollectTaskInputResult {
  /** Responses ready to send in ONE `tasks/update`. May be partial. */
  responses: InputResponses;
  /** Keys answered this round, in the order they were collected. */
  answeredKeys: string[];
  /** Keys that could not be answered, each with a displayable reason. */
  rejections: TaskInputRejection[];
  /** Keys skipped because they were already answered in an earlier round. */
  alreadyAnsweredKeys: string[];
}

function utf8Length(value: string): number {
  // `TextEncoder` is available in every runtime this SDK targets (browser,
  // worker, node18+), and byte length is what a limit should measure.
  return new TextEncoder().encode(value).length;
}

function safeSerializedSize(value: unknown): number {
  try {
    return utf8Length(JSON.stringify(value) ?? "");
  } catch {
    // A cyclic or non-serializable request cannot be forwarded anyway; treat it
    // as over-limit rather than crashing the collector.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Own-property keys of the snapshot, in insertion order.
 *
 * `Object.keys` already skips the prototype chain, but the explicit
 * `hasOwnProperty` filter documents the intent and survives a future switch to
 * a different enumeration. A server key of `constructor` or `__proto__` is
 * data, not behavior.
 */
function ownKeys(inputRequests: InputRequests): string[] {
  return Object.keys(inputRequests).filter((key) =>
    Object.prototype.hasOwnProperty.call(inputRequests, key)
  );
}

/**
 * Routes one snapshot of `inputRequests` through the declared handlers.
 *
 * Answering is best-effort **per key**: one rejected key never blocks the
 * others, because a partial `tasks/update` is legal and making progress on the
 * answerable keys is strictly better than stalling the task. Every rejection is
 * returned rather than thrown, so the caller can render "3 answered, 1 needs
 * attention" instead of a dead end.
 */
export async function collectTaskInputResponses(args: {
  options: TaskInputDriverOptions;
  taskId: string;
  serverId: string;
  inputRequests: InputRequests;
  /** Keys already acknowledged by a previous `tasks/update` — never re-prompted. */
  respondedKeys?: ReadonlySet<string>;
  signal?: AbortSignal;
}): Promise<CollectTaskInputResult> {
  const { options, taskId, serverId, inputRequests, signal } = args;
  const respondedKeys = args.respondedKeys ?? new Set<string>();
  const limits = { ...DEFAULT_TASK_INPUT_LIMITS, ...(options.limits ?? {}) };
  const declared = readDeclaredInputCapabilities(options.declaredCapabilities);
  const modes =
    options.supportedElicitationModes ?? SUPPORTED_ELICITATION_MODES;

  // NULL-PROTOTYPE, and this is load-bearing rather than defensive styling.
  // On a plain object literal, `responses["__proto__"] = value` invokes the
  // inherited `__proto__` setter: it reassigns the object's prototype instead
  // of creating an own property. The key would still land in `answeredKeys`,
  // so the caller would mark it responded and never re-prompt, while the
  // `tasks/update` carried nothing for it — the user's answer silently lost.
  // A null prototype makes a hostile key ordinary data, which is what the
  // module comment claims.
  const responses: Record<string, unknown> = Object.create(null);
  const answeredKeys: string[] = [];
  const rejections: TaskInputRejection[] = [];
  const alreadyAnsweredKeys: string[] = [];

  const keys = ownKeys(inputRequests);
  const overflow = keys.slice(limits.maxRequests);
  for (const key of overflow) {
    rejections.push({
      inputKey: key.slice(0, limits.maxKeyLength),
      method: "unknown",
      reason: "limit-exceeded",
      message:
        `Task ${taskId} sent more than ${limits.maxRequests} input requests; ` +
        `this key was not processed.`,
    });
  }

  for (const key of keys.slice(0, limits.maxRequests)) {
    // An aborted caller gets a truncated collection, not a string of forced
    // failures: prompting the next key into a dead terminal would record a
    // `handler-failed` for every remaining request, and the driver reads those
    // rejections as "the task needs input this run could not answer" — the
    // wrong verdict when the truth is "the user hit Ctrl-C".
    if (signal?.aborted) break;
    if (respondedKeys.has(key)) {
      alreadyAnsweredKeys.push(key);
      continue;
    }
    if (key.length > limits.maxKeyLength) {
      rejections.push({
        inputKey: `${key.slice(0, 64)}…`,
        method: "unknown",
        reason: "limit-exceeded",
        message: `Input key exceeds ${limits.maxKeyLength} characters.`,
      });
      continue;
    }

    const request = inputRequests[key] as unknown;
    if (!isRecord(request)) {
      rejections.push({
        inputKey: key,
        method: "unknown",
        reason: "malformed-request",
        message: `Input request "${key}" is not an object.`,
      });
      continue;
    }
    if (safeSerializedSize(request) > limits.maxSerializedRequestBytes) {
      rejections.push({
        inputKey: key,
        method: String(request.method ?? "unknown"),
        reason: "limit-exceeded",
        message: `Input request "${key}" exceeds ${limits.maxSerializedRequestBytes} bytes.`,
      });
      continue;
    }

    const method = request.method;
    const params = isRecord(request.params) ? request.params : {};

    if (!isTaskInputMethod(method)) {
      rejections.push({
        inputKey: key,
        method: String(method ?? "unknown"),
        reason: "unsupported-method",
        message:
          `Task ${taskId} requested "${String(method)}" for key "${key}", ` +
          `which is not one of the extension's input methods.`,
      });
      continue;
    }

    const gate = resolveHandler(method, declared, options.handlers);
    if (!gate.ok) {
      rejections.push({
        inputKey: key,
        method,
        reason: gate.reason,
        message: gate.message,
      });
      continue;
    }

    // Canonical shape, judged against the FULL request (`params` presence
    // rules differ per method: `roots/list` may omit them, `elicitation/create`
    // may not) — the SAME schema the upstream client applies before a
    // standalone handler runs. The raw `request.params` is validated rather
    // than the `{}`-defaulted copy, so an absent params object is judged as
    // absent. After the declaration gate deliberately: "you never declared
    // this capability" is the more actionable verdict for a request that is
    // both undeclared and malformed.
    const canonical = validateCanonical(TASK_INPUT_REQUEST_SCHEMAS[method], {
      method,
      params: request.params,
    });
    if (!canonical.ok) {
      rejections.push({
        inputKey: key,
        method,
        reason: "malformed-request",
        message:
          `Input request "${key}" is not a valid ${method} request: ` +
          canonical.detail,
      });
      continue;
    }

    if (method === "elicitation/create") {
      const mode = (params.mode as string | undefined) ?? "form";
      if (!modes.includes(mode as ElicitationMode)) {
        rejections.push({
          inputKey: key,
          method,
          reason: "unsupported-elicitation-mode",
          message:
            `Elicitation for key "${key}" requested mode "${mode}" ` +
            `(supported: ${modes.join(", ")}).`,
        });
        continue;
      }
    }

    let response: Record<string, unknown>;
    try {
      response = await gate.handler(params, {
        taskId,
        serverId,
        inputKey: key,
        signal,
      });
    } catch (error) {
      // A handler torn down by the caller's abort is not a failed handler.
      // The prompt's readline rejects when the signal fires, and recording
      // that as `handler-failed` is what made a Ctrl-C mid-prompt settle as
      // `input-required` instead of `aborted` upstream.
      if (signal?.aborted) break;
      rejections.push({
        inputKey: key,
        method,
        reason: "handler-failed",
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    {
      // The response must be one the standalone channel could have produced:
      // an `{action:"bogus"}` elicitation answer or a sampling result with no
      // `model` is refused here, not submitted via `tasks/update`.
      const shapes = TASK_INPUT_RESPONSE_SCHEMAS[method];
      const outcomes = shapes.map((shape) => validateCanonical(shape, response));
      if (!outcomes.some((outcome) => outcome.ok)) {
        const first = outcomes[0];
        rejections.push({
          inputKey: key,
          method,
          reason: "malformed-response",
          message:
            `Handler response for "${key}" is not a valid ${method} result: ` +
            (first && !first.ok ? first.detail : "invalid"),
        });
        continue;
      }
    }

    if (method === "elicitation/create") {
      const problem = validateElicitationResponse(
        key,
        params,
        response,
        options.validateElicitationContent
      );
      if (problem) {
        rejections.push(problem);
        continue;
      }
    }

    responses[key] = response;
    answeredKeys.push(key);
    if (answeredKeys.length >= limits.maxResponsesPerUpdate) {
      // Remaining keys stay pending and are answered on a later round — the
      // snapshot is re-sent, so nothing is lost by stopping here.
      break;
    }
  }

  return {
    responses: responses as InputResponses,
    answeredKeys,
    rejections,
    alreadyAnsweredKeys,
  };
}

type HandlerGate =
  | {
      ok: true;
      handler: NonNullable<TaskInputHandlers["elicitation"]>;
    }
  | { ok: false; reason: TaskInputRejectionReason; message: string };

/**
 * Two distinct failures, deliberately kept apart:
 *
 *  - `undeclared-capability` — the server asked for something we never
 *    advertised. That is a *server* protocol violation, and saying so is what
 *    makes the message actionable.
 *  - `no-handler` — we advertised it and then failed to wire it. That is our
 *    bug, and it should read like one.
 */
function resolveHandler(
  method: TaskInputMethod,
  declared: DeclaredInputCapabilities,
  handlers: TaskInputHandlers
): HandlerGate {
  const table: Record<
    TaskInputMethod,
    {
      declared: boolean;
      handler?: TaskInputHandlers["elicitation"];
      capability: string;
    }
  > = {
    "elicitation/create": {
      declared: declared.elicitation,
      handler: handlers.elicitation,
      capability: "elicitation",
    },
    "roots/list": {
      declared: declared.roots,
      handler: handlers.roots,
      capability: "roots",
    },
    "sampling/createMessage": {
      declared: declared.sampling,
      handler: handlers.sampling,
      capability: "sampling",
    },
  };
  const entry = table[method];
  if (!entry.declared) {
    return {
      ok: false,
      reason: "undeclared-capability",
      message:
        `Server requested "${method}" but this connection never declared the ` +
        `"${entry.capability}" capability, so it cannot be fulfilled.`,
    };
  }
  if (!entry.handler) {
    return {
      ok: false,
      reason: "no-handler",
      message:
        `This surface declared "${entry.capability}" but wired no handler for ` +
        `"${method}".`,
    };
  }
  return { ok: true, handler: entry.handler };
}

/**
 * Self-validates an accepted elicitation response against its own
 * `requestedSchema`, exactly as the standalone elicitation path does. Decline
 * and cancel carry no content and are responses, not errors.
 */
function validateElicitationResponse(
  key: string,
  params: Record<string, unknown>,
  response: Record<string, unknown>,
  validateContent?: ElicitationContentValidator
): TaskInputRejection | undefined {
  const action = response.action;
  if (action !== "accept") return undefined;
  const requestedSchema = params.requestedSchema;
  if (requestedSchema === undefined || !validateContent) return undefined;
  const result = validateContent(requestedSchema, response.content ?? {});
  if (result.valid) return undefined;
  return {
    inputKey: key,
    method: "elicitation/create",
    reason: "malformed-request",
    message:
      `Accepted elicitation content for "${key}" failed schema validation: ` +
      `${result.error ?? "invalid"}`,
  };
}
