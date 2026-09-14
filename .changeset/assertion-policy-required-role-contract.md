---
"@mcpjam/sdk": minor
---

An assertion's or judge's policy role can now be authored as `"required"`, the canonical spelling of `"gating"`. `assertion({ role })`, `judge({ role })`, `predicateScorer(rule, { role })`, `judgeScorer({ role })`, the suite-file loader (both dialects) and `ScorerRole` all accept it; `"gating"` keeps working and is what stored contracts and dialect-1 suite files say. The published JSON Schema widens the enum additively, so a dialect-1 file that used `"gating"` still validates.

Every identity is unchanged, by construction rather than by luck. `definitionHash` emits the role through a frozen `hashSpelling`, so a definition's digest does not depend on which word it carries — every stored score row still joins to its definition, and `eval gate --baseline <run>` still resolves the scorer set it was pinned against. An authored `"required"` on a rule canonicalizes to the ABSENT field before the rule is digested for an anonymous id, which is the form Gate has always been written in; an explicit `role: "gating"` keeps its own existing id, because rotating that would orphan exactly the rows this change promises not to touch.

Builders EMIT `"required"`, and every payload is downgraded to `"gating"` on the way out unless the target advertises `vocabulary.values.role`. Emission is one build constant, `EMIT_CANONICAL_ROLE`; the deployment half is applied once per run, to the primary iteration payload as well as the optional case-run evaluations, because a runner that sent a role its backend did not accept would quarantine every iteration as `score_integrity_invalid` and leave the dashboard looking empty rather than broken. The downgrade is hash-neutral, so rows file under the same digests either way.

Every `role === "gating"` reader now goes through `isRequiredRole`, so a reader that forgot the new spelling cannot silently drop a rule out of the gating set.
