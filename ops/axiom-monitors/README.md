# Axiom monitors (versioned)

The JSON in `monitors/` is the source of truth for the Axiom monitors this repo
owns. `apply.mjs` reconciles Axiom to match it.

Before this existed, all 55 monitors lived only in the Axiom UI: unreviewable,
undiffable, and impossible to recreate. Definitions here are code-reviewed like
anything else.

## Usage

```bash
node ops/axiom-monitors/apply.mjs                 # plan (default, read-only)
node ops/axiom-monitors/apply.mjs --apply         # write
node ops/axiom-monitors/apply.mjs --only <key>    # restrict to one definition
node ops/axiom-monitors/apply.mjs --delete <key>  # delete exactly that managed monitor
```

Plan mode runs every query read-only against the real API and asserts it
produces the declared `columnName`. A monitor whose APL does not compile, or
whose query cannot produce the column the threshold reads, is never written.

## Environment

| Variable | Purpose |
| --- | --- |
| `AXIOM_TOKEN` | API token. Never committed; redacted from all output. |
| `AXIOM_ORG_ID` | Monitors are org-scoped (`mcpjam-b35r`). |
| `AXIOM_NOTIFIER_<KEY>` | One per logical notifier a definition references. |

Notifier IDs are org-specific, so definitions reference a **logical key**
(`mcpjam-alerts-page`) and the script resolves it from
`AXIOM_NOTIFIER_MCPJAM_ALERTS_PAGE` at apply time. An unresolved notifier is a
hard failure, never a default — a monitor wired to nothing looks healthy
forever, which is the exact failure this work exists to fix.

## Ownership and safety

Ownership is claimed by a marker appended to the monitor description:

```
[managed: ops/axiom-monitors/<key>.json — edit the file, not this monitor]
```

- Monitors without the marker are **never** modified or deleted. If a
  definition's name collides with an unmanaged monitor, the script refuses and
  tells you, rather than adopting it.
- Updates are a full-object `PUT` merged onto the current remote object. The v2
  API clears fields omitted from the body, so a partial PUT would null
  everything unlisted.
- `--delete` requires the exact key and only ever removes a managed monitor.
- Re-running with no definition change is a no-op.

## Open decision before first apply: PAGE vs WARN notifiers

The plan requires PAGE and WARN to be **mechanically** different — if both land
in `#mcpjam-alerts` with identical treatment, the tiers are names, not tiers.

Today the org has exactly two notifiers: `#mcpjam-alerts`
(`jnWZGoVFRcvyTdUjBe`) and `MCPJam LLM Safety` (`ox9MvFUsrwZtx9HfxM`). There is
no separate WARN destination, so `mcpjam-alerts-warn` currently has nowhere
correct to point. Resolve one of these before applying:

1. Create a second Slack notifier that posts without an on-call mention, and
   point `AXIOM_NOTIFIER_MCPJAM_ALERTS_WARN` at it. (Needs Slack admin.)
2. Point both keys at `#mcpjam-alerts` and accept that the tier distinction is
   only visible in the message text.

Option 1 is what the plan assumes.

## Verifying delivery

Do **not** test by lowering a production monitor's threshold — it posts
repeatedly to a real channel and risks being left lowered.

Instead create a disposable definition against a controlled dataset and the
real notifier, confirm one trigger and one resolution, then
`--delete` that exact key. While doing it, record whether the Slack payload
includes grouped/projected columns, because the per-class monitors (M3/M4/M6)
depend on knowing the answer: all 55 pre-existing monitors collapse to a bare
scalar in Slack, so their drill-down queries may have to carry the diagnosis.

## Fields this Axiom deployment may ignore

`notifyByGroup`, `alertOnNoData`, and `notifyEveryRun` are sent but do not
appear in the current API's monitor payload. After `--apply` the script reports
any field the API did not persist. Treat such a report as real: `resolvable`
silently dropped would turn a day-long incident into repeated notifications.
