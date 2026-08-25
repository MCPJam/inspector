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
`eval gate`, `eval compare`, `server diff`, and `tools call`. `--out` writes the
HTML atomically; when both `--reporter html` and `--out` are given, the report
is written to the file and to stdout, same as the other reporters. Commands that
report a different shape (`ConformanceReport` — `apps conformance`,
`protocol conformance`, `oauth conformance`, `readiness`, `conformance run`,
`tasks conformance`) now parse `--reporter html` as syntactically valid, since
the parser is shared, but reject it at render time with a clear usage error:
those surfaces have no HTML renderer yet, and building one is out of scope for
this change.

Also fixes `eval compare --out`, which wrote the file through the raw JSON
path regardless of `--reporter` — so `--reporter junit-xml --out report.xml`
(and now `--reporter html --out report.html`) produced a file in the wrong
format, unlike `eval run`/`eval gate`. It now writes whatever `--reporter`
selected, defaulting to `json-summary` same as before.
