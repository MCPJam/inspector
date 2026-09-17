#!/usr/bin/env node
/**
 * Adds (or refreshes) the "included AI" row on the Infra Overview dashboard.
 *
 * Infra Overview is edited through the API, not a checked-in definition, so this
 * script owns ONLY the charts whose id starts with `platform-lane-`: it removes
 * those, inserts the current set at ROW_Y, and shifts everything below down by
 * the row's height the first time. Every other chart is left byte for byte.
 *
 *   node ops/axiom-monitors/dashboard-platform-lanes.mjs          # plan: validate queries, print the change
 *   node ops/axiom-monitors/dashboard-platform-lanes.mjs --apply  # write
 *
 * Needs AXIOM_TOKEN and AXIOM_ORG_ID. Writes a backup of the dashboard it read
 * next to this file (`.infra-overview-backup-<version>.json`, gitignored by name)
 * before any PUT. Queries mirror `monitors/platform-lane-*` and
 * `platform-lane-queries.mjs`; titles carry the alert thresholds because Axiom
 * charts have no reference lines.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = process.env.AXIOM_TOKEN;
const ORG = process.env.AXIOM_ORG_ID;
if (!TOKEN || !ORG) {
  console.error("✖ AXIOM_TOKEN and AXIOM_ORG_ID are required");
  process.exit(1);
}
const APPLY = process.argv.includes("--apply");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const UID = "infra-overview";
const PREFIX = "platform-lane-";
/** Directly under the E2B row. */
const ROW_Y = 15;

const E = `['mcpjam-backend-prod'] | where tostring(['data.message']) contains '[mcpjam_operational_event]' | extend msg=tostring(['data.message'])`;
const ex = (field, pattern = '"([^"]+)"') => `extract('"${field}":${pattern}', 1, msg)`;
const MICROS = "([0-9]+)";
const FEATURES =
  "'benchmark_self_suite', 'description_rewrite_proposal', 'direct_chat_quality', 'directory_readiness', 'eval_generation', 'markdown_case_import', 'metadata_attribution', 'run_group_quality', 'run_insights', 'scenario_clusters', 'scenario_window_insights', 'server_quality', 'swarm_generation', 'swarm_wave_insights'";

const stat = (id, name, apl) => ({ id: PREFIX + id, name, type: "Statistic", query: { apl, queryOptions: { displayNull: "auto" } } });
const table = (id, name, apl) => ({ id: PREFIX + id, name, type: "Table", query: { apl, queryOptions: { displayNull: "auto" } } });
const series = (id, name, apl) => ({ id: PREFIX + id, name, type: "TimeSeries", query: { apl, queryOptions: { displayNull: "auto", timeSeriesVariant: "line", timeSeriesView: "charts" } } });

export const CHARTS = [
  stat("spend-1h", "Included AI spend (MCPJam-paid), 1h (warns >$10, pages >$25)",
    `${E} | where _sysTime >= ago(60m) | where msg contains '"event":"platform_lane_settled"' | extend eventKey=${ex("eventKey")}, actualMicros=tolong(${ex("actualMicros", MICROS)}) | summarize actualMicros=max(actualMicros) by eventKey | summarize Spend=round(sum(actualMicros) / 1000000.0, 2)`),
  stat("refusals-1h", "Included AI refused on a spent budget, 1h (warns >20)",
    `${E} | where _sysTime >= ago(60m) | where msg contains '"event":"platform_lane_refused"' and msg contains '"budgetExhausted":true' | extend eventKey=${ex("eventKey")} | summarize Refusals=dcount(eventKey)`),
  stat("guard-failures-15m", "Lane guard failing closed, 15m (pages >0 in 5m)",
    `${E} | where _sysTime >= ago(15m) | where msg contains '"event":"insight_reservation_failed"' or msg contains '"event":"insight_lane_settle_failed"' or msg contains '"event":"platform_lane_scan_bounded"' | summarize Failures=count()`),
  stat("customer-billed-24h", "Included AI billed to a customer, 24h (pages >0 in 15m)",
    `${E} | where _sysTime >= ago(24h) | where msg contains '"event":"llm_usage_record_created"' | extend feature=${ex("feature")}, spendingPolicy=${ex("spendingPolicy")}, modelSource=${ex("modelSource")} | where spendingPolicy == 'consume_mcpjam_limit' and modelSource == 'mcpjam' | where feature in (${FEATURES}) | summarize Violations=count()`),
  stat("stale-holds", "Stale lane holds $, latest snapshot (warns >$5)",
    `${E} | where _sysTime >= ago(15m) | where msg contains '"event":"platform_lane_snapshot"' and msg contains '"complete":true' | extend feature=${ex("feature")}, staleMicros=tolong(${ex("staleMicros", MICROS)}) | summarize staleMicros=max(staleMicros) by feature | summarize StaleUsd=round(sum(staleMicros) / 1000000.0, 2)`),
  stat("snapshot-age", "Minutes since last lane snapshot (cron every 10; warns >30; empty = backend #1470 not in prod)",
    `${E} | where msg contains '"event":"platform_lane_snapshot_completed"' | summarize Last=max(_time) | project Minutes=datetime_diff('minute', now(), todatetime(Last))`),
  series("spend-by-feature", "Included AI spend per hour by feature, $ (attempts)",
    `${E} | where msg contains '"event":"platform_lane_settled"' | extend feature=${ex("feature")}, actualMicros=tolong(${ex("actualMicros", MICROS)}) | summarize Usd=round(sum(actualMicros) / 1000000.0, 4) by bin(_time, 1h), feature`),
  table("top-orgs", "Top orgs by included AI spend (attempts, deduped) — a runaway caller shows here first",
    `${E} | where msg contains '"event":"platform_lane_settled"' | extend eventKey=${ex("eventKey")}, feature=${ex("feature")}, org=${ex("organizationId")}, actualMicros=tolong(${ex("actualMicros", MICROS)}) | summarize actualMicros=max(actualMicros) by eventKey, feature, org | summarize Usd=round(sum(actualMicros) / 1000000.0, 4), Attempts=count() by org, feature | top 15 by Usd desc`),
  table("refusals-by-reason", "Included AI refusals by feature, reason, scope (scope=platform = everyone lost it until 00:00 UTC)",
    `${E} | where msg contains '"event":"platform_lane_refused"' | extend eventKey=${ex("eventKey")}, feature=${ex("feature")}, reason=${ex("reason")}, scope=${ex("scope")} | summarize Refusals=dcount(eventKey), Orgs=dcount(${ex("organizationId")}) by feature, reason, scope | sort by Refusals desc`),
];

