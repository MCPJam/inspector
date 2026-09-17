---
"@mcpjam/inspector": patch
---

Every finding on a stage can now reach the sessions it is about, in Findings on a Swarm run and in Findings on a User Testing scenario.

A stage that failed two rubric checks over the same session showed the first one with its session list underneath and the second as plain text with nothing to click. That is what "none of the sessions link to anything" looked like on the report that opened this: `Rubric check "Final message non-empty" failed` had a session under it, and `Rubric check "Calls create_view" failed`, directly below, had none.

The cause was a rule written for the empty-stage footer — one session is a link rather than something to expand — reused for the evidence rows, where it collapses to "only row 0 renders the list". With several findings over one session, every row after the first lost its only way in.

Several findings now earn the toggle even over a single session. A lone finding over a lone session still shows its session directly, with no toggle, and the empty-stage footer is untouched: it only renders when a stage has no evidence at all.

One visible change where the list used to be permanent. With several findings over one session, the first row's session list was rendered with no control to collapse it. It is now a toggle that starts open, so the first paint is unchanged, and because the panel opens one finding at a time, opening the second finding closes the first.
