---
"@mcpjam/inspector": minor
---

Claude directory readiness gets a screen: grade a connected connector against
Anthropic's requirements and read what would have to change before submitting.

Ships DARK, behind the `mcpjam-conformance` PostHog flag — the same one, not a
new one. The two roll out together, and a separate flag would let this appear
for somebody who cannot see the tab it sits beside.

**Its own page, not a fifth conformance suite.** That separation is the point
of the whole product, so it is a separate nav entry rather than a fifth card in
the Conformance tab. Conformance grades a server against the MCP spec and
produces a score that pools across suites; readiness grades a connector against
a listing policy, produces no score, and never enters that pooled number.
Rendering them as five cards would say they are the same kind of claim, and the
first consequence is somebody reading a policy preference as a protocol
violation. The page says so in its own words too, next to the verdict.

Three rendering rules follow from the result model and are each pinned by a
test written against the misreading it prevents:

- **Coverage sits beside every lane, always.** "Nothing was violated" and
  "nothing was evaluated" look identical if you only render findings, and the
  second one is the most damaging thing this page could imply. A lane that
  evaluated nothing says so, and names the input that would close it.
- **Only the verdict is the verdict.** Lanes that cannot move it are labelled
  advisory, an unsupported capability badge says in text that it is not a
  defect, and a run that failed to finish renders as a failure to finish —
  never as `not-ready`, which would file an outage as a policy failure against
  somebody's connector.
- **Every finding carries its provenance and its source.** `wire` means we
  observed it; `declared` means the submitter said so and this run never
  checked. Expanding a finding shows its stable check id, its remediation, and
  a link to the section of Anthropic's documentation it comes from — a grade
  nobody can check is an opinion.

The submission profile is optional and its absence is reported as a missing
input rather than a failure: a developer who has not written their listing yet
still wants to know about their transport. Only the JSON-ness is checked in the
browser — the schema is checked by the engine, so a bad field comes back as
findings naming the fields rather than as a client-side error that stops the
run before the transport is graded at all.

The run reaches the connector through the same pinned transport every
conformance run uses, and for a sharper reason: readiness FOLLOWS the target's
own metadata, so every URL after the first is chosen by the server being
graded.
