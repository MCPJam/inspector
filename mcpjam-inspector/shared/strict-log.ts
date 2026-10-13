import { V1_ERROR_CODES } from "@mcpjam/sdk/public-api";
import catalog from "./telemetry-catalog.generated.json";

type Fields = Record<string, unknown>;
type Rule = { kind?: string; values?: readonly string[] };
const rules: Record<string, Rule> = catalog.fields;
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
  origin: ["mcpjam", "customer", "dependency", "external", "unknown"],
  method: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
  level: ["debug", "info", "warn", "error"],
};

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

/** Context is resolved by the server; event payload fields cannot replace it. */
export function buildStrictLogRow(
  name: string,
  context: Fields,
  payload: Fields = {},
  error?: unknown,
): Fields {
  const event = approved(name, catalog.events) ?? "log.unknown";
  const row: Fields = { event, timestamp: new Date().toISOString() };
  for (const [key, value] of Object.entries({ ...payload, ...context })) {
    const rule = rules[key];
    const values = ENUMS[key] ?? rule?.values;
    if (values) {
      const kept = approved(value, values);
      if (kept !== undefined) row[key] = kept;
    } else if (rule?.kind === "boolean" && typeof value === "boolean")
      row[key] = value;
    else if (
      rule?.kind === "number" &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= (key === "durationMs" ? 86400000 : 1000000000)
    )
      row[key] = value;
  }
  if (
    typeof context.requestId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      context.requestId,
    )
  )
    row.requestId = context.requestId;
  row.route = approved(context.route, catalog.routes) ?? "unknown_route";
  const release = context.release;
  if (
    typeof release === "string" &&
    /^(?:\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?|[0-9a-f]{7,40})$/.test(release)
  )
    row.release = release;
  const code = approved(payload.errorCode, V1_ERROR_CODES);
  if (code) row.errorCode = code;
  if (error !== undefined) {
    row.errorClass = strictLogError(error);
    row.knownError = row.errorClass !== "UnknownError";
  }
  row.fingerprint = [
    event,
    row.route,
    row.errorClass ?? "none",
    code ?? "none",
  ].join(":");
  return row;
}
