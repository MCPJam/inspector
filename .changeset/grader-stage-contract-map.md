---
"@mcpjam/sdk": minor
---

The contract now says which stage of the chain each grader measures

The six-stage user-value chain has always been able to answer "where did this run stop being good?" for a single trial. What nothing could answer was the same question about a suite's SETTINGS: given this configuration, which stages does it actually measure, and which does it leave unchecked? The routing existed, but it lived inside the stage analyzer, reachable only by running a trial through it.

`PREDICATE_STAGE`, `GRADER_STAGE` and `PREDICATE_KINDS` export that routing directly, so a settings surface can group graders by what they measure instead of by how they happen to be implemented.

- **The analyzer's own routing is now derived from the map, not restated beside it.** That is the point of the change rather than a tidy-up. Two hand-kept copies of the same fact are one edit away from a suite that renders a grader under "selection" while the analyzer files its failures under "user value" — a disagreement neither copy is wrong enough to fail a test for. A new test asserts the analyzer routes exactly the three predicate kinds it routed before, so the derivation cannot quietly widen or narrow.
- **`PREDICATE_KINDS` is derived from the authoring schema.** A hand-written list is a list that misses the next predicate someone adds, and a predicate missing from the map is a grader a settings page cannot place — which renders as a stage that looks unmeasured when it is not. Totality is tested in both directions.
- **`toolCalledWith` is mapped to `selection` and is still matcher-graded.** The map records what an author was measuring; the analyzer still routes the kind through `expectedToolCalls`, because re-reading its point-in-time predicate row would let a raw residual contradict the adjudicated verdict. `isSelectionStagePredicateKind` (the map's question) and `isSelectionPredicateKind` (the analyzer's) deliberately disagree on this one kind, and a test pins that.
- **`GRADER_PRESENTATION_GROUP` carries no analytical weight.** Token and turn ceilings read better beside each other than beside "did the answer contain the right thing", but they are still filed where the analyzer files them. A test pins that the grouping never redefines a stage.

`STAGE_ANALYZER_VERSION` stays at 8. Nothing about where a failure is attributed has changed, so this is a refactor rather than a re-derivation. The docblock names the kinds that are future bump candidates — `noToolErrors` toward `call` or `response`, the three `widget*` kinds toward `response` — so that moving one is a deliberate versioned change rather than a fix someone applies to the table in isolation.
