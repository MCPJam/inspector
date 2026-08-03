---
"@mcpjam/inspector": minor
---

Replace the chatbox Insights goals-by-outcome grid with a four-stage session
flow: goal → behavior → outcome → sentiment.

The grid answered "how do goals break down by outcome". The flow answers "where
do sessions go wrong", and it can show the two stages the table had no column
for. Behavior is read straight off the transcript and outcome is forced to
`errored` for a session whose tool call failed without recovering, so the legend
marks each stage as deterministic or model-inferred rather than presenting all
four as equally trustworthy.

Selection is generalized rather than special-cased. The old model could only
express a goal × outcome cell, so a click on any other stage had nothing to
select with and the drill-down — which required a cluster — would not run.
`InsightsSelection` covers any subset of the four stages: a cell is now just the
`{goal, outcome}` case, a node is one key, and a link is two, ANDed. A key set
to `null` selects that stage's unlabeled node and an absent key leaves the stage
out of the selection, because "no value recorded" and "not part of this filter"
are different queries and collapsing them would silently widen the filter past
what was clicked.

Discordant outcome/sentiment links are colored and named in the legend rather
than relying on color alone — the two stages correlate strongly, so the thick
diagonal carries little information and the sessions worth opening are the ones
where the task result and the user's reaction disagree.

Requires a backend at signals version 2. A chatbox last analyzed before
sentiment existed still renders its first three stages and offers a rebuild,
rather than being replaced by an empty state.
