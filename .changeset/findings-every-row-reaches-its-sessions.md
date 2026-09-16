---
"@mcpjam/inspector": patch
---

Every finding on a swarm stage can now reach the sessions it is about.

A stage that failed two rubric checks over the same session showed the first one with its session list underneath and the second as plain text with nothing to click. That is what "none of the sessions link to anything" looked like on the report that opened this: `Rubric check "Final message non-empty" failed` had a session under it, and `Rubric check "Calls create_view" failed`, directly below, had none.

The cause was a rule written for the empty-stage footer — one session is a link, not something to expand — reused for the evidence rows, where it collapses to "only row 0 renders the list". With several findings over one session, every row after the first lost its only way in.

Several findings now earn the toggle even over a single session. A lone finding over a lone session still shows its session directly, with no toggle, and the empty-stage footer is untouched: it only renders when a stage has no evidence at all.
