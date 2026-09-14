---
"@mcpjam/sdk": minor
---

An assertion's or judge's policy role can now be authored as `"required"`, the canonical spelling of `"gating"`. `assertion({ role })`, `judge({ role })`, `predicateScorer(rule, { role })`, `judgeScorer({ role })`, the suite-file loader (both dialects) and `ScorerRole` all accept it; `"gating"` keeps working and is what stored contracts and dialect-1 suite files say. The published JSON Schema widens the enum additively, so a dialect-1 file that used `"gating"` still validates.

Every identity is unchanged, by construction rather than by luck. `definitionHash` emits the role through a frozen `hashSpelling`, so a definition's digest does not depend on which word it carries — every stored score row still joins to its definition, and `eval gate --baseline <run>` still resolves the scorer set it was pinned against. An authored `"required"` on a rule canonicalizes to the ABSENT field before the rule is digested for an anonymous id, which is the form Gate has always been written in; an explicit `role: "gating"` keeps its own existing id, because rotating that would orphan exactly the rows this change promises not to touch.

Builders still EMIT `"gating"`. Emission is one constant, `EMIT_CANONICAL_ROLE`, and is additionally gated at runtime on the deployment advertising `vocabulary.values.role` — a runner that emitted a role its backend did not accept would quarantine every iteration of the run as `score_integrity_invalid` and leave the dashboard looking empty rather than broken.

Every `role === "gating"` reader now goes through `isRequiredRole`, so a reader that forgot the new spelling cannot silently drop a rule out of the gating set.
