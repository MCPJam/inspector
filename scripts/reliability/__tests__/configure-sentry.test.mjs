import { test } from "node:test";
import assert from "node:assert/strict";
import { routeToSlack, monitorRule, monitor } from "../configure-sentry.mjs";

test("Slack routing preserves existing conditions, recipients and environment and is idempotent", () => {
  const rule = {
    name: "High priority",
    environment: "prod",
    actions: [{ id: "email" }],
    conditions: [{ id: "high_priority" }],
    filters: [],
    frequency: 30,
    actionMatch: "any",
    filterMatch: "all",
  };
  const updated = routeToSlack(rule);
  assert.equal(updated.actions.length, 2);
  assert.deepEqual(updated.conditions, rule.conditions);
  assert.equal(updated.environment, "prod");
  assert.deepEqual(updated.actions[0], rule.actions[0]);
  assert.deepEqual(routeToSlack(updated), updated);
  assert.equal(rule.actions.length, 1);
});

test("independent missed-run monitor matches the canary's production tag and schedule", () => {
  assert.equal(monitor.config.schedule, "*/5 * * * *");
  assert.equal(monitor.config.checkin_margin, 10);
  assert.equal(monitorRule.environment, "prod");
  assert.equal(monitorRule.filters[0].value, monitor.slug);
});
