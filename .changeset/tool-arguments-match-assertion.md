---
"@mcpjam/evaluators": minor
"@mcpjam/sdk": minor
---

Add `toolInputMatches` and `toolResultMatches`, two assertions that check what went into a tool call and what came back, with patterns. Each reads one unit at a time — a call to `toolName`, or one tool result in scope — and a unit matches only when every pattern in `patterns` matches that same unit, so labels split across several calls or results never add up to a match. `min` (default 1) and `max` count matching units, not all units; `min: 0, max: 0` means none matches, not that the tool was never called. An optional `path`, a JSON Pointer to one top-level key such as `"/elements"`, narrows the match to that argument, or to that key of the result's `structuredContent`. Patterns run on re2js (linear time; no lookaround or backreferences) with one shared `flags` set, and a pattern that does not compile is refused when the check is written.

`toolInputMatches` requires `toolName`, files at the Tool call stage and can be scoped to a single turn. `toolResultMatches` reads every tool's results unless `toolName` is set, matches the same content `toolResultContains` searches, includes `isError` results, and files at the Response stage.

Subjects are read with the new `canonicalJsonBounded`, which is byte-identical to `canonicalJson` under its budget and stops as soon as the budget is spent. A unit over 100,000 characters, or a result whose text was truncated for storage, is unreadable rather than truncated, and so are results an incomplete capture never recorded; a verdict any of them could decide is unscored instead of a pass or a fail. Reasons show values only with their keys, so sensitive-key redaction still applies, and scrub token-shaped text out of displayed patterns. Hosted authoring must wait for the matching backend deployment.
