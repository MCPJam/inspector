/**
 * "Does my field arrive?" Runs a sample through the real strict builders and
 * says which fields survive and why the rest are dropped. Monitors only guard
 * fields they already read; use this while adding a new diagnostic.
 *
 *   expectTelemetryFields(
 *     { log: "http.request.failed", context: { statusCode: 502 } },
 *     ["statusCode"],
 *   );
 */
import { ANALYTICS_EVENTS, type ServerAnalyticsEventName } from "../analytics-events";
import { buildStrictLogRow, strictLogFieldRule } from "../strict-log";
import { rebuildServerAnalytics, serverAnalyticsFieldRule } from "../strict-server-analytics";

type Fields = Record<string, unknown>;
export type TelemetrySample =
  | { log: string; context?: Fields; payload?: Fields; error?: unknown }
  | { analytics: string; actorId: unknown; properties: Fields };
export type TelemetryExplanation = {
  /** Exactly what leaves the process. */
  forwarded: Fields;
  /** Every sample field that does not arrive as sent, with the rule that stopped it. */
  dropped: Record<string, string>;
};

type Rule = { values?: readonly string[]; kind?: string; max?: number };

/** Any sample value, including ones JSON cannot encode (BigInt, cycles). */
function show(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Not JSON-encodable; the plain string form still names the value.
    return String(value);
  }
}
const LOG_FIELDS = "server/utils/log-events.ts";
const ANALYTICS_FIELDS = "shared/strict-server-analytics.ts";

function ruleReason(rule: Rule | undefined, value: unknown, declareIn: string) {
  if (!rule) return `no field rule: declare it in ${declareIn} (literal union, boolean or number)`;
  if (rule.values) {
    const allowed = rule.values.slice(0, 8).join(", ") + (rule.values.length > 8 ? ", …" : "");
    return `${show(value)} is not an allowed value (${allowed})`;
  }
  if (rule.kind === "boolean") return `expects a boolean, got ${typeof value}`;
  if (rule.kind === "convexId")
    return "kept only as a 32-character Convex ID in the server's request context (a LogConvexId), never from an event payload";
  return `expects a finite number from 0 to ${rule.max}, got ${show(value)}`;
}

const LOG_SPECIAL: Record<string, (row: Fields) => string> = {
  route: (row) => `rewritten to ${JSON.stringify(row.route)}: not a route template mounted for this method in server/app.ts`,
  requestId: () => "only a server-minted UUIDv4 request ID is kept",
  userAgent: (row) => `reduced to userAgentFamily ${JSON.stringify(row.userAgentFamily)}`,
  release: () => "not a version or a commit SHA",
  errorCode: (row) => `not an approved error code; sent as ${JSON.stringify(row.errorCode ?? "absent")}`,
};

function explainLog(sample: Extract<TelemetrySample, { log: string }>): TelemetryExplanation {
  const { context = {}, payload = {} } = sample;
  const row = buildStrictLogRow(sample.log, context, payload, sample.error);
  const dropped: Record<string, string> = {};
  if (row.event !== sample.log)
    dropped.event = `${JSON.stringify(sample.log)} is not in RequestEventMap or SystemEventMap (${LOG_FIELDS}); sent as ${JSON.stringify(row.event)}`;
  for (const [key, value] of Object.entries({ ...payload, ...context })) {
    if (Object.hasOwn(row, key) && row[key] === value) continue;
    const special = Object.hasOwn(LOG_SPECIAL, key)
      ? LOG_SPECIAL[key]
      : undefined;
    dropped[key] =
      special?.(row) ?? ruleReason(strictLogFieldRule(key), value, LOG_FIELDS);
  }
  return { forwarded: row, dropped };
}

function explainAnalytics(sample: Extract<TelemetrySample, { analytics: string }>): TelemetryExplanation {
  const built = rebuildServerAnalytics(sample.analytics, sample.actorId, sample.properties);
  const dropped: Record<string, string> = {};
  if (!built) {
    const declared =
      Object.hasOwn(ANALYTICS_EVENTS, sample.analytics) &&
      ANALYTICS_EVENTS[sample.analytics as ServerAnalyticsEventName].source === "server";
    dropped.event = declared
      ? "the actor is not a telemetry actor ID (a WorkOS user ID or a minted UUID), so nothing is sent"
      : `${JSON.stringify(sample.analytics)} is not declared with source "server" in shared/analytics-events.ts, so nothing is sent`;
    for (const key of Object.keys(sample.properties)) dropped[key] = "the event was not sent";
    return { forwarded: {}, dropped };
  }
  for (const [key, value] of Object.entries(sample.properties)) {
    if (Object.hasOwn(built.properties, key) && built.properties[key] === value) continue;
    dropped[key] =
      key === "pack_version"
        ? "only a pack version listed in runtime-compat for that harness is kept"
        : ruleReason(serverAnalyticsFieldRule(key), value, ANALYTICS_FIELDS);
  }
  return { forwarded: { event: built.event, ...built.properties }, dropped };
}

export function explainTelemetry(sample: TelemetrySample): TelemetryExplanation {
  return "log" in sample ? explainLog(sample) : explainAnalytics(sample);
}

/** Fails with each missing field's drop reason, so the fix is in the message. */
export function expectTelemetryFields(sample: TelemetrySample, fields: string[]) {
  const { forwarded, dropped } = explainTelemetry(sample);
  // A field rewritten on the way out (a route sent as unknown_route) did not arrive.
  const missing = fields.filter((field) => !Object.hasOwn(forwarded, field) || Object.hasOwn(dropped, field));
  if (missing.length)
    throw new Error(
      `Telemetry drops ${missing.join(", ")}:\n${missing
        .map((field) => `  ${field}: ${dropped[field] ?? "not in the sample"}`)
        .join("\n")}`,
    );
  return forwarded;
}
