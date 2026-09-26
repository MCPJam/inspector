---
"@mcpjam/inspector": patch
"@mcpjam/sdk": minor
---

Swarms now say when a session never ran, and why, on every tab that shows it.

A session whose attempt ended before it recorded a single message tested nothing about the server under test. Findings already said "Not run", but the Sessions tab showed an ordinary row with no preview, its detail pane hedged "May not have run" under a judge that tried to grade it, the Findings drawer listed it as "Session 1 (no preview)", and Insights drew the wave as 100% "Not analyzed". None of them said what actually happened, which is how a single endpoint returning 400 on every turn read for three days as "the server has friction at connection".

- **Sessions detail**: "This session didn't run", with the refusal the attempt recorded, worded the way the Run tab words it. No judge request, and no promote copy for a conversation that does not exist.
- **Sessions list and Findings drawer**: a "Didn't run" mark instead of an empty preview.
- **Findings summary**: a "Why sessions didn't run" line naming the most common refusal, beside the existing count.
- **Insights**: "These sessions didn't run" instead of waiting on or analyzing sessions that have nothing to read, and a one-line count beside a drawn flow when only some of them did.

`@mcpjam/sdk` gains `swarmSessionNeverRan(lifecycle, messageCount)`, the one rule every surface uses: the attempt ended and the session recorded no message. The backend mirrors it.

Deploy order: the backend change ships first (`getSession` error fields, `runAttemptStatus` on the swarm drilldown, `journeyRuns:listRunLaunchFailures`, and `notRun` in the insights summary). Against an older backend every surface keeps working: the detail pane falls back to status-only wording, the drawer keeps its old row, the Findings reason line is omitted, and Insights reads the backend's existing empty-transcript skips.
