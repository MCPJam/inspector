/**
 * `classifyFrame`: one JSON-RPC frame → the observable catalog feature ids it
 * shows (engineering spec v0.4, "3. Observed").
 *
 * Pure and browser-safe. It reads method names, result and error shapes,
 * content block types and a few closed-enum fields, and returns ids only:
 * no payload content, URI, name or message ever leaves this module. A
 * response does not carry its request's method, so the caller passes the
 * request facts it kept (`FrameRequestContext`, from `requestContextOf`).
 *
 * MCPJam never advertises sampling or roots, so a server request for either
 * means the server asked and MCPJam declined; the observation still shows the
 * server uses the feature.
 */

import { SERVER_FEATURE_CATALOG } from "./catalog/index.js";

export type FrameDirection = "client-to-server" | "server-to-client";
export type FrameEra = "legacy" | "modern" | "unknown";

/** Closed facts about the request a response or cancellation refers to. */
export interface FrameRequestContext {
  method: string;
  completionRef?: "prompt" | "resource";
}

/** Every id the classifiers may emit, derived from the catalog. */
export const OBSERVABLE_FEATURE_IDS: ReadonlySet<string> = new Set(
  SERVER_FEATURE_CATALOG.filter((entry) => entry.assessment.observable).map(
    (entry) => entry.id
  )
);

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, key: string): Rec | undefined {
  if (!isRecord(value)) return undefined;
  const entry = value[key];
  return isRecord(entry) ? entry : undefined;
}

function hasMeta(value: unknown, key: string): boolean {
  const meta = recordAt(value, "_meta");
  return meta !== undefined && meta[key] !== undefined;
}

const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
const SUBSCRIPTION_ID_META = "io.modelcontextprotocol/subscriptionId";
const RELATED_TASK_META = "io.modelcontextprotocol/related-task";
const OPENAI_FORM_META = "openai/elicitation";
const OPENAI_FORM_METHOD = "openai/elicitation/create";

const MISSING_CLIENT_CAPABILITY = -32021;
const URL_ELICITATION_REQUIRED = -32042;

/** MCPJam's pinned draft profile and the current provisional sketch. */
function isEventsErrorCode(code: unknown): boolean {
  return (
    typeof code === "number" &&
    ((code >= -32015 && code <= -32011) || (code >= -32027 && code <= -32023))
  );
}

/** Requests a server makes of the client, directly or through MRTR. */
const CLIENT_INPUT_METHODS = new Set([
  "elicitation/create",
  "sampling/createMessage",
  "roots/list",
]);

const LIST_METHODS = new Set([
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
]);

const LIST_CHANGED: ReadonlyMap<string, string> = new Map([
  ["notifications/tools/list_changed", "tools.list-changed"],
  ["notifications/resources/list_changed", "resources.list-changed"],
  ["notifications/prompts/list_changed", "prompts.list-changed"],
]);

const CONTENT_TYPES: ReadonlyMap<unknown, string> = new Map([
  ["text", "tool-results.text"],
  ["image", "tool-results.image"],
  ["audio", "tool-results.audio"],
  ["resource_link", "tool-results.resource-link"],
  ["resource", "tool-results.embedded-resource"],
]);

/** 2025-11-25 Tasks utility and 2026-07-28 Tasks extension, by method. */
const LEGACY_TASK_RESULTS: ReadonlyMap<string, string> = new Map([
  ["tasks/get", "tasks.core.get"],
  ["tasks/result", "tasks.core.result"],
  ["tasks/list", "tasks.core.list"],
  ["tasks/cancel", "tasks.core.cancel"],
]);
const MODERN_TASK_RESULTS: ReadonlyMap<string, string> = new Map([
  ["tasks/get", "tasks.ext.polling"],
  ["tasks/update", "tasks.ext.update"],
  ["tasks/cancel", "tasks.ext.cancel"],
]);

