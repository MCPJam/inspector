import {
  ANALYTICS_EVENTS,
  type ServerAnalyticsEventName,
} from "./analytics-events";
import { telemetryActorId } from "@mcpjam/sdk/internal/telemetry";

const enums: Record<string, readonly string[]> = {
  origin: ["playground", "evals", "api"],
  source_type: ["playground", "eval", "api"],
  surface: ["api"],
  outcome: [
    "ok",
    "failed",
    "rate_limited",
    "timeout",
    "completed",
    "cancelled",
  ],
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
  harness_id: ["claude-code", "codex"],
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
  engine: ["emulated", "harness:claude-code", "harness:codex"],
  environment_skill_delivery: ["harness", "harness_unsupported", "emulated"],
};
const numbers = new Set([
  "duration_ms",
  "tool_call_count",
  "created_count",
  "itemCount",
  "test_case_count",
  "environment_revision",
  "environment_base_server_count",
  "environment_effective_server_count",
  "environment_skill_count",
]);
const booleans = new Set([
  "include_llm_observations",
  "deduped",
  "hasQuery",
  "hasNextCursor",
  "environment_overridden",
  "$process_person_profile",
]);

/** Only source-declared events and content-free scalar fields cross this boundary. */
export function rebuildServerAnalytics(
  event: string,
  actorId: unknown,
  input: Record<string, unknown>,
) {
  const distinctId = telemetryActorId(actorId);
  if (
    !distinctId ||
    ANALYTICS_EVENTS[event as ServerAnalyticsEventName]?.source !== "server"
  )
    return null;
  const properties: Record<string, string | boolean | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && enums[key]?.includes(value))
      properties[key] = value;
    else if (booleans.has(key) && typeof value === "boolean")
      properties[key] = value;
    else if (
      numbers.has(key) &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 86400000
    )
      properties[key] = value;
  }
  return { event: event as ServerAnalyticsEventName, distinctId, properties };
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
    ...(input.local_browser_security_version === "1"
      ? { local_browser_security_version: "1" }
      : {}),
  };
}
