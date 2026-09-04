---
"@mcpjam/inspector": patch
"@mcpjam/sdk": minor
---

The judge gets a structured rubric, a backtest before you save it, and reviewer calibration

**The last link of the chain was measured by a judge nobody could instruct.**
`userValue` — "was the user's actual request satisfied" — was graded by a judge
whose only knobs were a model and a threshold, so two suites in different
domains asked the same question and got scores that were never comparable. The
Judge criteria row lets a suite say what it wants graded, as prose with stable
ids the judge cites in its reasons. Ids are validated for shape and uniqueness
before the save, because a duplicate makes `rubricHits` collapse into an
arbitrary winner, and because one batched save means a rubric the platform
refuses takes the settings beside it down with it. An id is minted from the
first label and then left alone: an id that followed its label would retire the
suite's calibration on every typo fix.

**Nobody could tell what a rubric edit would do until it was live.** A rubric
that flips half a suite's verdicts and one that flips none look identical in a
form. The review dialog now offers a backtest against the newest judged run and
reports how many verdicts would change, per case. It persists nothing and it
spends credits, so it is behind an explicit button and never fires on mount or
on save; a billing refusal renders as a notice rather than taking the dialog
down, and a run that was never judged, or judged by an older template, says it
is not comparable instead of inventing a comparison.

**A judge that can fail a build is a judge somebody has to trust.** The gate
switch now shows the evidence for that trust: how many blind reviewer labels
agree with the judge on its current rubric and template version. Every number
comes from the server — at zero reviews it says "No reviewer labels yet", never
"0%", because 0/0 is no evidence rather than total disagreement. The switch is
never hidden: a deployment that cannot gate renders it disabled saying so,
which is a different sentence from a suite that is not calibrated, and only the
second one names something a reader can do about it. An organization owner can
acknowledge past calibration with a reason, stored under their name.

**A reviewer can now label a trial, blind.** The label control renders before
the judge's verdict, which is hidden behind a Reveal button, and a label chosen
after revealing is submitted as not-blind and says it will not count — a label
chosen while looking at the judge's answer measures anchoring, not judgement.
A label never changes a run's result, an iteration's result, or any score row;
a test pins that the gating/advisory split renders identically either way.

**A repeated case's verdict was attributed to the wrong trial.** The judge
verdict shown on a trial was joined by `caseKey`, which names the case rather
than the trial — so under verdict policy v2, where every case runs several
times, the panel showed whichever verdict happened to be first in the array. It
now joins on the trial's own iteration id, then on its grading key, and falls
back to `caseKey` only for runs judged before either existed.

Gating stays refused on every deployment until the wiring step and its operator
switch.
