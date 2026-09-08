---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

`passCriteria.minimumPassRate` is a bounded percent, and a v2 suite stops reporting a dead one

`passCriteria: { minimumPassRate: z.number() }` had no bounds at four write
sites, and `github-checks-worker.ts` compares it as a percent
(`Math.round(passed / total * 100) >= minimumPassRate`). So
`minimumPassRate: 0.8` — the natural thing to send for a developer who wrote
`passThreshold: 0.8` as a fraction two fields earlier — was accepted, meant
0.8%, and produced a CI gate that could never fail. `8000` was accepted too,
and could never pass.

All four sites now bound it to [0, 100], and a fraction-looking value below 1
is rejected with a message naming both units rather than silently
reinterpreted — reinterpreting would move the bar on every policy already
stored. `minimumPassRatePercent` is accepted as the canonical spelling,
following the SDK's own `*Percent` convention; `minimumPassRate` remains as
the deprecated alias and is still what gets stored.

Separately: upgrading a suite to verdict policy 2 adds `verdictPolicyDefaults`
and cannot clear the legacy `defaultPassCriteria` column, so a v2 suite carried
a dead percent beside its live fraction and the API reported both.
`settings.minimumAccuracy` is now `null` on a v2 suite, and
`mcpjam cloud eval export` reads the v2 `passThreshold` directly instead of
converting the dead percent into a suite file.
