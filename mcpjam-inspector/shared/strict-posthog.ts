import { version } from "../package.json";
import { POSTHOG_PROJECT_KEY } from "./posthog-project";
import { APP_LOAD_STALL_CODES } from "./app-load-stall";
import {
  EXTENSION_OPERATION_ERROR_CODES,
  EXTENSION_OPERATION_PROPERTIES,
} from "./extension-operation-event";

import {
  LOCAL_WEBHOOK_FAILURE_CATEGORIES,
  LOCAL_WEBHOOK_RECEIVER_KINDS,
} from "./local-webhook-telemetry";

export const TELEMETRY_POLICY_HEADER = "x-mcpjam-telemetry-policy";

/** A closed catalog, not a sanitizer: unlisted events and properties do not leave. */
type Rule = readonly string[] | "count" | "boolean";
const SIGN_IN_ATTEMPT = {
  location: ["app", "session-refresh", "promo_redemption"],
  intent: ["sign_in", "sign_up"],
  signin_platform: ["web", "desktop", "npx"],
} as const satisfies Record<string, Rule>;
const GITHUB_STAR_PROMPT = {
  location: ["header"],
  trigger: ["conformance", "oauth", "xaa"],
  reason: ["completed", "return_visit"],
  has_advice: "boolean",
} as const satisfies Record<string, Rule>;

/** The largest value a `"count"` field keeps; anything above it is dropped. */
export const STRICT_COUNT_MAX = 1_000_000;

const CATALOG: Readonly<Record<string, Readonly<Record<string, Rule>>>> = {
  extension_launch_completed: {
    location: ["host_workspace"],
    launch_kind: ["thread", "global", "file", "quick-action", "settings"],
    host_profile: ["chatgpt", "codex"],
    outcome: ["success", "failure"],
    failure_stage: ["none", "execution", "rendering", "timeout", "unknown"],
    deployment: ["hosted", "self_hosted"],
    source: ["client"],
  },
  extension_operation_completed: {
    ...EXTENSION_OPERATION_PROPERTIES,
    error_code: EXTENSION_OPERATION_ERROR_CODES,
  },
  // Sent at startup, often before the content grant arrives, so most launches
  // reach the relay as strict. Without this entry every one of them is dropped.
  app_launched: {
    location: ["app"],
    is_authenticated: "boolean",
    platform: ["web", "npm", "docker", "mac", "win", "electron"],
    deployment: ["hosted", "self_hosted"],
    // Measures how long the content grant takes, to tune the launch timeout.
    launch_trigger: ["immediate", "grant", "timeout", "hidden"],
    policy_wait_ms: "count",
  },
  // `app_launched` fires only once an actor is known, so a launch that never
  // finishes starting is invisible to it. These two are sent before any actor
  // exists: one per page load, and one when the recovery card appears.
  app_startup_started: {
    location: ["app"],
    platform: ["web", "npm", "docker", "mac", "win", "electron"],
    deployment: ["hosted", "self_hosted"],
  },
  app_startup_blocked: {
    location: ["app"],
    platform: ["web", "npm", "docker", "mac", "win", "electron"],
    deployment: ["hosted", "self_hosted"],
    stage: APP_LOAD_STALL_CODES,
    trigger: ["failure", "deadline"],
    elapsed_ms: "count",
  },
  // Completions and callback failures are sent on the load that returns from
  // WorkOS, for an actor whose content grant has not arrived yet.
  signin_started: SIGN_IN_ATTEMPT,
  signin_completed: SIGN_IN_ATTEMPT,
  signin_failed: {
    ...SIGN_IN_ATTEMPT,
    reason: [
      "insecure_origin",
      "start_error",
      "callback_error",
      "code_exchange_failed",
      "abandoned",
    ],
  },
  send_message: {
    location: ["chat_tab", "ui_playground"],
    multi_model_enabled: "boolean",
    multi_model_count: "count",
  },
  edit_message: { location: ["chat_tab", "ui_playground"] },
  execute_tool: {
    location: ["parameters_panel", "tools_sidebar"],
    as_task: "boolean",
  },
  eval_suite_run_started: {
    location: ["ci_evals_tab"],
    num_test_cases: "count",
    num_tests: "count",
    num_models: "count",
    replay: "boolean",
  },
  conformance_run_triggered: {
    location: [
      "conformance_tab",
      "score_runner",
      "compat_page",
      "compat_detail_modal",
    ],
    run_source: ["ui"],
  },
  local_webhook_receiver_selected: {
    receiver_kind: LOCAL_WEBHOOK_RECEIVER_KINDS,
  },
  local_webhook_receiver_failed: {
    receiver_kind: LOCAL_WEBHOOK_RECEIVER_KINDS,
    failure_category: LOCAL_WEBHOOK_FAILURE_CATEGORIES,
  },
  conformance_tab_viewed: { location: ["conformance_tab"] },
  conformance_run_completed: {
    location: ["conformance_tab"],
    run_source: ["ui"],
    outcome: ["passed", "failed", "incomplete"],
    has_advice: "boolean",
    scored: "boolean",
  },
  github_star_prompt_shown: GITHUB_STAR_PROMPT,
  github_star_prompt_clicked: {
    ...GITHUB_STAR_PROMPT,
    cta: ["primary", "star_button"],
  },
  github_star_prompt_dismissed: {
    ...GITHUB_STAR_PROMPT,
    close_reason: ["not_now", "dismiss"],
  },
  github_star_button_clicked: { location: ["header", "settings"] },
  $pageview: {},
  $pageleave: {},
};

