---
"@mcpjam/inspector": patch
---

Suite settings can configure the suite again

The Grading tab listed 21 checkboxes under "Checks by stage" and said "All
checks are on by default". Their ids named checks the product does not
implement, nothing in the server, the SDK or the backend read any of them, and
the field the toggles wrote is not one `applySuiteSettings` declares — so
saving raised a Convex argument error that took **every other setting edited in
the same session down with it**. That section is gone.

In its place, the controls that were unmounted: the scorer table in
user-value-chain order with Gate/Warn/Report and the Add-scorer library, the
judge card with its model, threshold, auto-run, gating role, rubric and
backtest, verdict validity, the one-way v1→v2 upgrade, and the computer image.
Every one of them still reached the backend and still decided what a run does;
unmounting them did not remove the settings, only the way to see and change
them. A suite authored through the CLI could also block its own Save with "A
check is incomplete" and offer a Fix button that led to an editor no longer on
the page.

A deployment without the model matrix now keeps an editor for the legacy
clients and server group, instead of a disabled matrix and no fallback.
A quality gate configured through CI shows its p95, deterministic-regression
and gating-error conditions read-only, rather than being invisible until the
baseline warning offers to clear them.

The reason all of this shipped green is that every settings ratchet rendered a
_component_ and none asserted what the _page_ mounts, and a
`settingsPage: "hidden"` marker let twelve rows opt out of the render-parity
check in the same commit that removed them. There is now a mount-level test,
the marker is a closed three-key list pinned by its own test, and an
`excluded:` reason can no longer claim a backend save path this repo cannot
verify — which is how the false one shipped.
