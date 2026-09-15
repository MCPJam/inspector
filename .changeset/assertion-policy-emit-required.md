---
"@mcpjam/sdk": minor
---

Evaluator definitions now emit `role: "required"` — the canonical spelling — instead of the legacy `"gating"`. Every identity is unchanged: `definitionHash` digests the role through a frozen `hashSpelling`, so the golden fixture's 63 pinned hex values did not move when emission flipped; only its 24 `role` strings did.

What reaches the WIRE is decided per path, because the two upload paths carry different risk.

The primary iteration payload (`/report`, `/runs/iterations`) is written in the legacy spelling unconditionally. It carries each iteration's `evaluationConfig` through `scoreMetadata` and is the payload almost every run sends; a backend that does not accept `required` there does not reject the upload, it quarantines every iteration as `score_integrity_invalid` and leaves the dashboard looking empty rather than broken. The two repositories deploy independently and "merged" is not "deployed", so that payload does not depend on asking: it is a stored contract, and a reader on the canonical vocabulary gets `required` from the read projection regardless.

The optional case-run evaluations payload (`/runs/evaluations`) negotiates instead, because it already handshakes with the target. `capabilityAcceptsCanonicalRole` reads `vocabulary.values.role` off the suite capability — the value itself, never a version number or a field beside it — and `definitionsForDeployment` downgrades when a backend does not advertise it.

Both are hash-neutral, so a run against an older backend files its rows under exactly the same digests as one against a newer backend.

Readers take both spellings forever: a stored contract is historical evidence and is never rewritten.