/** Feature-health outcomes: every listed property must be present and valid. */
const OUTCOME_EVENTS: ReadonlySet<string> = new Set([
  "extension_launch_completed",
  "extension_operation_completed",
  "local_webhook_receiver_selected",
  "local_webhook_receiver_failed",
]);

export function telemetryRouteTemplate(value: unknown): string {
  if (typeof value !== "string") return "/:path";
  const path = value.replace(/^https?:\/\/[^/]+/, "").split(/[?#]/, 1)[0];
  if (path === "/") return "/";
  if (/^\/projects\/[^/]+(?:\/.*)?$/.test(path)) return "/projects/:projectId";
  return (
    ["/chat", "/evals", "/settings", "/servers", "/organizations"].find(
      (route) => path === route || path.startsWith(`${route}/`),
    ) ?? "/:path"
  );
}

export function rebuildStrictPostHogEvent(
  value: unknown,
  actorId?: string,
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  const event = value as Record<string, unknown>;
  if (typeof event.event !== "string" || !Object.hasOwn(CATALOG, event.event))
    return null;
  const source =
    typeof event.properties === "object" && event.properties !== null
      ? (event.properties as Record<string, unknown>)
      : {};
  // An incomplete outcome would count as a successful attempt in the monitor.
  if (OUTCOME_EVENTS.has(event.event) &&
      Object.entries(CATALOG[event.event]).some(([key, rule]) => {
        const candidate = source[key];
        return typeof rule !== "string" &&
          (typeof candidate !== "string" || !rule.includes(candidate));
      })) return null;
  const properties: Record<string, unknown> = {
    token: POSTHOG_PROJECT_KEY,
    app_version: version,
    // The relay cannot authenticate a supplied actor id. Keep aggregate counts
    // without treating arbitrary client text as an app-owned identity.
    distinct_id: actorId ?? "strict",
    $process_person_profile: false,
    $geoip_disable: true,
  };
  for (const [key, rule] of Object.entries(CATALOG[event.event])) {
    const candidate = source[key];
    if (rule === "count") {
      if (
        typeof candidate === "number" &&
        Number.isInteger(candidate) &&
        candidate >= 0 &&
        candidate <= STRICT_COUNT_MAX
      )
        properties[key] = candidate;
    } else if (rule === "boolean") {
      if (typeof candidate === "boolean") properties[key] = candidate;
    } else if (typeof candidate === "string" && rule.includes(candidate)) {
      properties[key] = candidate;
    }
  }
  if (event.event === "$pageview" || event.event === "$pageleave") {
    properties.$pathname = telemetryRouteTemplate(
      source.$pathname ?? source.$current_url,
    );
  }
  return { event: event.event, properties };
}
