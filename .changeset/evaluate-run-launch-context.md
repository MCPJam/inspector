---
"@mcpjam/inspector": patch
---

The Evaluate run header says what the run launched against, and the grading pair is always visible.

**A host chip is not an environment.** The run header showed one chip reading
"Claude" and nothing else: not the model, not the MCP servers, not the
environment revision. `RunLaunchContext` replaces it with labelled facts —
client or environment, model, servers, revision — so none of them can be read as
leftover chrome, and the model is recovered from the run's iterations when the
list projection omitted `effectiveModelId`. `RunContextChip`'s host branch gains
the same model attribution it already gave the environment branch.

**The verdict's own evidence was buried in the sentence.** Expected against
observed lived inside `RunVerdictHero` as a comma-joined line that only rendered
for a `brokeAt` verdict. It moves out into `RunGradingPeek` — an always-visible
"Graded against" pair of lists, with every expected call that was never observed
marked in place rather than left for the reader to diff by eye. The list itself
is now `EvaluateToolList`, shared with the case body so one miss reads the same
wherever it surfaces.

**"Prompt to improve" and "Open failing trace" move to the page header.** They
were inline actions on the hero, scrolling away with it. `EvaluateRunPage` lifts
them into its header through context, and the hero drops its copies when the
header has them. Case rows lead with the disclosure chevron instead of a dashed
placeholder mark for cases that never had a verdict read.
