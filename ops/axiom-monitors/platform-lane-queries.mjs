/**
 * Drill-down queries for MCPJam-paid included AI (platform lanes).
 *
 * Read-only APL, paste into Axiom as-is. The monitors in `monitors/platform-lane-*`
 * page; these answer "where is it going". See `platform-lanes.md`.
 *
 * Two money sources, never added together:
 * - ATTEMPT spend: `platform_lane_settled.actualMicros`, once per provider
 *   attempt (retries included), deduplicated on `eventKey`.
 * - USAGE spend: `llm_usage_record_created.totalCost` for `funding:"platform"`
 *   rows plus the signed `llm_usage_cost_updated.costDelta` corrections. One
 *   row per LOGICAL job, so retried attempts are invisible here.
 * Attempt spend ≥ usage spend is normal; the gap is retries and unpriced calls.
 */

const DATASET = "['mcpjam-backend-prod']";
const EVENTS = "| where tostring(['data.message']) contains '[mcpjam_operational_event]'\n| extend msg=tostring(['data.message'])";

/** A number as the backend logs it: integer micros, or a dollar amount that may be tiny and in exponent form. */
export const SIGNED_DOLLARS = "(-?[0-9]+(?:[.][0-9]+)?(?:[eE][+-]?[0-9]+)?)";
export const MICROS = "([0-9]+)";

const field = (name, pattern = '"([^"]+)"') =>
  `extract('"${name}":${pattern}', 1, msg)`;

export const QUERIES = {
  /** Attempt spend by feature and org, last 24h. */
  attemptSpendByFeatureOrg: `${DATASET}
| where _sysTime >= ago(24h)
${EVENTS}
| where msg contains '"event":"platform_lane_settled"'
| extend eventKey=${field("eventKey")}, feature=${field("feature")}, org=${field("organizationId")}, actualMicros=tolong(${field("actualMicros", MICROS)})
| summarize actualMicros=max(actualMicros) by eventKey, feature, org
| summarize Usd=round(sum(actualMicros) / 1000000.0, 4), Attempts=count() by feature, org
| sort by Usd desc`,

  /**
   * Usage spend by feature, model and org, last 24h.
   *
   * Each usage record counts ONCE at its latest known cost: \`totalCost\` on
   * both the created and the cost-updated event is the row's cost at that
   * moment, so taking the latest per \`usageRecordId\` applies a delayed cost
   * and any correction exactly once, and a duplicated log line changes
   * nothing. (\`costDelta\` is for windows that start after a row was created.)
   */
  usageSpendByFeatureModelOrg: `${DATASET}
| where _sysTime >= ago(24h)
${EVENTS}
| extend event=${field("event")}, funding=${field("funding")}, feature=${field("feature")}, modelId=${field("modelId")}, org=${field("organizationId")}, usageRecordId=${field("usageRecordId")}
| where funding == 'platform' and event in ('llm_usage_record_created', 'llm_usage_cost_updated')
| extend totalCost=todouble(${field("totalCost", SIGNED_DOLLARS)}), costDelta=todouble(${field("costDelta", SIGNED_DOLLARS)})
| summarize arg_max(_time, totalCost, feature, modelId, org) by usageRecordId
| summarize Usd=round(sum(totalCost), 4), Rows=count() by feature, modelId, org
| sort by Usd desc`,

  /** Why included calls were refused, last 24h. */
  refusalReasons: `${DATASET}
| where _sysTime >= ago(24h)
${EVENTS}
| where msg contains '"event":"platform_lane_refused"'
| extend eventKey=${field("eventKey")}, feature=${field("feature")}, reason=${field("reason")}, scope=${field("scope")}, org=${field("organizationId")}
| summarize Refusals=dcount(eventKey) by feature, reason, scope, org
| sort by Refusals desc`,

  /** The orgs taking the most included AI, by attempt spend, last 24h. */
  expensiveCallers: `${DATASET}
| where _sysTime >= ago(24h)
${EVENTS}
| where msg contains '"event":"platform_lane_settled"'
| extend eventKey=${field("eventKey")}, org=${field("organizationId")}, actualMicros=tolong(${field("actualMicros", MICROS)})
| summarize actualMicros=max(actualMicros) by eventKey, org
| summarize Usd=round(sum(actualMicros) / 1000000.0, 4), Attempts=count() by org
| top 20 by Usd desc`,

  /** Calls whose cost never arrived: held-unpriced holds and unpriced usage rows, last 24h. */
  unknownCosts: `${DATASET}
| where _sysTime >= ago(24h)
${EVENTS}
| extend event=${field("event")}, feature=${field("feature")}, costStatus=${field("costStatus")}, funding=${field("funding")}
| where event == 'insight_reservation_held_unpriced' or (event == 'llm_usage_record_created' and funding == 'platform' and costStatus == 'not_reported')
| summarize n=count() by event, feature
| sort by n desc`,

  /**
   * Holds that have outlived their calls, per feature, over the last three
   * snapshots. MAX, not a sum: each snapshot is a full reading of the lane, so
   * adding them would triple it.
   */
  stalledHolds: `${DATASET}
| where _sysTime >= ago(30m)
${EVENTS}
| where msg contains '"event":"platform_lane_snapshot"' and msg contains '"complete":true'
| extend feature=${field("feature")}, staleRows=tolong(${field("staleRows", MICROS)}), staleMicros=tolong(${field("staleMicros", MICROS)}), outstandingMicros=tolong(${field("outstandingMicros", MICROS)}), oldestAgeMs=tolong(${field("oldestOutstandingAgeMs", MICROS)}), maxOrgMicros=tolong(${field("maxOrgUsedMicros", MICROS)}), maxOrg=${field("maxOrgId")}
| summarize staleRows=max(staleRows), staleMicros=max(staleMicros), outstandingMicros=max(outstandingMicros), oldestAgeMs=max(oldestAgeMs), nearestCap=arg_max(maxOrgMicros, maxOrg) by feature
| sort by staleMicros desc`,
};