/** Request facts worth keeping until the response arrives; never payload. */
export function requestContextOf(
  message: unknown
): FrameRequestContext | undefined {
  if (!isRecord(message) || typeof message.method !== "string")
    return undefined;
  const context: FrameRequestContext = { method: message.method };
  if (message.method === "completion/complete") {
    const type = recordAt(message.params, "ref")?.type;
    if (type === "ref/prompt") context.completionRef = "prompt";
    if (type === "ref/resource") context.completionRef = "resource";
  }
  return context;
}

function hasSchemaChoices(schema: unknown): boolean {
  const properties = recordAt(schema, "properties");
  if (!properties) return false;
  return Object.values(properties).some((field) => {
    if (!isRecord(field)) return false;
    if (
      field.enum !== undefined ||
      field.oneOf !== undefined ||
      field.anyOf !== undefined ||
      field.default !== undefined
    )
      return true;
    const items = recordAt(field, "items");
    return items?.enum !== undefined || items?.anyOf !== undefined;
  });
}

/** A server's request to the client, sent directly or inside MRTR. */
function classifyServerRequest(
  method: string,
  params: unknown,
  out: Set<string>
) {
  if (hasMeta(params, OPENAI_FORM_META) || method === OPENAI_FORM_METHOD)
    out.add("openai.elicitation");
  if (method === "roots/list") out.add("client.roots");
  if (method === "sampling/createMessage") {
    out.add("client.sampling");
    if (isRecord(params)) {
      if (Array.isArray(params.tools) || params.toolChoice !== undefined)
        out.add("client.sampling-tools");
      if (
        params.includeContext === "thisServer" ||
        params.includeContext === "allServers"
      )
        out.add("client.include-context");
    }
  }
  if (method === "elicitation/create") {
    const mode = isRecord(params) ? params.mode : undefined;
    if (mode === "url") out.add("client.elicitation-url");
    else out.add("client.elicitation-form");
    if (hasSchemaChoices(recordAt(params, "requestedSchema")))
      out.add("client.elicitation-schemas");
  }
}

function inputRequestEntries(result: Rec): Rec[] {
  const requests = result.inputRequests;
  const values = Array.isArray(requests)
    ? requests
    : isRecord(requests)
      ? Object.values(requests)
      : [];
  return values.filter(isRecord);
}

function classifyInputRequired(
  result: Rec,
  request: FrameRequestContext | undefined,
  out: Set<string>
) {
  out.add("mrtr.input-required");
  if (request?.method === "resources/read")
    out.add("resources.read-input-required");
  if (result.ttlMs === undefined && result.cacheScope === undefined)
    out.add("caching.no-hints-on-input-required");
  const entries = inputRequestEntries(result);
  const hasState = typeof result.requestState === "string";
  if (hasState && entries.length > 0) out.add("mrtr.request-state");
  if (hasState && entries.length === 0) out.add("mrtr.load-shedding");
  for (const entry of entries) {
    if (typeof entry.method !== "string") continue;
    if (CLIENT_INPUT_METHODS.has(entry.method))
      out.add("mrtr.input-request-types");
    if (recordAt(entry.params, "_meta")) out.add("mrtr.input-meta");
    classifyServerRequest(entry.method, entry.params, out);
  }
}

function classifyToolResult(result: Rec, out: Set<string>) {
  if (Array.isArray(result.content)) {
    out.add("tool-results.content");
    for (const block of result.content) {
      if (!isRecord(block)) continue;
      const id = CONTENT_TYPES.get(block.type);
      if (id) out.add(id);
      if (isRecord(block.annotations))
        out.add("tool-results.content-annotations");
    }
  }
  if (result.structuredContent !== undefined)
    out.add("tool-results.structured-content");
  if (result.isError === true) out.add("tool-results.is-error");
  const meta = recordAt(result, "_meta");
  if (meta && Object.keys(meta).some((key) => key !== SERVER_INFO_META))
    out.add("tool-results.result-meta");
}

