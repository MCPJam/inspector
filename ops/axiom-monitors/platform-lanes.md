# Platform lanes: MCPJam-paid included AI

Included generation and analyses — eval case generation, markdown import,
persona and journey drafts, run / window / wave insights, findings, session
clustering, cross-host and direct-chat quality, metadata attribution,
description proposals, readiness observations — are paid by MCPJam, not the
customer. Each one holds against a **lane** before it calls a model:

| Budget | Size | Resets |
| --- | --- | --- |
| Per organization, per feature | $25 | 00:00 UTC |
| Platform backstop, per feature | $250 | 00:00 UTC |

The lane code is `mcpjam-backend` `convex/billing/insightExecutionUsage.ts`;
the list of features is `PLATFORM_PAID_INTERNAL_LLM` in
`convex/lib/pricing/internalLlmPolicy.ts`.

## The events

| Event | When | Read it for |
| --- | --- | --- |
| `platform_lane_admitted` | a hold was taken (one per provider attempt) | `heldMicros` |
| `platform_lane_refused` | a hold was refused | `reason`, `scope` (`organization` / `platform`), `budgetExhausted` |
| `platform_lane_settled` | a hold closed | `actualMicros` — **attempt spend** |
| `insight_reservation_failed` | a hold could not be written | the guard failing closed |
| `insight_lane_settle_failed` | a settle threw; the hold stands until 00:00 UTC | stranded holds |
| `platform_lane_scan_bounded` | a lane scan hit 8,000 rows and refused | the guard failing closed |
| `platform_lane_snapshot` | every 10 min, per feature | `spentMicros`, `outstandingMicros`, `staleMicros`, `maxOrgId` |
| `platform_lane_snapshot_completed` | every 10 min | heartbeat |
| `llm_usage_record_created` / `llm_usage_cost_updated` | a usage row / its late cost | `funding: "platform"` — **usage spend** |

`eventKey` is stable per attempt, so a duplicated log line can be dropped. An
incomplete snapshot has `complete: false` and no totals.

**Attempt spend vs usage spend.** Usage rows dedupe on the logical job id, so
a retried provider attempt is visible only in `platform_lane_settled`. The
monitors use attempt spend. Never add the two: that counts the same money
twice. Attempt spend above usage spend is normal; the gap is retries and calls
whose cost never arrived.

## Monitors

| Key | Tier | Fires on |
| --- | --- | --- |
| `platform-lane-spend-hourly-warn` | WARN | attempt spend > $10 in the last hour |
| `platform-lane-spend-hourly-page` | PAGE | attempt spend > $25 in the last hour |
| `platform-lane-budget-refusals-hourly` | WARN | > 20 distinct attempts refused on a spent budget in an hour |
| `platform-lane-guard-failures` | PAGE | any reservation failure, settle failure or scan bound in 5 minutes |
| `platform-lane-stale-holds` | WARN | > $5 of holds unsettled past their stale age, latest complete snapshot |
| `platform-lane-snapshot-deadman` | WARN | no snapshot heartbeat in 30 minutes |
| `platform-lane-customer-billed` | PAGE | a usage row for an included feature debited a customer |

Every threshold is **provisional**: no traffic existed when they were set.
Re-baseline after seven days of data (queries below) and move the number with
the measurement in the definition's `rationale`. They do not change any
admission budget.

## Triage

1. **Spend page.** Run *attempt spend by feature and org*. One org and one
   feature is a runaway caller, and its $25 lane already caps it. Many orgs on
   one feature is a release or a loop in that feature.
2. **Refusals.** Run *refusal reasons*. `scope: organization` is one org at its
   lane — expected. `scope: platform` is the backstop, and every customer has
   lost the feature until 00:00 UTC; decide whether to raise
   `PLATFORM_DAILY_CAP_MICROS` from the spend-by-org numbers, not the refusal count.
3. **Guard failures.** Read the `error` on `insight_reservation_failed` /
   `insight_lane_settle_failed`. A scan bound means a producer is taking far more,
   far smaller holds than the lane was sized for.
4. **Stale holds.** Run *stalled holds*. `cost_unknown` holds are deliberate
   (the call may have spent money) and clear at 00:00 UTC. Several dollars of
   them on one feature is a broken settle path in that feature.
