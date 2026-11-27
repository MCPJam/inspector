/**
 * One JSON-RPC frame per observable behavior, with the exact ids
 * `classifyFrame` must emit for it. The coverage test unions `expect` across
 * every fixture, so each observable id that traffic can show appears here.
 */

import type {
  FrameDirection,
  FrameEra,
  FrameRequestContext,
} from "../classify-frame.js";

export interface FrameFixture {
  name: string;
  direction: FrameDirection;
  era: FrameEra;
  message: unknown;
  request?: FrameRequestContext;
  expect: readonly string[];
}

const S2C: FrameDirection = "server-to-client";

function result(value: Record<string, unknown>) {
  return { jsonrpc: "2.0", id: 7, result: value };
}

function error(code: number) {
  return { jsonrpc: "2.0", id: 7, error: { code, message: "Refused" } };
}

function request(method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id: 3, method, params };
}

function notification(method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", method, params };
}

function answering(method: string, extra: Partial<FrameRequestContext> = {}) {
  return { method, ...extra };
}

const SUBSCRIPTION_META = {
  _meta: { "io.modelcontextprotocol/subscriptionId": "sub-1" },
};

export const FRAME_FIXTURES: readonly FrameFixture[] = [
  {
    name: "tool result with every content type",
    direction: S2C,
    era: "legacy",
    request: answering("tools/call"),
    message: result({
      content: [
        { type: "text", text: "secret text", annotations: { priority: 1 } },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "audio", data: "aGk=", mimeType: "audio/wav" },
        { type: "resource_link", uri: "file:///private", name: "private" },
        { type: "resource", resource: { uri: "file:///x", text: "body" } },
      ],
      structuredContent: { answer: 42 },
      isError: true,
      _meta: { "vendor/trace": "t-1" },
    }),
    expect: [
      "tool-results.content",
      "tool-results.text",
      "tool-results.image",
      "tool-results.audio",
      "tool-results.resource-link",
      "tool-results.embedded-resource",
      "tool-results.content-annotations",
      "tool-results.structured-content",
      "tool-results.is-error",
      "tool-results.result-meta",
    ],
  },
  {
    name: "2026 complete result naming its server",
    direction: S2C,
    era: "modern",
    request: answering("tools/call"),
    message: result({
      resultType: "complete",
      content: [],
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "srv" } },
    }),
    expect: [
      "server-info.result-server-info",
      "tool-results.result-type",
      "tool-results.content",
    ],
  },
  {
    name: "input_required with every input request type",
    direction: S2C,
    era: "modern",
    request: answering("tools/call"),
    message: result({
      resultType: "input_required",
      requestState: "opaque",
      inputRequests: {
        form: {
          method: "elicitation/create",
          params: {
            message: "Pick one",
            requestedSchema: {
              type: "object",
              properties: { size: { type: "string", enum: ["s", "m"] } },
            },
            _meta: { "openai/elicitation": { requestedSchema: {} } },
          },
        },
        model: {
          method: "sampling/createMessage",
          params: { messages: [], tools: [], includeContext: "thisServer" },
        },
        workspace: { method: "roots/list", params: {} },
      },
    }),
    expect: [
      "tool-results.result-type",
      "mrtr.input-required",
      "caching.no-hints-on-input-required",
      "mrtr.request-state",
      "mrtr.input-request-types",
      "mrtr.input-meta",
      "openai.elicitation",
      "client.elicitation-form",
      "client.elicitation-schemas",
      "client.sampling",
      "client.sampling-tools",
      "client.include-context",
      "client.roots",
    ],
  },
  {
    name: "resources/read sheds load with requestState only",
    direction: S2C,
    era: "modern",
    request: answering("resources/read"),
    message: result({
      resultType: "input_required",
      requestState: "retry-later",
      ttlMs: 0,
    }),
    expect: [
      "tool-results.result-type",
      "mrtr.input-required",
      "resources.read-input-required",
      "mrtr.load-shedding",
    ],
  },
  {
    name: "prompts/get pauses for input",
    direction: S2C,
    era: "modern",
    request: answering("prompts/get"),
    message: result({ resultType: "input_required", inputRequests: {} }),
    expect: [
      "tool-results.result-type",
      "mrtr.input-required",
      "caching.no-hints-on-input-required",
      "prompts.get",
    ],
  },
  {
    name: "resources/read contents",
    direction: S2C,
    era: "legacy",
    request: answering("resources/read"),
    message: result({ contents: [{ uri: "file:///x", text: "body" }] }),
    expect: ["resources.read"],
  },
  {
    name: "prompts/get messages",
    direction: S2C,
    era: "legacy",
    request: answering("prompts/get"),
    message: result({
      messages: [{ role: "user", content: { type: "text", text: "hi" } }],
    }),
    expect: ["prompts.get", "prompts.message-content"],
  },
  {
    name: "prompt argument completion",
    direction: S2C,
    era: "legacy",
    request: answering("completion/complete", { completionRef: "prompt" }),
    message: result({ completion: { values: ["a"] } }),
    expect: ["completion.prompt-ref"],
  },
  {
    name: "template argument completion",
    direction: S2C,
    era: "legacy",
    request: answering("completion/complete", { completionRef: "resource" }),
    message: result({ completion: { values: ["a"] } }),
    expect: ["completion.resource-ref"],
  },
  {
    name: "paged tools/list",
    direction: S2C,
    era: "legacy",
    request: answering("tools/list"),
    message: result({ tools: [], nextCursor: "page-2" }),
    expect: ["pagination.cursor"],
  },
  {
    name: "resources/subscribe",
    direction: S2C,
    era: "legacy",
    request: answering("resources/subscribe"),
    message: result({}),
    expect: [
      "subscriptions.resources-subscribe",
      "subscriptions.legacy-subscribe",
    ],
  },
  {
    name: "resources/unsubscribe",
    direction: S2C,
    era: "legacy",
    request: answering("resources/unsubscribe"),
    message: result({}),
    expect: ["subscriptions.legacy-subscribe"],
  },
  {
    name: "subscriptions/listen ends",
    direction: S2C,
    era: "modern",
    request: answering("subscriptions/listen"),
    message: result({}),
    expect: ["subscriptions.listen", "subscriptions.stream-end"],
  },
  {
    name: "subscription acknowledged",
    direction: S2C,
    era: "modern",
    message: notification("notifications/subscriptions/acknowledged", {
      ...SUBSCRIPTION_META,
    }),
    expect: [
      "subscriptions.subscription-id",
      "subscriptions.acknowledged",
      "subscriptions.listen",
    ],
  },
  {
    name: "tools list_changed on a listen stream",
    direction: S2C,
    era: "modern",
    message: notification("notifications/tools/list_changed", {
      ...SUBSCRIPTION_META,
    }),
    expect: [
      "tools.list-changed",
      "subscriptions.list-changed-on-stream",
      "subscriptions.subscription-id",
    ],
  },
  {
    name: "resources list_changed on 2025",
    direction: S2C,
    era: "legacy",
    message: notification("notifications/resources/list_changed"),
    expect: ["resources.list-changed", "subscriptions.legacy-delivery"],
  },
  {
    name: "prompts list_changed on 2025",
    direction: S2C,
    era: "legacy",
    message: notification("notifications/prompts/list_changed"),
    expect: ["prompts.list-changed", "subscriptions.legacy-delivery"],
  },
  {
    name: "resource updated",
    direction: S2C,
    era: "modern",
    message: notification("notifications/resources/updated", {
      uri: "file:///private",
    }),
    expect: [
      "subscriptions.resource-updated",
      "subscriptions.resources-subscribe",
      "resource-templates.updated",
    ],
  },
  {
    // The only cancellation 2026-07-28 lets a server send; it ends the
    // stream and says nothing about cancelling a request.
    name: "server ends a listen stream on stdio",
    direction: S2C,
    era: "modern",
    request: answering("subscriptions/listen"),
    message: notification("notifications/cancelled", { requestId: 3 }),
    expect: ["subscriptions.stream-end"],
  },
  {
    name: "server cancels its own request on a legacy revision",
    direction: S2C,
    era: "legacy",
    request: answering("sampling/createMessage"),
    message: notification("notifications/cancelled", { requestId: 3 }),
    expect: ["request-control.cancellation"],
  },
  {
    // 2026-07-28 forbids this, so it is not evidence of cancellation.
    name: "server cancels a request on 2026-07-28",
    direction: S2C,
    era: "modern",
    request: answering("tools/call"),
    message: notification("notifications/cancelled", { requestId: 3 }),
    expect: [],
  },
  {
    name: "progress",
    direction: S2C,
    era: "legacy",
    message: notification("notifications/progress", {
      progressToken: 1,
      progress: 1,
    }),
    expect: ["request-control.progress"],
  },
  {
    name: "log message",
    direction: S2C,
    era: "legacy",
    message: notification("notifications/message", {
      level: "info",
      data: "private",
    }),
    expect: ["request-control.log-messages"],
  },
  {
    name: "ping answered",
    direction: S2C,
    era: "legacy",
    request: answering("ping"),
    message: result({}),
    expect: ["request-control.ping"],
  },
  {
    name: "server pings the client",
    direction: S2C,
    era: "legacy",
    message: request("ping"),
    expect: ["request-control.ping"],
  },
  {
    name: "logging/setLevel answered",
    direction: S2C,
    era: "legacy",
    request: answering("logging/setLevel"),
    message: result({}),
    expect: ["request-control.logging-set-level"],
  },
  {
    name: "sampling request with includeContext",
    direction: S2C,
    era: "legacy",
    message: request("sampling/createMessage", {
      messages: [],
      includeContext: "allServers",
    }),
    expect: [
      "client.sampling",
      "client.include-context",
      "transport-behavior.server-requests-on-sse",
    ],
  },
  {
    name: "URL elicitation inside a task",
    direction: S2C,
    era: "legacy",
    message: request("elicitation/create", {
      mode: "url",
      url: "https://example.test/private",
      _meta: { "io.modelcontextprotocol/related-task": { taskId: "t1" } },
    }),
    expect: [
      "client.elicitation-url",
      "tasks.core.input-required",
      "transport-behavior.server-requests-on-sse",
    ],
  },
  {
    name: "roots request",
    direction: S2C,
    era: "legacy",
    message: request("roots/list"),
    expect: ["client.roots", "transport-behavior.server-requests-on-sse"],
  },
  {
    name: "OpenAI form before 2026-07-28",
    direction: S2C,
    era: "legacy",
    message: request("openai/elicitation/create", {
      message: "Upload",
      requestedSchema: {},
    }),
    expect: ["openai.elicitation"],
  },
  {
    name: "URL elicitation required error",
    direction: S2C,
    era: "legacy",
    request: answering("tools/call"),
    message: error(-32042),
    expect: ["client.url-elicitation-required-error"],
  },
  {
    name: "elicitation complete",
    direction: S2C,
    era: "legacy",
    message: notification("notifications/elicitation/complete", {
      elicitationId: "e1",
    }),
    expect: ["client.elicitation-complete"],
  },
  {
    name: "client roots changed",
    direction: "client-to-server",
    era: "legacy",
    message: notification("notifications/roots/list_changed"),
    expect: ["client.roots-list-changed"],
  },
  {
    name: "missing client capability on a task request",
    direction: S2C,
    era: "modern",
    request: answering("tasks/get"),
    message: error(-32021),
    expect: [
      "lifecycle.missing-client-capability-error",
      "tasks.ext.missing-capability-error",
    ],
  },
  {
    name: "2025 task-augmented call",
    direction: S2C,
    era: "legacy",
    request: answering("tools/call"),
    message: result({ task: { taskId: "t1", status: "working" } }),
    expect: ["tasks.core.augmented-call"],
  },
  {
    name: "2025 tasks/get waiting for input",
    direction: S2C,
    era: "legacy",
    request: answering("tasks/get"),
    message: result({ taskId: "t1", status: "input_required" }),
    expect: ["tasks.core.get", "tasks.core.input-required"],
  },
  {
    name: "2025 tasks/result",
    direction: S2C,
    era: "legacy",
    request: answering("tasks/result"),
    message: result({ content: [] }),
    expect: ["tasks.core.result"],
  },
  {
    name: "2025 tasks/list",
    direction: S2C,
    era: "legacy",
    request: answering("tasks/list"),
    message: result({ tasks: [] }),
    expect: ["tasks.core.list"],
  },
  {
    name: "2025 tasks/cancel",
    direction: S2C,
    era: "legacy",
    request: answering("tasks/cancel"),
    message: result({ taskId: "t1", status: "cancelled" }),
    expect: ["tasks.core.cancel"],
  },
  {
    name: "2025 task status notification",
    direction: S2C,
    era: "legacy",
    message: notification("notifications/tasks/status", {
      taskId: "t1",
      status: "working",
    }),
    expect: ["tasks.core.status-notification"],
  },
  {
    name: "2026 CreateTaskResult",
    direction: S2C,
    era: "modern",
    request: answering("tools/call"),
    message: result({ resultType: "task", taskId: "t1", status: "working" }),
    expect: ["tool-results.result-type", "tasks.ext.create-task-result"],
  },
  {
    name: "2026 tasks/get polling",
    direction: S2C,
    era: "modern",
    request: answering("tasks/get"),
    message: result({ taskId: "t1", status: "working", pollIntervalMs: 500 }),
    expect: ["tasks.ext.polling"],
  },
  {
    name: "2026 tasks/update",
    direction: S2C,
    era: "modern",
    request: answering("tasks/update"),
    message: result({}),
    expect: ["tasks.ext.update"],
  },
  {
    name: "2026 tasks/cancel",
    direction: S2C,
    era: "modern",
    request: answering("tasks/cancel"),
    message: result({}),
    expect: ["tasks.ext.cancel"],
  },
  {
    name: "2026 task notification",
    direction: S2C,
    era: "modern",
    message: notification("notifications/tasks", { taskId: "t1" }),
    expect: ["tasks.ext.notifications"],
  },
  {
    name: "skills/get",
    direction: S2C,
    era: "legacy",
    request: answering("skills/get"),
    message: result({ skill: { uri: "skill://private" } }),
    expect: ["skills.get"],
  },
  {
    name: "events list changed",
    direction: S2C,
    era: "legacy",
    message: notification("notifications/events/list_changed"),
    expect: ["events.list-changed"],
  },
  {
    name: "events/poll with truncation",
    direction: S2C,
    era: "legacy",
    request: answering("events/poll"),
    message: result({ events: [], cursor: "c2", truncated: true }),
    expect: ["events.poll", "events.cursor-replay"],
  },
  {
    name: "events/stream answered",
    direction: S2C,
    era: "legacy",
    request: answering("events/stream"),
    message: result({}),
    expect: ["events.stream"],
  },
  {
    name: "pushed event",
    direction: S2C,
    era: "legacy",
    message: notification("notifications/events/event", {
      name: "private.event",
      ...SUBSCRIPTION_META,
    }),
    expect: ["events.stream"],
  },
  {
    name: "stream active after replay",
    direction: S2C,
    era: "legacy",
    message: notification("notifications/events/active", {
      cursor: null,
      truncated: false,
      ...SUBSCRIPTION_META,
    }),
    expect: ["events.stream", "events.cursor-replay"],
  },
  {
    name: "stream terminated with an events code",
    direction: S2C,
    era: "legacy",
    message: notification("notifications/events/terminated", {
      error: { code: -32012, message: "private" },
    }),
    expect: ["events.terminated", "events.error-codes"],
  },
  {
    name: "events/subscribe refused with a provisional code",
    direction: S2C,
    era: "legacy",
    request: answering("events/subscribe"),
    message: error(-32024),
    expect: ["events.error-codes"],
  },
];

/** Frames that show nothing: requests MCPJam sends, unknown shapes. */
export const SILENT_FRAMES: readonly Omit<FrameFixture, "expect">[] = [
  {
    name: "MCPJam's own tools/call",
    direction: "client-to-server",
    era: "legacy",
    message: request("tools/call", { name: "private", arguments: {} }),
  },
  {
    name: "-32021 on a 2025 connection",
    direction: S2C,
    era: "legacy",
    request: answering("tools/call"),
    message: error(-32021),
  },
  {
    name: "response without its request",
    direction: S2C,
    era: "legacy",
    message: result({ contents: [] }),
  },
  {
    name: "unknown notification",
    direction: S2C,
    era: "legacy",
    message: notification("notifications/vendor/private"),
  },
  { name: "not an object", direction: S2C, era: "legacy", message: "text" },
  {
    name: "list_changed at an unknown version",
    direction: S2C,
    era: "unknown",
    message: notification("notifications/vendor/list_changed"),
  },
];
