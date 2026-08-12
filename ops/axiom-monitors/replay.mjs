#!/usr/bin/env node
/**
 * Replay the class monitors against known history.
 *
 * A monitor is only trustworthy if it fires on the incident it was written for
 * AND stays silent on the noise it was written to ignore. Both directions are
 * asserted here. The silent direction is the one that decides whether anyone
 * keeps reading #mcpjam-alerts, so it is not optional.
 *
 *   AXIOM_TOKEN=... AXIOM_ORG_ID=mcpjam-b35r node ops/axiom-monitors/replay.mjs
 *
 * Exits non-zero if any case regresses.
 *
 * THE CARDINAL RULE, learned twice the hard way: a case must express the
 * monitor's REAL predicate, never a proxy for it. Every query below is built by
 * `spikePredicate` / `noveltyPredicate`, which mirror the shipped definitions
 * clause for clause — including the production-environment filter, the
 * fingerprint expression, and the recent-hour-only maxStatus. An earlier
 * version hand-rolled the noise check with a hardcoded baseline and no
 * fingerprint grouping; it could have passed while production paged.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = process.env.AXIOM_TOKEN;
const ORG = process.env.AXIOM_ORG_ID;
if (!TOKEN || !ORG) {
  console.error("✖ AXIOM_TOKEN and AXIOM_ORG_ID are required");
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read a shipped monitor definition so drift between the deployed query and the
 * replayed one is at least visible. The predicates below are still written out
 * (they must be re-anchored to an explicit instant, which the live `ago(1h)`
 * form cannot express), but the definitions are loaded to assert the pieces
 * that CAN be compared literally.
 */
function loadMonitor(key) {
  return JSON.parse(
    readFileSync(path.join(HERE, "monitors", `${key}.json`), "utf8"),
  );
}

const SHARED_FILTERS = `| where event in ('http.request.failed','http.request.completed')
| where toint(statusCode) >= 400
| where tostring(environment) in ('prod','production')`;

const FP = `| extend fpSource = coalesce(tostring(errorMessage), tostring(errorCode), strcat(tostring(route), ' ', tostring(statusCode)))
| extend fp = replace_regex(@'[0-9a-z]{20,}', 'ID', substring(fpSource, 0, 100))`;

const hourBefore = (at) =>
  new Date(new Date(at).getTime() - 3600_000).toISOString().replace(/\.\d+Z$/, "Z");

/** inspector-error-class-spike, evaluated AT an explicit instant. */
function spikePredicate(at) {
  const from = hourBefore(at);
  return `['inspector-logs']
${SHARED_FILTERS}
| where _time <= datetime(${at})
${FP}
| summarize recent = countif(_time > datetime(${from})), baseline = countif(_time <= datetime(${from})), orgs = dcountif(orgId, _time > datetime(${from})), maxStatus = maxif(toint(statusCode), _time > datetime(${from})) by fp
| extend baseHourly = baseline / 335.0
| where (maxStatus >= 500 and recent > 100) or (recent >= 20 and orgs >= 3 and recent > 20 * baseHourly)
| project fp, recent, baseHourly, orgs, maxStatus
| sort by recent desc`;
}

/** inspector-new-error-class, evaluated AT an explicit instant. */
function noveltyPredicate(at) {
  const from = hourBefore(at);
  return `['inspector-logs']
${SHARED_FILTERS}
| where _time <= datetime(${at})
${FP}
| summarize recent = countif(_time > datetime(${from})), baseline = countif(_time <= datetime(${from})) by fp
| where baseline == 0 and recent >= 10
| project fp, recent
| sort by recent desc`;
}

/** Rows the dataset actually holds for a window — distinguishes SILENT from expired. */
function coveragePredicate(at) {
  return `['inspector-logs']
${SHARED_FILTERS}
| where _time <= datetime(${at}) and _time > datetime(${hourBefore(at)})
| summarize Rows = count()`;
}

async function run(apl, at, lookbackDays = 14) {
  const end = new Date(at);
  const start = new Date(end.getTime() - lookbackDays * 864e5);
  const res = await fetch(
    "https://api.axiom.co/v1/datasets/_apl?format=tabular",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "X-Axiom-Org-Id": ORG,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        apl,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      }),
    },
  );
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`query failed: ${JSON.stringify(body).slice(0, 300)}`);
  }
  const t = body.tables?.[0];
  const names = (t?.fields ?? []).map((f) => f.name);
  const cols = t?.columns ?? [];
  const n = cols[0]?.length ?? 0;
  return Array.from({ length: n }, (_, i) =>
    Object.fromEntries(names.map((nm, c) => [nm, cols[c][i]])),
  );
}