const box = (id, x, y, w, h) => ({ i: PREFIX + id, x, y, w, h, minH: 2, minW: 2, moved: false, static: false });
export const LAYOUT = [
  box("spend-1h", 0, 0, 3, 3), box("refusals-1h", 3, 0, 3, 3), box("guard-failures-15m", 6, 0, 3, 3), box("customer-billed-24h", 9, 0, 3, 3),
  box("stale-holds", 0, 3, 3, 3), box("snapshot-age", 3, 3, 3, 3), box("spend-by-feature", 6, 3, 6, 3),
  box("top-orgs", 0, 6, 6, 4), box("refusals-by-reason", 6, 6, 6, 4),
];
const ROW_HEIGHT = Math.max(...LAYOUT.map((l) => l.y + l.h));

const headers = { Authorization: `Bearer ${TOKEN}`, "X-Axiom-Org-Id": ORG, "Content-Type": "application/json" };

async function validate(chart) {
  const end = new Date(), start = new Date(end.getTime() - 864e5);
  const res = await fetch("https://api.axiom.co/v1/datasets/_apl?format=tabular", {
    method: "POST", headers, body: JSON.stringify({ apl: chart.query.apl, startTime: start.toISOString(), endTime: end.toISOString() }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${chart.id}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.tables?.[0]?.columns?.[0]?.length ?? 0;
}

const res = await fetch(`https://api.axiom.co/v2/dashboards/uid/${UID}`, { headers });
if (!res.ok) throw new Error(`read ${UID}: ${res.status} ${await res.text()}`);
const raw = await res.text();
const current = JSON.parse(raw);
const dash = current.dashboard;
// The version is a 64-bit integer. JSON.parse rounds it, and the API refuses
// a write carrying the rounded value (412 stale_version), so it is carried
// through as the exact digits from the raw response.
const exactVersion = raw.match(/"version"\s*:\s*"?(\d+)"?/)?.[1];
if (!exactVersion) throw new Error("could not read the dashboard version");

let failed = 0;
for (const chart of CHARTS) {
  try { console.log(`query ok  ${chart.id} — ${await validate(chart)} row(s) in 24h`); }
  catch (e) { failed++; console.log(`QUERY FAIL ${e.message}`); }
}
if (failed) process.exit(1);

const alreadyPresent = dash.charts.some((c) => c.id.startsWith(PREFIX));
const charts = [...dash.charts.filter((c) => !c.id.startsWith(PREFIX)), ...CHARTS];
const layout = [
  ...dash.layout.filter((l) => !l.i.startsWith(PREFIX)).map((l) => (!alreadyPresent && l.y >= ROW_Y ? { ...l, y: l.y + ROW_HEIGHT } : l)),
  ...LAYOUT.map((l) => ({ ...l, y: l.y + ROW_Y })),
];
console.log(`${alreadyPresent ? "refresh" : "insert"} ${CHARTS.length} charts at y=${ROW_Y}; ${dash.charts.length} → ${charts.length} charts`);
if (!APPLY) { console.log("plan only — re-run with --apply to write."); process.exit(0); }

writeFileSync(path.join(HERE, `.infra-overview-backup-${exactVersion}.json`), raw);
const VERSION_SLOT = "__EXACT_VERSION__";
// Inside the document the version is a STRING; at the top level it is a
// NUMBER. Both must be the exact digits.
const body = JSON.stringify({ dashboard: { ...dash, charts, layout, version: exactVersion }, version: VERSION_SLOT })
  .replace(`"${VERSION_SLOT}"`, exactVersion);
const put = await fetch(`https://api.axiom.co/v2/dashboards/uid/${UID}`, { method: "PUT", headers, body });
const out = await put.text();
if (!put.ok) { console.error(`✖ write failed: ${put.status} ${out.slice(0, 400)}`); process.exit(1); }
const after = JSON.parse(out);
console.log(`written: version ${exactVersion} → ${out.match(/"version"\s*:\s*"?(\d+)"?/)?.[1]}; ${(after.dashboard ?? after).charts?.length} charts`);