function classifyTaskResult(
  method: string,
  result: Rec,
  era: FrameEra,
  out: Set<string>
) {
  const id =
    era === "legacy"
      ? LEGACY_TASK_RESULTS.get(method)
      : era === "modern"
        ? MODERN_TASK_RESULTS.get(method)
        : undefined;
  if (id) out.add(id);
  if (
    era === "legacy" &&
    method === "tasks/get" &&
    result.status === "input_required"
  )
    out.add("tasks.core.input-required");
}

/** A successful response, by the method of the request it answers. */
function classifyResult(
  result: Rec,
  request: FrameRequestContext | undefined,
  era: FrameEra,
  out: Set<string>
) {
  if (hasMeta(result, SERVER_INFO_META))
    out.add("server-info.result-server-info");
  if (typeof result.resultType === "string")
    out.add("tool-results.result-type");
  if (result.resultType === "task") out.add("tasks.ext.create-task-result");
  if (result.resultType === "input_required") {
    classifyInputRequired(result, request, out);
    if (request?.method === "prompts/get") out.add("prompts.get");
    return;
  }
  const method = request?.method;
  if (!method) return;
  if (typeof result.truncated === "boolean" && method.startsWith("events/"))
    out.add("events.cursor-replay");
  if (method.startsWith("tasks/")) classifyTaskResult(method, result, era, out);
  switch (method) {
    case "tools/call":
      if (
        era !== "modern" &&
        typeof recordAt(result, "task")?.taskId === "string"
      )
        out.add("tasks.core.augmented-call");
      else if (result.resultType !== "task") classifyToolResult(result, out);
      return;
    case "resources/read":
      if (Array.isArray(result.contents)) out.add("resources.read");
      return;
    case "prompts/get":
      out.add("prompts.get");
      if (Array.isArray(result.messages) && result.messages.length > 0)
        out.add("prompts.message-content");
      return;
    case "completion/complete":
      if (!isRecord(result.completion)) return;
      if (request?.completionRef === "prompt") out.add("completion.prompt-ref");
      if (request?.completionRef === "resource")
        out.add("completion.resource-ref");
      return;
    case "resources/subscribe":
      out.add("subscriptions.resources-subscribe");
      out.add("subscriptions.legacy-subscribe");
      return;
    case "resources/unsubscribe":
      out.add("subscriptions.legacy-subscribe");
      return;
    case "subscriptions/listen":
      out.add("subscriptions.listen");
      out.add("subscriptions.stream-end");
      return;
    case "ping":
      out.add("request-control.ping");
      return;
    case "logging/setLevel":
      out.add("request-control.logging-set-level");
      return;
    case "skills/get":
      out.add("skills.get");
      return;
    case "events/poll":
      out.add("events.poll");
      return;
    case "events/stream":
      out.add("events.stream");
      return;
  }
  if (LIST_METHODS.has(method) && typeof result.nextCursor === "string")
    out.add("pagination.cursor");
}

function classifyError(
  error: Rec,
  request: FrameRequestContext | undefined,
  era: FrameEra,
  out: Set<string>
) {
  const code = error.code;
  if (code === MISSING_CLIENT_CAPABILITY && era !== "legacy") {
    out.add("lifecycle.missing-client-capability-error");
    if (request?.method.startsWith("tasks/"))
      out.add("tasks.ext.missing-capability-error");
  }
  if (code === URL_ELICITATION_REQUIRED && era !== "modern")
    out.add("client.url-elicitation-required-error");
  if (request?.method.startsWith("events/") && isEventsErrorCode(code))
    out.add("events.error-codes");
}

