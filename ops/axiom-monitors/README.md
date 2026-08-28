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

## Replay before changing thresholds

```bash
AXIOM_TOKEN=... AXIOM_ORG_ID=mcpjam-b35r node ops/axiom-monitors/replay.mjs
```

Asserts both directions against real history: the class monitors must **fire**
on the 2026-08-06 incident and stay **silent** on ordinary traffic and on broad
third-party downtime. Exits non-zero on regression. Run it after any threshold
or fingerprint change — a monitor that stops firing on 08-06 has been broken,
and one that starts firing on the 147-org "Couldn't reach" class has become
noise.

When writing a case, express the monitor's *real* predicate rather than a proxy
for it. An earlier noise case tested an intensity heuristic the monitor does not
implement and reported a failure against a rule that was never shipped.

Retention caveat: cases reference dated incidents. If one starts reporting no
data, treat it as expired rather than as a passing SILENT.

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

## PAGE vs WARN notifiers (decided 2026-08-13)

The plan requires PAGE and WARN to be **mechanically** different — if both land
in `#mcpjam-alerts` with identical treatment, the tiers are names, not tiers.

Resolution: a second Slack notifier `#mcpjam-alerts (warn)`
(`Q3BO52GfVxE82N9tWH`) was created against the same channel webhook, and
`AXIOM_NOTIFIER_MCPJAM_ALERTS_WARN` points at it. This separates the tier
*identity* now — every WARN monitor is wired to its own notifier object — so
upgrading either tier later (a mention-carrying webhook for PAGE, a quieter
channel for WARN) is a notifier-config/env-var change with zero monitor edits.

Deliberately deferred, not forgotten: the message *treatment* is still
identical, because the PAGE notifier (`jnWZGoVFRcvyTdUjBe`, plain webhook, no
mention) never had page semantics either. Giving PAGE an on-call mention needs
a Slack-side webhook or workflow with the mention baked in; when that exists,
point `AXIOM_NOTIFIER_MCPJAM_ALERTS_PAGE` at it and re-apply.

## Verifying delivery

Do **not** test by lowering a production monitor's threshold — it posts
repeatedly to a real channel and risks being left lowered.

Instead create a disposable definition against a controlled dataset and the
real notifier, confirm one trigger and one resolution, then
`--delete` that exact key. While doing it, record whether the Slack payload
includes grouped/projected columns, because the per-class monitors (M3/M4/M6)
depend on knowing the answer: all 55 pre-existing monitors collapse to a bare
scalar in Slack, so their drill-down queries may have to carry the diagnosis.

**Run on 2026-08-14 against `#mcpjam-alerts (warn)`:** disposable grouped
Threshold monitor (`summarize Count = count() by grp`, `notifyByGroup: true`,
15m range / 1m interval) over a disposable `monitor-delivery-test` dataset.
One trigger at 03:07:22Z, one resolution at 03:22:24Z when the rows aged out
of the window — `resolvable: true` produced exactly one open and one close,
no repeats. Monitor and dataset were deleted afterward. Whether the Slack
message body rendered the `grp` group value could not be captured
programmatically (webhooks are write-only); check the 03:07Z/03:22Z posts in
the channel before relying on grouped columns in any alert payload — until
someone records that observation here, assume the pre-existing behavior
(bare scalar) and keep the drill-down queries in the descriptions.

## Fields this Axiom deployment may ignore

`notifyByGroup`, `alertOnNoData`, and `notifyEveryRun` are sent but the API
omits them from its response when they equal its defaults. After `--apply` the
script reports any field the response did not echo.

Measured when the PAGE monitors were first applied: **`resolvable` is
persisted** on all three (it governs repeat notifications, so this is the one
that mattered), and **`alertOnNoData: true` is persisted** on the deadman where
it is non-default. The omissions are therefore default-elision, not unsupported
fields.

Because a field the API omits is not comparable, `diffFields` skips it. Without
that, every re-run reported `update` for those three keys and buried real drift
in permanent noise. The trade-off is that drift in exactly those fields cannot
be detected — the API declines to report them — while everything it does echo,
including `resolvable`, diffs normally.