5. **Customer billed.** Take the `generationId` and `route`: either a route
   stopped forwarding `billingMode`, or the deployed backend is older than the
   feature's flip.

## Drill-down queries

`platform-lane-queries.mjs` exports them, ready to paste:

- `attemptSpendByFeatureOrg` — attempt spend, deduped on `eventKey`
- `usageSpendByFeatureModelOrg` — usage spend at each record's latest cost
- `refusalReasons`
- `expensiveCallers` — top orgs by attempt spend
- `unknownCosts` — unpriced holds and unpriced usage rows
- `stalledHolds` — per feature, from recent complete snapshots

Re-baseline a threshold:

```
['mcpjam-backend-prod']
| where tostring(['data.message']) contains '"event":"platform_lane_settled"'
| extend msg=tostring(['data.message'])
| extend eventKey=extract('"eventKey":"([^"]+)"', 1, msg), actualMicros=tolong(extract('"actualMicros":([0-9]+)', 1, msg))
| summarize actualMicros=max(actualMicros), t=min(_time) by eventKey
| summarize Usd=sum(actualMicros)/1000000.0 by bin(t, 1h)
| summarize max(Usd), percentile(Usd, 95)
```

## Dashboard

Infra Overview (`infra-overview`) carries an "included AI" row directly under
the E2B row: spend, refusals, guard failures, customer-billed rows, stale holds,
snapshot age, spend by feature, top orgs, and refusals by reason. The tiles
mirror the monitors above. Infra Overview is edited through the API, so the row
is owned by `dashboard-platform-lanes.mjs`, which touches only charts whose id
starts with `platform-lane-`:

```bash
node ops/axiom-monitors/dashboard-platform-lanes.mjs          # plan: validates every query
node ops/axiom-monitors/dashboard-platform-lanes.mjs --apply  # write (backs up first)
```

## Activation

**Status (2026-09-17):** the dashboard row and six monitors are live —
`customer-billed`, `guard-failures`, `spend-hourly-page`, `spend-hourly-warn`,
`budget-refusals-hourly`, `stale-holds`. With no source events they read 0 and
stay quiet. `platform-lane-snapshot-deadman` is NOT applied: it would alert
until backend #1470 is in production. Apply it (step 3's last line) once the
"Minutes since last lane snapshot" tile shows a number.

The events ship with mcpjam-backend #1463 and #1470. Until both are in
**production**, every query returns no rows: the Above monitors stay silent and
the deadman would alert falsely.

1. Confirm the backend deploy:
   `gh run list --repo MCPJam/mcpjam-backend --workflow "Deploy Production" --limit 1`
   must show a commit at or after #1470.
2. Confirm evidence exists — this must print `OBSERVED` for every key, never
   `INSUFFICIENT EVIDENCE`:
   ```bash
   AXIOM_TOKEN=... AXIOM_ORG_ID=mcpjam-b35r node ops/axiom-monitors/replay.mjs --platform-lanes
   ```
3. Plan, then apply one at a time (`AXIOM_NOTIFIER_LLM_SAFETY=ox9MvFUsrwZtx9HfxM`):
   ```bash
   node ops/axiom-monitors/apply.mjs --only platform-lane-customer-billed
   node ops/axiom-monitors/apply.mjs --only platform-lane-customer-billed --apply
   node ops/axiom-monitors/apply.mjs --only platform-lane-guard-failures --apply
   node ops/axiom-monitors/apply.mjs --only platform-lane-spend-hourly-page --apply
   node ops/axiom-monitors/apply.mjs --only platform-lane-spend-hourly-warn --apply
   node ops/axiom-monitors/apply.mjs --only platform-lane-budget-refusals-hourly --apply
   node ops/axiom-monitors/apply.mjs --only platform-lane-stale-holds --apply
   # Last, and only once a snapshot heartbeat has been seen in Axiom:
   node ops/axiom-monitors/apply.mjs --only platform-lane-snapshot-deadman --apply
   ```
4. Rollback any one: `node ops/axiom-monitors/apply.mjs --delete <key> --apply`.
