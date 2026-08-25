---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Add a minimal HTML reporter for the structured run report contract (Evals v2, Lane E, step E3).

`@mcpjam/sdk` exports `renderStructuredRunHtml(report)`, a sibling of
`renderStructuredRunJUnitXml` that renders the same redacted `StructuredRunReport`
into a single self-contained HTML file: inline `<style>`, no external scripts,
fonts, images, or stylesheets, so it opens correctly from disk (`file://`) with
no network. Like the JSON and JUnit renderers, redaction runs first — `--out`
and `--reporter` are two terminals for the same artifact, and rendering from the
raw report would reopen a gap that already shipped once. Content is a decision
summary plus failures only: header (kind, verdict, duration), summary rollups
(by category / classification), the decision summary when present (verdict,
pass rate with denominators, per-case first-failed-stage, expected vs. observed,
evidence, next action), and failed cases (title, category, error, details).
`inconclusive` (and the decision summary's `incomplete`) render with a neutral
amber badge — never green, never red — because an unmeasured run is not the
same claim as a measured failure. The paid HTML tiers (traces, parity, history)
are not included.

`@mcpjam/cli`'s `--reporter` flag accepts `html` alongside `json-summary` and
`junit-xml` everywhere the flag writes a `StructuredRunReport` — `eval run`,
`eval gate`, `eval compare`, `server diff`, and `tools call`.

For `eval run`, `eval gate`, and `eval compare`, `--out` writes whatever
`--reporter` selected, atomically, to the file — the same content as stdout.
`server diff --out` is the one exception: it has its own, unrelated,
pre-existing contract — it always writes the **raw** diff JSON (the full
change list, not the reporter's summarized cases), regardless of
`--reporter`, same as before this change. `--reporter` on `server diff`
governs stdout only. `tools call` has no `--out` at all — `--reporter`
there is stdout-only too, same as `--debug-out`'s separate, unrelated
artifact.

Commands that report a different shape (`ConformanceReport` — `apps
conformance`, `protocol conformance`, `oauth conformance`, `readiness`,
`conformance run`, `tasks conformance`) now parse `--reporter html` as
syntactically valid, since the parser is shared, but reject it at render
time with a clear usage error: those surfaces have no HTML renderer yet,
and building one is out of scope for this change.

Also fixes `eval compare --out`, which wrote the file through the raw JSON
path regardless of `--reporter` — so `--reporter junit-xml --out report.xml`
(and now `--reporter html --out report.html`) produced a file in the wrong
format, unlike `eval run`/`eval gate`. It now writes whatever `--reporter`
selected, defaulting to `json-summary` same as before.

And fixes two more spots in the eval-gate path that made an unmeasured gate
render the same red as a measured regression. `buildEvalRunReport` and
`buildRunCompareReport` now carry an explicit `verdict` for gate/compare
reports (new `gateOutcomeVerdict` export in `@mcpjam/sdk`, mapping the gate's
own `incomplete` outcome to `inconclusive` — never `failed`) instead of
leaving it unset or inferring it from the underlying run, which is a
different question from whether the gate itself could be evaluated. And
`eval gate`'s network/auth/timeout catch path now honors `--reporter`/
`--out` instead of always writing raw JSON to stdout and never touching
`--out` — matching every other reporting path.
