import { RUNTIME_COMPAT } from "../server/utils/harness/local/runtime-compat.js";
import {
  ANALYTICS_EVENTS,
  type ServerAnalyticsEventName,
} from "./analytics-events";
import {
  MCP_CLIENT_FAMILIES,
  telemetryActorId,
} from "@mcpjam/sdk/internal/telemetry";
import { V1_ERROR_CODES } from "@mcpjam/sdk/public-api";
import {
  HARNESS_TURN_BOOTSTRAPS,
  HARNESS_TURN_DURATIONS,
  HARNESS_TURN_FALLBACK_REASONS,
  HARNESS_TURN_KINDS,
  HARNESS_TURN_STARTS,
} from "./harness-turn-event";
import { isLogConvexIdShape } from "./strict-log";

/** Methods a v1 usage event records (`HEAD` is served by the `GET` route). */
const OPERATION_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

const enums: Record<string, readonly string[]> = {
  origin: ["playground", "evals", "api", "scenario"],
  source_type: ["playground", "eval", "api", "direct", "scenario", "swarm"],
  surface: [
    "api",
    "eval",
    "playground",
    "scenario",
    "web",
    "local",
    "mcp",
    "cli",
    "sdk",
  ],
  outcome: [
    "ok",
    "client_error",
    "server_error",
    "partial",
    "failed",
    "rate_limited",
    "timeout",
    "completed",
    "cancelled",
    "aborted",
  ],
  // harness_turn_completed
  kind: HARNESS_TURN_KINDS,
  start: HARNESS_TURN_STARTS,
  fallback_reason: HARNESS_TURN_FALLBACK_REASONS,
  bootstrap: HARNESS_TURN_BOOTSTRAPS,
  runtime: ["agent", "harness"],
  readiness_kind: ["claude", "chatgpt"],
  submission_mode: ["submit", "prepare", "existing"],
  overall_status: ["ready", "not-ready", "needs-attention", "pass", "fail"],
  run_status: ["queued", "running", "completed", "failed", "cancelled"],
  llm_observation_status: ["completed", "skipped", "failed", "pending"],
  llm_observation_reason: [
    "billing-blocked",
    "not-requested",
    "unavailable",
    "timeout",
  ],
  terminal_reason: ["runner_error", "timeout", "cancelled", "completed"],
  scope: ["project", "organization", "user"],
  status: ["running", "completed", "failed", "cancelled"],
  harness_id: ["claude-code", "codex", "copilot-cli", "cursor", "opencode"],
  trigger: ["boot", "readiness", "provision", "cli", "manual"],
  stage: ["download", "verify", "extract", "install", "probe", "activate"],
  role: ["desired", "previous", "candidate"],
  reason: [
    "download",
    "verification",
    "extract",
    "probe",
    "unsupported",
    "unknown",
  ],
  engine: ["emulated", "harness:claude-code", "harness:codex", "harness:opencode"],
  environment_skill_delivery: ["harness", "harness_unsupported", "emulated"],
  // api_v1_request_completed
  method: OPERATION_METHODS,
  error_code: V1_ERROR_CODES,
  // Every `authMethod` in server/types/hono.ts, plus "none". Keep in step.
  auth_method: [
    "workos_api_key",
    "workos_agent",
    "slack_service",
    "discord_service",
    "teams_service",
    "guest",
    "authkit_jwt",
    "unverified_passthrough",
    "none",
  ],
  mcp_client: MCP_CLIENT_FAMILIES,
};
const numbers = new Set([
  "duration_ms",
  "http_status",
  "tool_call_count",
  "created_count",
  "itemCount",
  "test_case_count",
  "environment_revision",
  "environment_base_server_count",
  "environment_effective_server_count",
  "environment_skill_count",
  // skills_delivered: one turn's skills by family, off the prompt's list, by
  // exclusion reason, not delivered this turn, and failed
  "delivered_library_count",
  "delivered_plugin_count",
  "delivered_mcp_server_count",
  "delivered_local_count",
  "omitted_from_catalog_count",
  "excluded_unsupported_harness_count",
  "excluded_server_skill_unsupported_count",
  "excluded_plugin_disabled_count",
  "excluded_name_collision_count",
  "excluded_invalid_skill_name_count",
  "excluded_over_cap_count",
  "not_delivered_count",
  "failed_count",
]);
/** harness_turn_completed's timings: whole milliseconds, never a fraction. */
const wholeMilliseconds = new Set<string>(HARNESS_TURN_DURATIONS);
/**
 * The organization a server-side check verified (a `LogConvexId` from the
 * request context), kept only in a Convex ID's shape.
 */
