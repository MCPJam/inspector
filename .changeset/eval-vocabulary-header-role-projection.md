---
"@mcpjam/inspector": patch
---

`/api/v1` eval routes now negotiate with `x-mcpjam-eval-vocabulary`. Absent means `1` — byte-for-byte today's contract, including its refusals — and `2` is the canonical vocabulary; anything else is a `400`. A response that varies by vocabulary sends `Vary: x-mcpjam-eval-vocabulary`.

Today it decides one thing: the spelling of an evaluator's policy `role`. Vocabulary 1 accepts and returns `gating`; vocabulary 2 accepts both spellings and returns `required`. Sending `required` without the header is refused rather than quietly accepted — a published `mcpjam cloud eval gate` finds the scorers that decide a run by filtering roles on the literal `"gating"`, so an unannounced rename in a response would empty its gating set and pass a failing run.

**The judge's `role` is now actually forwarded.** `settings.judge.role` has been in the SDK's request type since the judge gate shipped and the PATCH schema had no `role` key, so zod stripped it and the handler forwarded everything but. Authoring a judge role over the API, over MCP or from the CLI did nothing at all, silently, and no test covered it. It is now accepted, normalized to the stored spelling, forwarded to the platform that enforces it — calibration and the deployment switch still decide whether the value is allowed — and readable back on the suite DTO.

The published OpenAPI spec documents the header on every eval operation and widens the 34 `role` enums additively. `ResolvedScoreDefinition` is now pinned against its SDK twin, so the published enum and the one the boundary serves cannot drift apart without a red test.
