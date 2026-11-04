import { sha256Hex } from "@mcpjam/sdk/contract";
import { INTERNAL_TO_V1_CODE, V1_ERROR_CODES } from "@mcpjam/sdk/public-api";
import catalog from "./telemetry-catalog.generated.json";

type Fields = Record<string, unknown>;
export type StrictLogFieldRule = {
  kind?: string;
  values?: readonly string[];
  max?: number;
};
const rules: Record<string, StrictLogFieldRule> = catalog.fields;
const messages = new Set<string>(catalog.messages);
const ERROR_CLASSES = [
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "AbortError",
  ...catalog.errors,
];
const ENUMS: Record<string, readonly string[]> = {
  environment: ["prod", "staging", "preview", "dev", "local", "test"],
  authType: ["signedIn", "guest", "system", "unknown"],
  origin: ["mcpjam", "user_server", "user_config", "ambiguous"],
  method: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
  level: ["debug", "info", "warn", "error"],
};

/**
 * A Convex document ID: the shape the backend collector's `convexId` rule
 * keeps and the error-class-spike monitor counts. Only a shape; the value's
 * provenance is its writer's (`LogConvexId`, `server/utils/log-convex-id.ts`).
 */
export function isLogConvexIdShape(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{32}$/.test(value);
}

/** Own keys only: a field named `toString` or `constructor` has no rule. */
function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** The rule a context or payload field must meet to be copied into a row. */
export function strictLogFieldRule(key: string): StrictLogFieldRule | undefined {
  const rule = own(rules, key);
  const values = own(ENUMS, key) ?? rule?.values;
  if (values) return { values };
  if (rule?.kind === "number")
    return { kind: "number", max: key === "durationMs" ? 86400000 : 1000000000 };
  return rule;
}

function approved(value: unknown, values: readonly string[]) {
  return typeof value === "string" && values.includes(value)
    ? value
    : undefined;
}

export function strictLogError(error: unknown): string {
  try {
    const name = error instanceof Error ? error.name : undefined;
    return approved(name, ERROR_CLASSES) ?? "UnknownError";
  } catch {
    return "UnknownError";
  }
}

/** Legacy callsites keep code-owned prefixes; their free text is never emitted. */
export function buildLegacyLogRow(
  message: string,
  context: Fields,
  error?: unknown,
): Fields {
  const event = message.startsWith("[harness][timing] ")
    ? "harness.timing"
    : message.startsWith("[harness][bootstrap] turn=failed")
      ? "harness.bootstrap"
      : message === "[harness] turn failed"
        ? "harness.turn.failed"
        : "log.unknown";
  // A legacy caller passes whatever it holds, so its context names no ID.
  const untrusted = Object.fromEntries(
    Object.entries(context).filter(
      ([key]) => strictLogFieldRule(key)?.kind !== "convexId",
    ),
  );
  const row = buildStrictLogRow(event, untrusted, {}, error);
  if (event === "log.unknown" && messages.has(message)) {
    row.event = `log.${sha256Hex(message).slice(0, 16)}`;
    row.message = message;
    row.fingerprint = `${row.event}:${row.route}:${row.errorClass ?? "none"}`;
  }
  return row;
}

/**
 * Context is resolved by the server; event payload fields cannot replace it.
 * Convex IDs are copied from that context alone: a payload ID is never a
 * fallback, also when the context holds null or no such field.
 */
export function buildStrictLogRow(
  name: string,
  context: Fields,
  payload: Fields = {},
  error?: unknown,
): Fields {
  const event = approved(name, catalog.events) ?? "log.unknown";
  const row: Fields = { event, timestamp: new Date().toISOString() };
  copySafeLogContext(row, context, payload);
  if (event === "model_catalog.refresh.failed") {
    row.level = "warn";
    delete row.reason;
    const reason = approved(payload.reason, [
      "fetch_failed",
      "invalid_catalog",
    ]);
    if (reason) row.reason = reason;
  }
  const code = approved(payload.errorCode, [
    ...V1_ERROR_CODES,
    ...Object.keys(INTERNAL_TO_V1_CODE),
    "agent_billing_rejected",
    "abort",
    "connection_closed",
    "mcp_error",
    "unhandled_exception",
    "unknown",
  ]);
  if (code) row.errorCode = code;
  if (
    event === "route.operation.failed" &&
    code === "agent_billing_rejected" &&
    (context.reason ?? payload.reason) === "payment_not_confirmed"
  )
    row.reason = "payment_not_confirmed";
  if (error !== undefined || event.endsWith(".failed")) {
    row.errorClass = strictLogError(error);
    row.knownError = row.errorClass !== "UnknownError";
    row.errorCode = code ?? "unknown";
  }
  row.fingerprint = [
    event,
    row.route,
    row.statusCode ?? "none",
    row.errorClass ?? "none",
    code ?? "none",
  ].join(":");
  if (event === "telemetry_canary") {
    row.route = "inspector";
    row.canaryRoute = "inspector";
    row.slot = Math.floor(Date.parse(String(row.timestamp)) / 300000);
    row.emittedAt = row.timestamp;
    row.canaryId = sha256Hex(`inspector:${row.slot}`);
  }
  return row;
}

function copySafeLogContext(row: Fields, context: Fields, payload: Fields) {
  for (const [key, value] of Object.entries({ ...payload, ...context })) {
    const rule = strictLogFieldRule(key);
    if (rule?.values) {
      const kept = approved(value, rule.values);
      if (kept !== undefined) row[key] = kept;
    } else if (rule?.kind === "boolean" && typeof value === "boolean")
      row[key] = value;
    else if (
      rule?.kind === "number" &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= (rule.max ?? 0)
    )
      row[key] = value;
  }
  for (const [key, value] of Object.entries(context))
    if (strictLogFieldRule(key)?.kind === "convexId" && isLogConvexIdShape(value))
      row[key] = value;
  if (
    typeof context.requestId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      context.requestId,
    )
  )
    row.requestId = context.requestId;
  const ua = context.userAgent;
  row.userAgentFamily =
    typeof ua !== "string"
      ? "other"
      : ua.startsWith("mcpjam-mcp-worker")
        ? "mcpjam-mcp-worker"
        : ua.startsWith("mcpjam-sdk")
          ? "sdk"
          : ua.startsWith("curl/")
            ? "curl"
            : ua.startsWith("Mozilla/")
              ? "browser"
              : "other";
  const path =
    typeof context.route === "string"
      ? context.route.replace(/\/$/, "") || "/"
      : "";
  row.route = catalog.routeEntries.some(
    (entry) =>
      entry.path === path &&
      (entry.method === "ALL" || entry.method === context.method),
  )
    ? path
    : "unknown_route";
  const release = context.release;
  if (
    typeof release === "string" &&
    /^(?:\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?|[0-9a-f]{7,40})$/.test(release)
  )
    row.release = release;
}
