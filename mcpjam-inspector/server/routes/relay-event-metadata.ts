import { createHash, randomUUID } from "node:crypto";

// Client-reported timing is diagnostic only, never authorization or ordering truth.
export const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_EVENT_FUTURE_MS = 5 * 60 * 1000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Mint an opaque retry-stable ID without forwarding a caller's identifier. */
function eventId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) return randomUUID();
  const bytes = createHash("sha256")
    .update("mcpjam:posthog:strict:v1\0")
    .update(value.toLowerCase())
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Preserve bounded queue time; invalid metadata receives server ID/time. */
export function relayEventMetadata(
  event: Record<string, unknown>,
  now = Date.now(),
) {
  const value = event.timestamp;
  const parsed =
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
      ? Date.parse(value)
      : NaN;
  const accepted =
    Number.isFinite(parsed) &&
    parsed >= now - MAX_EVENT_AGE_MS &&
    parsed <= now + MAX_EVENT_FUTURE_MS;
  return {
    uuid: eventId(event.uuid),
    timestamp: new Date(accepted ? parsed : now).toISOString(),
  };
}