const CASES = [
  {
    monitor: "spike",
    label: "2026-08-06 02:00Z — the incident hour (3,705 events, 1 org)",
    at: "2026-08-06T02:00:00Z",
    expect: "FIRE",
  },
  {
    monitor: "spike",
    label: "2026-08-06 01:00Z — one hour before it started",
    at: "2026-08-06T01:00:00Z",
    expect: "SILENT",
  },
  {
    monitor: "spike",
    label: "2026-08-09 12:00Z — an ordinary Sunday",
    at: "2026-08-09T12:00:00Z",
    expect: "SILENT",
  },
  {
    // The busiest hour of the broad third-party-downtime class in the window
    // (36 events across 4 orgs). Exercised through the REAL predicate rather
    // than a hand-written approximation: this is the class that must never
    // page, since ~1,740 events across 147 orgs is the product working.
    // NOTE ON THE INSTANT: `bin(_time, 1h)` labels a bin by its START, so the
    // busiest bin (labelled 22:00) spans 22:00-23:00 and is evaluated by a
    // fixture anchored at 23:00. Anchoring at 22:00 would silently score the
    // quieter preceding hour — the coverage count is what surfaced that.
    monitor: "spike",
    label: "2026-08-11 23:00Z — busiest 'Couldn't reach' hour (36 events, 4 orgs)",
    at: "2026-08-11T23:00:00Z",
    expect: "SILENT",
  },
  {
    monitor: "novelty",
    label: "2026-08-09 12:00Z — ordinary Sunday, no new class",
    at: "2026-08-09T12:00:00Z",
    expect: "SILENT",
  },
  {
    monitor: "novelty",
    label: "2026-08-11 23:00Z — steady third-party downtime is not novelty",
    at: "2026-08-11T23:00:00Z",
    expect: "SILENT",
  },
];

const PREDICATES = { spike: spikePredicate, novelty: noveltyPredicate };

// Assert the parts of the shipped definitions that can be compared literally,
// so a definition edit that diverges from this harness is caught here rather
// than in production.
let failures = 0;
for (const [key, name] of [
  ["inspector-error-class-spike", "spike"],
  ["inspector-new-error-class", "novelty"],
]) {
  const apl = loadMonitor(key).aplQuery.join("\n");
  for (const fragment of [
    "tostring(environment) in ('prod','production')",
    "replace_regex(@'[0-9a-z]{20,}', 'ID', substring(fpSource, 0, 100))",
  ]) {
    if (!apl.includes(fragment)) {
      console.log(`FAIL  ${name} definition no longer contains: ${fragment}`);
      failures++;
    }
  }
}
if (loadMonitor("inspector-error-class-spike").aplQuery.join("\n").includes(
  "max(toint(statusCode))",
)) {
  console.log(
    "FAIL  spike definition uses window-wide max(); maxStatus must be maxif() over the recent hour",
  );
  failures++;
}

for (const c of CASES) {
  let rows;
  let coverage;
  try {
    coverage = await run(coveragePredicate(c.at), c.at);
    rows = await run(PREDICATES[c.monitor](c.at), c.at);
  } catch (err) {
    console.log(`FAIL  [${c.monitor}] ${c.label}\n      ${err.message}`);
    failures++;
    continue;
  }

  // An expired fixture yields no rows and would otherwise be scored as a
  // passing SILENT — a test that quietly stops testing anything.
  const rowsInWindow = coverage[0]?.Rows ?? 0;
  if (rowsInWindow === 0) {
    console.log(`FAIL  [${c.monitor}] ${c.label}`);
    console.log(
      "      EXPIRED: dataset holds no rows for this window (retention). Not a passing SILENT — re-anchor or remove the fixture.",
    );
    failures++;
    continue;
  }

  const got = rows.length > 0 ? "FIRE" : "SILENT";
  const ok = got === c.expect;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  [${c.monitor}] ${c.label}`);
  console.log(
    `      expected ${c.expect}, got ${got}  (${rowsInWindow} rows in window)`,
  );
  for (const r of rows.slice(0, 3)) {
    const extra =
      r.baseHourly === undefined
        ? ""
        : ` baseHourly=${Number(r.baseHourly).toFixed(2)} orgs=${r.orgs} status=${r.maxStatus}`;
    console.log(
      `      recent=${r.recent}${extra}  ${String(r.fp).slice(0, 58)}`,
    );
  }
}

console.log(
  `\n${failures === 0 ? "ALL CASES PASS" : `${failures} CASE(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);
