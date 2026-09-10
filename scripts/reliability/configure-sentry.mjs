import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Existing production integration, read from inspector-hono's alert rules.
export const slackAction = {
  id: "sentry.integrations.slack.notify_action.SlackNotifyServiceAction",
  workspace: "329687",
  channel_id: "C09HW2XRVUK",
  channel: "mcpjam-alerts",
  tags: "environment,release,monitor.slug",
};
export function routeToSlack(rule) {
  const routed = rule.actions.some(
    (action) =>
      action.id === slackAction.id &&
      String(action.workspace) === slackAction.workspace &&
      action.channel_id === slackAction.channel_id
  );
  return {
    name: rule.name,
    environment: rule.environment,
    actionMatch: rule.actionMatch,
    filterMatch: rule.filterMatch,
    frequency: rule.frequency,
    conditions: rule.conditions,
    filters: rule.filters,
    actions: routed ? rule.actions : [...rule.actions, slackAction],
    ...(rule.owner ? { owner: rule.owner } : {}),
  };
}

const project = "inspector-hono";
const slug = "inspector-critical-journeys";
export const monitor = {
  project,
  slug,
  name: "Inspector critical journeys",
  status: "active",
  is_muted: false,
  config: {
    schedule_type: "crontab",
    schedule: "*/5 * * * *",
    timezone: "UTC",
    checkin_margin: 10,
    max_runtime: 10,
    failure_issue_threshold: 1,
    recovery_threshold: 1,
  },
};
export const monitorRule = {
  name: "Reliability: canary failed or missing → #mcpjam-alerts",
  environment: "prod",
  actionMatch: "any",
  filterMatch: "all",
  frequency: 30,
  conditions: [
    { id: "sentry.rules.conditions.first_seen_event.FirstSeenEventCondition" },
    { id: "sentry.rules.conditions.regression_event.RegressionEventCondition" },
  ],
  filters: [
    {
      id: "sentry.rules.filters.tagged_event.TaggedEventFilter",
      key: "monitor.slug",
      match: "eq",
      value: slug,
    },
  ],
  actions: [slackAction],
};

function api(endpoint, body, method) {
  const args = ["api", endpoint];
  if (body) args.push("--method", method, "--data", JSON.stringify(body));
  const response = spawnSync("sentry", args, {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (response.status !== 0)
    throw new Error(`Sentry request failed: ${endpoint}`);
  const data = JSON.parse(response.stdout);
  if (data?.detail) throw new Error(`Sentry rejected request: ${endpoint}`);
  return data;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const apply = process.argv.includes("--apply");
  for (const name of [
    "inspector-hono",
    "inspector-client",
    "inspector-electron",
    "convex",
    "mcpjam-sdk",
  ]) {
    const endpoint = `projects/mcpjam-gh/${name}/rules/`;
    const rules = api(endpoint);
    if (!Array.isArray(rules)) throw new Error("Invalid Sentry rules response");
    for (const rule of rules.filter(
      (r) => r.status === "active" && !r.snooze
    )) {
      const desired = routeToSlack(rule);
      if (desired.actions.length === rule.actions.length) continue;
      process.stdout.write(
        `${apply ? "Routing" : "Would route"} ${name} rule ${rule.id}: ${
          rule.name
        }\n`
      );
      if (apply) {
        api(`${endpoint}${rule.id}/`, desired, "PUT");
        const updated = api(`${endpoint}${rule.id}/`);
        if (routeToSlack(updated).actions.length !== updated.actions.length)
          throw new Error("Sentry Slack route did not persist");
      }
    }
  }
  const monitorsEndpoint = "organizations/mcpjam-gh/monitors/";
  const monitors = api(monitorsEndpoint);
  if (!Array.isArray(monitors))
    throw new Error("Invalid Sentry monitors response");
  const existing = monitors.find((m) => m.slug === slug);
  process.stdout.write(
    `${
      apply ? "Configuring" : "Would configure"
    } external missing-run monitor and Slack rule\n`
  );
  if (apply) {
    api(
      existing ? `${monitorsEndpoint}${slug}/` : monitorsEndpoint,
      monitor,
      existing ? "PUT" : "POST"
    );
    const endpoint = `projects/mcpjam-gh/${project}/rules/`;
    const rules = api(endpoint);
    const prior = rules.find((r) => r.name === monitorRule.name);
    api(
      prior ? `${endpoint}${prior.id}/` : endpoint,
      monitorRule,
      prior ? "PUT" : "POST"
    );
  }
  if (!apply)
    process.stdout.write(
      "Preview only. Pass --apply to update Sentry after provisioning the canary.\n"
    );
}
