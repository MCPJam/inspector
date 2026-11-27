import { classifyEventsRpcError } from "@mcpjam/sdk/browser";
import type {
  EventsDeliveryModeView,
  EventsFeedEntryView,
  EventsObservedStateView,
  EventsSubscriptionView,
} from "@/shared/events-api";
import { describeConvexFailure } from "@/lib/convex-error";

/**
 * Tone for a subscription's observed state. Status tokens only (DESIGN.md:
 * success / warning / pending / destructive carry state and nothing else),
 * as a tint with the reading foreground so small text stays legible.
 */
export function observedStateTone(state: EventsObservedStateView): string {
  switch (state) {
    case "active":
      return "border-success/40 bg-success/10 text-foreground";
    case "pending":
    case "removing":
      return "border-pending/40 bg-pending/10 text-foreground";
    case "paused_auth":
    case "terminated":
      return "border-warning/40 bg-warning/10 text-foreground";
    case "error":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    case "paused":
    case "removed":
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

export const OBSERVED_STATE_LABELS: Record<EventsObservedStateView, string> = {
  pending: "Pending",
  active: "Active",
  paused: "Paused",
  error: "Error",
  terminated: "Terminated",
  paused_auth: "Needs reauthorization",
  removing: "Removing",
  removed: "Removed",
};

export function observedStateLabel(state: EventsObservedStateView): string {
  return OBSERVED_STATE_LABELS[state] ?? state;
}

/** "4m 12s" until `deadline`, or a word for the edge cases. */
export function formatCountdown(
  deadline: number | null | undefined,
  now: number,
): string {
  if (deadline === null) return "No expiry";
  if (deadline === undefined) return "Not granted yet";
  const remaining = deadline - now;
  if (remaining <= 0) return "Due now";
  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** A thrown error's message, or `fallback` when it carries none. */
/**
 * What a user reads for a failed Events call. A backend refusal (a
 * `ConvexError`) carries its sentence on `data`; its `message` is only
 * Convex's "[CONVEX M(…)] Server Error" wrapper, so read the sentence.
 */
export function errorMessage(error: unknown, fallback: string): string {
  const failure = describeConvexFailure(error, fallback);
  if (failure.refusal) return failure.message;
  return error instanceof Error && error.message ? error.message : fallback;
}

export function formatTime(value: number | string | undefined | null): string {
  if (value === undefined || value === null || value === "") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

/**
 * Pretty JSON for display. Event data is untrusted: callers render the
 * returned string as TEXT (React escapes it), never as markdown or HTML.
 */
export function safeJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A starting value for a JSON Schema: its `default`, else its first
 * `examples` entry, else the first `enum` value, else a typed blank, with
 * objects filled property by property. Bounded in depth so a recursive schema
 * cannot loop.
 */
export function exampleFromSchema(schema: unknown, depth = 0): unknown {
  if (!isRecord(schema) || depth > 6) return null;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0];
  }
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((t) => t !== "null")
    : schema.type;
  if (
    type === "object" ||
    (type === undefined && isRecord(schema.properties))
  ) {
    const result: Record<string, unknown> = {};
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, property] of Object.entries(properties)) {
      result[key] = exampleFromSchema(property, depth + 1);
    }
    return result;
  }
  switch (type) {
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    default:
      return null;
  }
}

/** The payload a simulation starts from: an object built from the schema. */
export function simulationDataFromSchema(
  payloadSchema?: JsonObject,
): JsonObject {
  const example = exampleFromSchema(payloadSchema);
  return isRecord(example) ? example : {};
}

/** The id feed entries carry for a subscription (`logicalSubscriptionId`). */
export function logicalIdOf(subscription: EventsSubscriptionView): string {
  return subscription.logicalId ?? subscription.id;
}

export function hasInsecureLocalReceiver(
  subscription: EventsSubscriptionView,
): boolean {
  return (subscription.overrides ?? []).includes("insecure-local-receiver");
}

/**
 * What ending a subscription is called in each mode, in the spec's words:
 * only webhook has an unsubscribe method; poll stops polling and push closes
 * its `events/stream` request.
 */
export const END_SUBSCRIPTION_LABELS: Record<EventsDeliveryModeView, string> = {
  webhook: "Unsubscribe",
  poll: "Stop polling",
  push: "Close stream",
};

export interface TerminationReason {
  label: string;
  /** What happened or what to do next, when there is something to say. */
  hint?: string;
}

