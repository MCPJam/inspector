---
"@mcpjam/sdk": minor
---

Evaluator definitions now emit `role: "required"` — the canonical spelling — instead of the legacy `"gating"`. Every identity is unchanged: `definitionHash` digests the role through a frozen `hashSpelling`, so the golden fixture's 63 pinned hex values did not move when emission flipped; only its 24 `role` strings did.

Emission is gated on the deployment, not just the build. `capabilityAcceptsCanonicalRole` reads `vocabulary.values.role` off the suite capability — the value itself, never a version number or a field beside it — and `definitionsForDeployment` downgrades to the legacy spelling when a backend does not advertise it. The two repositories deploy independently and "merged" is not "deployed": a runner that emitted a role its backend refused would have every iteration of the run quarantined as `score_integrity_invalid`, leaving the dashboard looking empty rather than broken. The downgrade is hash-neutral, so a run against an older backend files its rows under exactly the same digests as one against a newer backend.

Readers take both spellings forever: a stored contract is historical evidence and is never rewritten.
