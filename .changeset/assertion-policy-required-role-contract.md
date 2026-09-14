---
"@mcpjam/sdk": minor
---

An assertion's or judge's policy role can now be authored as `"required"`, the canonical spelling of `"gating"`. `assertion({ role })`, `judge({ role })`, `predicateScorer(rule, { role })`, `judgeScorer({ role })`, the suite-file loader (both dialects) and `ScorerRole` all accept it; `"gating"` keeps working and is what stored contracts and dialect-1 suite files say. The published JSON Schema widens the enum additively, so a dialect-1 file that used `"gating"` still validates.

Every identity is unchanged, by construction rather than by luck. `definitionHash` emits the role through a frozen `hashSpelling`, so a definition's digest does not depend on which word it carries — every stored score row still joins to its definition, and `eval gate --baseline <run>` still resolves the scorer set it was pinned against. An authored `"required"` on a rule canonicalizes to the ABSENT field before the rule is digested for an anonymous id, which is the form Gate has always been written in; an explicit `role: "gating"` keeps its own existing id, because rotating that would orphan exactly the rows this change promises not to touch.

Builders EMIT `"required"` — one build constant, `EMIT_CANONICAL_ROLE` — but the two upload paths answer differently, and the difference is deliberate.

The PRIMARY iteration payload (`/report`, `/runs/iterations`) is FROZEN at `"gating"` unconditionally. It carries each iteration's `evaluationConfig` through `scoreMetadata`, it is the payload almost every run sends, and a target that has not deployed the canonical spelling does not reject a `required` role there — it quarantines every iteration of the run as `score_integrity_invalid`, leaving the dashboard empty rather than broken. Negotiating that would mean probing `/capabilities` before the first upload of every run, and a run whose probe was slow, cached, or answered by the wrong deployment would be exactly the run that got quarantined. The payload needs no canonical word anyway: it is a stored contract, and a reader on the canonical vocabulary gets `required` from the read projection regardless.

The OPTIONAL case-run evaluations payload (`/runs/evaluations`) DOES negotiate, keeping `"required"` only when the target advertises `vocabulary.values.role` and downgrading otherwise — it already handshakes with the target for its own reasons, and its rows are advisory by construction.

Both are hash-neutral, so rows file under the same digests either way.

Every `role === "gating"` reader now goes through `isRequiredRole`, so a reader that forgot the new spelling cannot silently drop a rule out of the gating set.
