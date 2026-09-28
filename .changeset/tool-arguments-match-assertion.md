---
"@mcpjam/evaluators": minor
"@mcpjam/sdk": minor
---

Add `toolArgumentsMatch`, an assertion over what went into a tool call. A call to `toolName` matches when every pattern in `patterns` matches that same call's arguments — the whole arguments object as canonical JSON, or one top-level `argument` — so labels split across several calls never add up to a match. `min` (default 1) and `max` count matching calls, not all calls; `min: 0, max: 0` means no call matches, not that the tool was never called. Patterns run on re2js (linear time; no lookaround or backreferences) with one shared `flags` set, and a pattern that does not compile is refused when the check is written. The assertion files at the Tool call stage and can be scoped to a single turn.

Arguments are read with the new `canonicalJsonBounded`, which is byte-identical to `canonicalJson` under its budget and stops as soon as the budget is spent. A call over 100,000 characters is unreadable rather than truncated, and a verdict it could decide is unscored instead of a pass or a fail. Reasons show values only with their keys, so sensitive-key redaction still applies, and scrub token-shaped text out of displayed patterns. Hosted authoring must wait for the matching backend deployment.
