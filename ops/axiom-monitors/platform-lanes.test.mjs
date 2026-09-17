import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { QUERIES } from "./platform-lane-queries.mjs";

const KEYS = [
  "platform-lane-spend-hourly-warn",
  "platform-lane-spend-hourly-page",
  "platform-lane-budget-refusals-hourly",
  "platform-lane-guard-failures",
  "platform-lane-stale-holds",
  "platform-lane-snapshot-deadman",
  "platform-lane-customer-billed",
];
const load = (key) =>
  JSON.parse(readFileSync(new URL(`./monitors/${key}.json`, import.meta.url)));
const queryOf = (key) => load(key).aplQuery.join("\n");

/** A log line exactly as mcpjam-backend's emitOperationalEvent writes it. */
const line = (payload) =>
  `[mcpjam_operational_event] ${JSON.stringify({ service: "mcpjam-backend", ...payload })}`;

/** Every `extract('"field":PATTERN', 1, msg)` in a query, as runnable regexes. */
function extractors(query) {
  const found = {};
  for (const match of query.matchAll(/extract\('"([A-Za-z]+)":(.+?)', 1, msg\)/g)) {
    found[match[1]] = new RegExp(`"${match[1]}":${match[2]}`);
  }
  return found;
}
const read = (regex, text) => regex.exec(text)?.[1];

test("each monitor matches its event exactly, never a longer event name", () => {
  for (const key of KEYS) {
    for (const [, event] of queryOf(key).matchAll(/contains '"event":"([a-z_]+)"'/g)) {
      const needle = `"event":"${event}"`;
      assert.ok(line({ event }).includes(needle), `${key} reads ${event}`);
      assert.ok(
        !line({ event: `${event}_completed` }).includes(needle),
        `${key}: ${event} must not match ${event}_completed`
      );
    }
  }
});

test("spend reads attempt micros once per eventKey, never usage totals", () => {
  for (const key of ["platform-lane-spend-hourly-warn", "platform-lane-spend-hourly-page"]) {
    const query = queryOf(key);
    const fields = extractors(query);
    const settled = line({
      event: "platform_lane_settled",
      eventKey: "run_insights:r1:j1:attempt:a1:settled",
      actualMicros: 40000,
    });
    assert.equal(Number(read(fields.actualMicros, settled)), 40000);
    assert.equal(read(fields.eventKey, settled), "run_insights:r1:j1:attempt:a1:settled");
    // A duplicated log line collapses on eventKey before the sum.
    assert.match(query, /summarize actualMicros=max\(actualMicros\) by eventKey\n\| summarize Spend/);
    assert.doesNotMatch(query, /llm_usage_record_created|totalCost/);
    // replay.mjs --spend re-anchors this exact line.
    assert.ok(load(key).aplQuery.includes("| where _sysTime >= ago(60m)"));
  }
});

test("refusals count distinct attempts, and only exhausted budgets", () => {
  const query = queryOf("platform-lane-budget-refusals-hourly");
  assert.match(query, /"budgetExhausted":true/);
  assert.ok(line({ event: "platform_lane_refused", budgetExhausted: true }).includes('"budgetExhausted":true'));
  assert.ok(!line({ event: "platform_lane_refused", budgetExhausted: false }).includes('"budgetExhausted":true'));
  assert.match(query, /dcount\(eventKey\)/);
});

test("stale holds read only complete snapshots, latest per feature", () => {
  const query = queryOf("platform-lane-stale-holds");
  assert.match(query, /"complete":true/);
  assert.match(query, /arg_max\(_time, staleMicros\) by feature/);
  const fields = extractors(query);
  const snapshot = line({ event: "platform_lane_snapshot", complete: true, feature: "eval_generation", staleMicros: 12500000 });
  assert.equal(Number(read(fields.staleMicros, snapshot)), 12500000);
  // An incomplete snapshot has no totals to read.
  assert.equal(read(fields.staleMicros, line({ event: "platform_lane_snapshot", complete: false, rowsScanned: 9000 })), undefined);
});

test("the customer-billing monitor watches every platform-paid feature", () => {
  // Mirrors PLATFORM_PAID_INTERNAL_LLM in mcpjam-backend
  // convex/lib/pricing/internalLlmPolicy.ts. Change both together.
  const expected = [
    "benchmark_self_suite", "description_rewrite_proposal", "direct_chat_quality",
    "directory_readiness", "eval_generation", "markdown_case_import",
    "metadata_attribution", "run_group_quality", "run_insights", "scenario_clusters",
    "scenario_window_insights", "server_quality", "swarm_generation", "swarm_wave_insights",
  ];
  const listed = queryOf("platform-lane-customer-billed").match(/feature in \(([^)]+)\)/)[1];
  assert.deepEqual(listed.split(", ").map((s) => s.slice(1, -1)).sort(), expected);
});

test("usage drill-down parses tiny, exponent-form and negative dollar amounts", () => {
  const fields = extractors(QUERIES.usageSpendByFeatureModelOrg);
  assert.equal(Number(read(fields.totalCost, line({ totalCost: 5e-7 }))), 5e-7);
  assert.equal(Number(read(fields.costDelta, line({ costDelta: -1.2e-6 }))), -1.2e-6);
  assert.equal(Number(read(fields.costDelta, line({ costDelta: 0.09 }))), 0.09);
  assert.equal(read(fields.funding, line({ funding: "platform" })), "platform");
});

test("usage drill-down counts each record once at its latest cost", () => {
  // Mirror of the query's rule: latest totalCost per usageRecordId. A delayed
  // cost, a correction, and a duplicated log line each land exactly once.
  const query = QUERIES.usageSpendByFeatureModelOrg;
  assert.match(query, /summarize arg_max\(_time, totalCost, feature, modelId, org\) by usageRecordId/);
  const events = [
    { t: 1, usageRecordId: "u1", totalCost: 0 }, // created, unpriced
    { t: 1, usageRecordId: "u1", totalCost: 0 }, // the same line, logged twice
    { t: 2, usageRecordId: "u1", totalCost: 0.09 }, // delayed cost
    { t: 3, usageRecordId: "u1", totalCost: 0.08 }, // correction
    { t: 1, usageRecordId: "u2", totalCost: 5e-7 }, // tiny, exponent form
  ];
  const latest = new Map();
  for (const e of events) {
    const seen = latest.get(e.usageRecordId);
    if (!seen || e.t >= seen.t) latest.set(e.usageRecordId, e);
  }
  const usd = [...latest.values()].reduce((sum, e) => sum + e.totalCost, 0);
  assert.equal(Math.round(usd * 1e8) / 1e8, 0.0800005);
  assert.doesNotMatch(query, /platform_lane_settled/);
});

test("drill-down attempt queries dedupe on eventKey too", () => {
  for (const name of ["attemptSpendByFeatureOrg", "expensiveCallers"]) {
    assert.match(QUERIES[name], /summarize actualMicros=max\(actualMicros\) by eventKey/);
  }
});

test("every definition fits the pager and says it is not live yet", () => {
  for (const key of KEYS) {
    const definition = load(key);
    assert.equal(definition.key, key);
    assert.ok(definition.description.join("\n").length <= 900, key);
    assert.ok(definition.description.some((l) => l.includes("platform-lanes.md")), key);
    assert.ok(
      definition.rationale.some((l) => /PROD/.test(l)),
      `${key} must say it depends on the backend prod deploy`
    );
  }
});