const ids = new Set(["organization_id", "project_id"]);
const booleans = new Set([
  "include_llm_observations",
  "success",
  "deduped",
  "hasQuery",
  "hasNextCursor",
  "environment_overridden",
  "$process_person_profile",
  "streamed",
  "is_guest",
]);

export type ServerAnalyticsFieldRule =
  | { values: readonly string[] }
  | { kind: "boolean" }
  | { kind: "number"; max: number; integer?: true }
  | { kind: "convexId" };

/** The rule a property must meet to be forwarded, if it has one. */
export function serverAnalyticsFieldRule(
  key: string,
): ServerAnalyticsFieldRule | undefined {
  // Own keys only: a property named `toString` or `constructor` has no rule.
  if (Object.hasOwn(enums, key)) return { values: enums[key] };
  if (booleans.has(key)) return { kind: "boolean" };
  if (numbers.has(key)) return { kind: "number", max: 86400000 };
  if (wholeMilliseconds.has(key))
    return { kind: "number", max: 86400000, integer: true };
  if (ids.has(key)) return { kind: "convexId" };
  return undefined;
}

/** Only source-declared events and content-free scalar fields cross this boundary. */
export function rebuildServerAnalytics(
  event: string,
  actorId: unknown,
  input: Record<string, unknown>,
) {
  const distinctId = telemetryActorId(actorId);
  if (
    !distinctId ||
    !Object.hasOwn(ANALYTICS_EVENTS, event) ||
    ANALYTICS_EVENTS[event as ServerAnalyticsEventName].source !== "server"
  )
    return null;
  const properties: Record<string, string | boolean | number> = {};
  for (const [key, value] of Object.entries(input)) {
    const rule = serverAnalyticsFieldRule(key);
    if (!rule) continue;
    if ("values" in rule) {
      if (typeof value === "string" && rule.values.includes(value))
        properties[key] = value;
    } else if (rule.kind === "boolean") {
      if (typeof value === "boolean") properties[key] = value;
    } else if (rule.kind === "convexId") {
      if (isLogConvexIdShape(value)) properties[key] = value;
    } else if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= rule.max &&
      (!rule.integer || Number.isInteger(value))
    )
      properties[key] = value;
  }
  if (isV1Operation(input.operation)) properties.operation = input.operation;
  const harness = input.harness_id;
  const packVersion = input.pack_version;
  if (
    (harness === "claude-code" || harness === "codex") &&
    typeof packVersion === "string"
  ) {
    const known = Object.values(RUNTIME_COMPAT.harnesses[harness].targets).some(
      (slot) =>
        slot &&
        [slot.desired.packVersion, slot.permitted?.packVersion].includes(
          packVersion,
        ),
    );
    if (known) properties.pack_version = packVersion;
  }
  return { event: event as ServerAnalyticsEventName, distinctId, properties };
}

const V1_OPERATION_METHODS = new Set<string>(OPERATION_METHODS);
/** `:param`, a lowercase word route segment (`eval-runs`, `v1`), or `*`. */
const V1_ROUTE_SEGMENT = /^(?::[A-Za-z][A-Za-z0-9_]*|[a-z]+(?:-[a-z]+)*|v\d+|\*)$/;

/**
 * `operation` is "METHOD /api/v1/route/:pattern". Hono hands the middleware
 * the matched pattern, never the request path, and this shape check keeps a
 * path value from riding along if that ever changes: a segment holding an id,
 * a number, an uppercase letter or punctuation fails it.
 */
function isV1Operation(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const [method, route, extra] = value.split(" ");
  if (extra !== undefined || !V1_OPERATION_METHODS.has(method)) return false;
  if (!route?.startsWith("/api/v1/")) return false;
  return route
    .slice("/api/v1/".length)
    .split("/")
    .every((segment) => V1_ROUTE_SEGMENT.test(segment));
}

/** Anonymous flag subjects are the UUIDv7 values minted by posthog-js. */
export function rolloutActorId(value: unknown): string | undefined {
  if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    return value.toLowerCase();
  return telemetryActorId(value);
}

/** Email is supplied separately by an authenticated account lookup, never caller properties. */
export function rolloutPersonProperties(input: Record<string, string>, trustedEmail?: string) {
  return {
    ...(typeof trustedEmail === "string" && trustedEmail.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trustedEmail)
      ? { email: trustedEmail } : {}),
    ...(["web", "npm", "docker", "mac", "win", "electron", "linux"].includes(input.platform)
      ? { platform: input.platform }
      : {}),
    ...(input.deployment === "hosted" || input.deployment === "self_hosted"
      ? { deployment: input.deployment }
      : {}),
  };
}