/**
 * Why the server ended a subscription, from the error its `terminated`
 * signal carried. The spec names three causes; anything else shows the
 * server's own message. Every mode carries the same error shape, so the
 * method passed to the shared classifier is only there to satisfy its
 * `events/*` check.
 */
export function describeTermination(
  error: EventsFeedEntryView["error"] | undefined,
): TerminationReason {
  const classified = error
    ? classifyEventsRpcError("events/stream", error, "beta") ??
      classifyEventsRpcError("events/stream", error, "legacy")
    : undefined;
  const raw = classified?.data;
  const data: JsonObject = isRecord(raw) ? raw : {};
  switch (classified?.kind) {
    case "NotFound":
      return {
        label: "Event type removed",
        hint: "The server no longer lists this event type.",
      };
    case "Unsupported":
      if (data.reason === "schema_changed") {
        return {
          label: "Schema changed",
          hint: "Refresh the event types, then subscribe again.",
        };
      }
      break;
    case "Forbidden":
      return {
        label: "Access revoked",
        hint: "The server no longer lets this client receive these events.",
      };
  }
  return { label: "Terminated", hint: error?.message || undefined };
}

/** The spec's `deliveryStatus` fields, read defensively from what the server sent. */
export interface DeliveryStatusView {
  /** `active: false`: the server suspended delivery after repeated failures. */
  suspended: boolean;
  throttled: boolean;
  retryAfterMs?: number;
  /** A category such as `timeout` or `http_5xx`, never the endpoint's response. */
  lastError?: string;
  lastDeliveryAt?: string;
  failedSince?: string;
}

export function readDeliveryStatus(value: unknown): DeliveryStatusView | null {
  if (!isRecord(value)) return null;
  const text = (field: unknown) =>
    typeof field === "string" && field ? field : undefined;
  const lastError = text(value.lastError);
  const lastDeliveryAt = text(value.lastDeliveryAt);
  const failedSince = text(value.failedSince);
  return {
    suspended: value.active === false,
    throttled: value.throttled === true,
    ...(typeof value.retryAfterMs === "number"
      ? { retryAfterMs: value.retryAfterMs }
      : {}),
    ...(lastError ? { lastError } : {}),
    ...(lastDeliveryAt ? { lastDeliveryAt } : {}),
    ...(failedSince ? { failedSince } : {}),
  };
}

/**
 * A server that answers with `cursor: null` cannot replay this event type.
 * `undefined` means no position has come back yet, which says nothing.
 */
export function replayUnsupported(
  subscription: EventsSubscriptionView,
): boolean {
  return subscription.lastCursor === null;
}

const webhookFailures = new Map<string, string>([
  ["https_required", "This server only accepts HTTPS callback URLs. Unsubscribe and choose Custom URL with an HTTPS proxy."],
  ["auth_required", "This server requires an authenticated connection. Reconnect the server with credentials, then resume the subscription."],
  ["connection_refused", "The server couldn't connect to the callback. Check that the receiver is running and reachable from the server."],
  ["timeout", "The callback timed out. Check the network and your proxy's forwarding rule."],
  ["tls_error", "The server doesn't trust the proxy's certificate. Use a certificate the server trusts."],
  ["challenge_failed", "The server couldn't verify the callback. Check that the proxy preserves the request body, webhook headers, and response."],
  ["http_4xx", "The receiver refused a delivery. Check the proxy's forwarding rule."],
  ["http_5xx", "The receiver returned an error. Check that MCPJam and your proxy are running."],
]);

export function localWebhookFailure(subscription: EventsSubscriptionView): string | null {
  const status = readDeliveryStatus(subscription.deliveryStatus);
  const lastError = subscription.lastError;
  if (lastError || status?.lastError) {
    const kind = lastError?.kind.replace(/^callback_/, "") ?? status?.lastError ?? "";
    const message = webhookFailures.get(kind)
      ?? "The server couldn't deliver webhook events. Check the server connection and callback settings.";
    if (status?.suspended) return `${message} The server suspended delivery.`;
    if (lastError?.retryable) return `${message} MCPJam will retry automatically.`;
    return message;
  }
  if (status?.suspended) return "The server suspended webhook delivery. Check the callback before resuming.";
  if (status?.throttled) return "The server slowed webhook delivery. Check its delivery limits.";
  return null;
}
