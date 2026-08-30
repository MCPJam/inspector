---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

A judged stage row says who judged it, and on what

Two defects, both about a reader being unable to weigh an advisory verdict.

**Every judged row shipped with no evidence.** `judgeEvidenceFromVerdict` never populated `reasons`, so `boundedJudgeReasons` returned `undefined` on the judge path and `judgeObserved` / `judgePartial` / `judgeFailed` reached every surface as a bare verdict — a stage marked failed by a model, with nothing at all to say why. Its D7 sibling `metadataAttributionEvidenceFromVerdict` had populated reasons all along, so the two judges disagreed about how much they owed a reader.

The row now carries, in order of directness: the judge's own rationale when one exists, and otherwise the numbers the verdict was actually decided from — `LLM judge scored 0.42 against a 0.7 threshold`. The second is not a rationale and is not dressed up as one, but it tells a reader which side of the line the run fell and by how much, where before there was nothing.

**A gap worth naming rather than hiding:** the backend does not persist a scored case's rationale. `goalCompletion.ts` writes `score`, `threshold`, `verdict` and — in the `error` band only — the failure text, and drops the per-case `reason` the judge produced. This reads `reason`/`reasons` anyway, so the day that changes the rationale appears with no second change on this side. Closing it properly is a backend write plus a deploy, and is recorded as follow-up rather than folded in here.

**The provenance is now in the label.** These five reasons are the only ones in the vocabulary decided by a model rather than a deterministic rule, and "the judge scored inside the partial band" did not say so. They now read "the LLM judge …", and `judgePartial` spells out what the band means — above the floor, below the threshold. The labels live in `decision-labels.ts`, which all four surfaces already read from, so one edit moves the CLI, JSON, JUnit and HTML together; the D9 cross-surface corpus proves they stayed in step.
