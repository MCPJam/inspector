---
"@mcpjam/inspector": patch
---

Readiness findings arrive with the verdict, in the suites' own grammar

The readiness sections rendered lane counts over nothing. Two causes, one
symptom.

**The findings never loaded.** The report fetch was wired to the section's
expand click — and the sections open by default, so the click never came, the
fetch never fired, and the report component returned `null` on the resulting
state instead of saying anything. A run that produced 49 findings rendered
exactly like a run that produced none. The report now loads the moment a run
is terminal, with a regression test proving no click is involved.

**The copy was the engine's wire vocabulary.** "Supply authorizationRequests,
intrusive to close this gap" is a `missingInputs` token list, named for runner
options a reader has never heard of. Each token now maps to a sentence that
says what happened and what to do — complete an OAuth flow, run the CLI with
the intrusive flags on a server you own, add a submission profile — with
unknown tokens falling back to their raw names rather than being hidden.

The report itself is regrouped to feel like the suites beside it: findings
sit under the lane that graded them, the group header carrying the same
"10/14 evaluated" a reader saw in the summary, red-and-gap lanes open by
default while clean lanes stay folded. Every row expands to the sentence it
exists to deliver — the remediation for a violation, the engine's own reason
for a check that never ran — plus its evidence and a link to the exact page
and section of the publisher's rules. That is the bar for an agent fixing an
error from this screen: id, status, why, what to change, and where it is
written.
