import type {
  EventsObservedStateView,
  EventsSubscriptionView,
} from "@/shared/events-api";

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

function isRecord(value: unknown): value is Record<string, unknown> {
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
  payloadSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
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