function classifyServerNotification(
  method: string,
  params: unknown,
  request: FrameRequestContext | undefined,
  era: FrameEra,
  out: Set<string>
) {
  const listChanged = LIST_CHANGED.get(method);
  if (listChanged) {
    out.add(listChanged);
    if (era === "modern") out.add("subscriptions.list-changed-on-stream");
    if (era === "legacy") out.add("subscriptions.legacy-delivery");
  }
  if (
    hasMeta(params, SUBSCRIPTION_ID_META) &&
    !method.startsWith("notifications/events/")
  )
    out.add("subscriptions.subscription-id");
  switch (method) {
    case "notifications/resources/updated":
      out.add("subscriptions.resource-updated");
      out.add("subscriptions.resources-subscribe");
      out.add("resource-templates.updated");
      if (era === "legacy") out.add("subscriptions.legacy-delivery");
      return;
    case "notifications/subscriptions/acknowledged":
      out.add("subscriptions.acknowledged");
      out.add("subscriptions.listen");
      return;
    case "notifications/progress":
      out.add("request-control.progress");
      return;
    case "notifications/cancelled":
      // On 2026-07-28 a server may send this only to end a
      // subscriptions/listen stream; earlier revisions let either side
      // cancel its own request.
      if (request?.method === "subscriptions/listen")
        out.add("subscriptions.stream-end");
      else if (era !== "modern") out.add("request-control.cancellation");
      return;
    case "notifications/message":
      out.add("request-control.log-messages");
      return;
    case "notifications/elicitation/complete":
      out.add("client.elicitation-complete");
      return;
    case "notifications/tasks/status":
      out.add("tasks.core.status-notification");
      if (isRecord(params) && params.status === "input_required")
        out.add("tasks.core.input-required");
      return;
    case "notifications/tasks":
      out.add("tasks.ext.notifications");
      return;
    case "notifications/events/list_changed":
      out.add("events.list-changed");
      return;
    case "notifications/events/event":
    case "notifications/events/heartbeat":
      out.add("events.stream");
      return;
    case "notifications/events/active":
      out.add("events.stream");
      if (isRecord(params) && typeof params.truncated === "boolean")
        out.add("events.cursor-replay");
      return;
    case "notifications/events/terminated":
      out.add("events.terminated");
      if (isEventsErrorCode(recordAt(params, "error")?.code))
        out.add("events.error-codes");
      return;
    case "notifications/events/error":
      if (isEventsErrorCode(recordAt(params, "error")?.code))
        out.add("events.error-codes");
      return;
  }
}

function classifyServerToClient(
  message: Rec,
  era: FrameEra,
  request: FrameRequestContext | undefined,
  out: Set<string>
) {
  const method = message.method;
  if (typeof method === "string") {
    if (message.id === undefined) {
      classifyServerNotification(method, message.params, request, era, out);
      return;
    }
    if (method === "ping") out.add("request-control.ping");
    classifyServerRequest(method, message.params, out);
    if (hasMeta(message.params, RELATED_TASK_META) && era !== "modern")
      out.add("tasks.core.input-required");
    if (era === "legacy" && CLIENT_INPUT_METHODS.has(method))
      out.add("transport-behavior.server-requests-on-sse");
    return;
  }
  if (isRecord(message.result))
    classifyResult(message.result, request, era, out);
  else if (isRecord(message.error))
    classifyError(message.error, request, era, out);
}

/**
 * Feature ids one frame shows. `request` is the context of the request this
 * frame answers or cancels, when the caller kept it. Only ids that are
 * observable in `SERVER_FEATURE_CATALOG` are returned.
 */
export function classifyFrame(
  direction: FrameDirection,
  message: unknown,
  era: FrameEra,
  request?: FrameRequestContext
): string[] {
  if (!isRecord(message)) return [];
  const out = new Set<string>();
  if (direction === "server-to-client") {
    classifyServerToClient(message, era, request, out);
  } else if (message.method === "notifications/roots/list_changed") {
    out.add("client.roots-list-changed");
  }
  return [...out].filter((id) => OBSERVABLE_FEATURE_IDS.has(id));
}
