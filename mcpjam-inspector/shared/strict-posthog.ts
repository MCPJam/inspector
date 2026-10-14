import { version } from "../package.json";
import { POSTHOG_PROJECT_KEY } from "./posthog-project";

export const TELEMETRY_POLICY_HEADER = "x-mcpjam-telemetry-policy";

/** A closed catalog, not a sanitizer: unlisted events and properties do not leave. */
type Rule = readonly string[] | "count" | "boolean";
const CATALOG: Readonly<Record<string, Readonly<Record<string, Rule>>>> = {
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
  $pageview: {},
  $pageleave: {},
};

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
        candidate <= 1_000_000
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
