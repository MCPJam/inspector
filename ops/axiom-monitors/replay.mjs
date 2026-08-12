#!/usr/bin/env node
/**
 * Replay the class monitors against known history.
 *
 * A monitor is only trustworthy if it fires on the incident it was written for
 * AND stays silent on the noise it was written to ignore. Both directions are
 * asserted here. The silent direction is the one that decides whether anyone
 * keeps reading #mcpjam-alerts, so it is not optional.
 *
 * Run before changing any threshold or the fingerprint expression:
 *
 *   AXIOM_TOKEN=... AXIOM_ORG_ID=mcpjam-b35r node ops/axiom-monitors/replay.mjs
 *
 * Exits non-zero if any case regresses.
 *
 * NOTE ON WRITING CASES: express the monitor's REAL predicate, never a proxy
 * for it. An earlier version of the noise case tested an intensity heuristic
 * the monitor does not implement and reported a failure against a rule that
 * was never shipped — the test was wrong, not the monitor.
 */
const TOKEN = process.env.AXIOM_TOKEN;
const ORG = process.env.AXIOM_ORG_ID;
if (!TOKEN || !ORG) {
  console.error("✖ AXIOM_TOKEN and AXIOM_ORG_ID are required");
  process.exit(1);
}

const FP = `| extend fpSource = coalesce(tostring(errorMessage), tostring(errorCode), strcat(tostring(route), ' ', tostring(statusCode)))
| extend fp = replace_regex(@'[0-9a-z]{20,}', 'ID', substring(fpSource, 0, 100))`;

/**
 * The spike monitor's predicate, evaluated AT a past instant. The live monitor
 * uses ago(1h); replay pins the same boundaries to explicit datetimes so a
 * historical hour can be judged exactly as the monitor would have judged it.
 */
function spikeAt(at) {
  const recentFrom = new Date(new Date(at).getTime() - 3600_000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
  return `['inspector-logs']
| where event in ('http.request.failed','http.request.completed')
| where toint(statusCode) >= 400
| where _time <= datetime(${at})
${FP}
| summarize recent = countif(_time > datetime(${recentFrom})), baseline = countif(_time <= datetime(${recentFrom})), orgs = dcountif(orgId, _time > datetime(${recentFrom})), maxStatus = max(toint(statusCode)) by fp
| extend baseHourly = baseline / 335.0
| where (maxStatus >= 500 and recent > 100) or (recent >= 20 and orgs >= 3 and recent > 20 * baseHourly)
| project fp, recent, baseHourly, orgs, maxStatus
| sort by recent desc`;
}

async function run(apl, at) {
  const end = new Date(at);
  const start = new Date(end.getTime() - 14 * 864e5);
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

/**
 * Retention note: these fixtures reference dated incidents. Once a case falls
 * outside the dataset's retention it can no longer be replayed — treat a case
 * that suddenly reports "no data" as expired, not as a passing SILENT.
 */
const CASES = [
  {
    label: "2026-08-06 02:00Z — the incident hour (3,705 events, 1 org)",
    at: "2026-08-06T02:00:00Z",
    expect: "FIRE",
  },
  {
    label: "2026-08-06 01:00Z — one hour before it started",
    at: "2026-08-06T01:00:00Z",
    expect: "SILENT",
  },
  {
    label: "2026-08-09 12:00Z — an ordinary Sunday",
    at: "2026-08-09T12:00:00Z",
    expect: "SILENT",
  },
  {
    label: "2026-08-11 12:00Z — ordinary weekday traffic",
    at: "2026-08-11T12:00:00Z",
    expect: "SILENT",
  },
];

let failures = 0;

for (const c of CASES) {
  let rows;
  try {
    rows = await run(spikeAt(c.at), c.at);
  } catch (err) {
    console.log(`FAIL  ${c.label}\n      ${err.message}`);
    failures++;
    continue;
  }
  const got = rows.length > 0 ? "FIRE" : "SILENT";
  const ok = got === c.expect;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.label}`);
  console.log(`      expected ${c.expect}, got ${got}`);
  for (const r of rows.slice(0, 3)) {
    console.log(
      `      recent=${r.recent} baseHourly=${Number(r.baseHourly).toFixed(2)} orgs=${r.orgs} status=${r.maxStatus}  ${String(r.fp).slice(0, 60)}`,
    );
  }
}

// Broad third-party downtime must never page: ~1,740 events across 147 orgs
// over 30 days is the product working, not an outage. Evaluated against both
// of the spike monitor's real clauses, per hour.
const noise = await run(
  `['inspector-logs']
| where event == 'http.request.failed'
| where errorMessage startswith "Couldn't reach the MCP server"
| summarize recent = count(), orgs = dcount(orgId), maxStatus = max(toint(statusCode)) by bin(_time, 1h)
| extend baseHourly = 2.4
| where (maxStatus >= 500 and recent > 100) or (recent >= 20 and orgs >= 3 and recent > 20 * baseHourly)
| summarize Count = count()`,
  new Date().toISOString(),
);
const noiseHours = noise[0]?.Count ?? 0;
if (noiseHours !== 0) failures++;
console.log(
  `${noiseHours === 0 ? "PASS" : "FAIL"}  broad third-party downtime never trips the spike monitor`,
);
console.log(`      qualifying hours in 14d: ${noiseHours} (must be 0)`);

console.log(
  `\n${failures === 0 ? "ALL CASES PASS" : `${failures} CASE(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);
