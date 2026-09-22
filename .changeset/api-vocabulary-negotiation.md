---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Negotiate the public API's resource-noun **values** behind `x-mcpjam-api-vocabulary`.

Three nouns were renamed at the API boundary: scenario → study, journey → goal, wave → swarm run. Operation names, routes, type names and field names could all move behind a deprecated alias, because a caller reaches them by a name it chose. A value cannot: `sourceType` is one field with one string in it, and a client switching on `"scenario"` has no second name to fall back to.

So the values negotiate. `x-mcpjam-api-vocabulary: 2` asks for the canonical spellings; an absent header means vocabulary 1, byte-for-byte today's contract; anything else is a 400. A response that varies by vocabulary sends `Vary`.

**What moves under vocabulary 2.** A session's `sourceType` reads `study`; its `parentRef.kind` reads `study` or `goalRun`, with `studyId` / `goalRunId` / `goalRefId` in place of `scenarioId` / `journeyRunId` / `journeyRefId`. A share's `resourceType` reads `study` — and because that value is also a path segment, `/shares/study/{id}` addresses the same rows `/shares/scenario/{id}` does. A trace destination's `sourceTypes` reads `study`.

**What it accepts.** On the way in, a vocabulary-2 request may name a filter or a path segment by either spelling; a vocabulary-1 request may use only the legacy one. Widening vocabulary 1 to meet vocabulary 2 half way is exactly what makes a negotiation boundary undecidable. A trace destination's stored `sourceTypes` is the one place both are accepted at all times — it is stored configuration, so the vocabulary of the request that wrote it is a fact about that request, not about the row.

**SDK.** `new PlatformApiClient({ apiVocabulary: 2 })`, or `client.withApiVocabulary(2)` on one you already hold. Separate from `evalVocabulary`, because the two negotiations are separate and a deployment may advertise one without the other — read `getProjectCapabilities()`, which now carries an `apiVocabulary` block beside `vocabulary`.

**Permalinks** are the exception that proves the rule: `study` and `goal_run` are the canonical resource-type keys, `user_testing_scenario` and `journey_run` still resolve to the same routes, and which one a response carries follows the operation rather than the header. Both spellings stay in the table until general availability, because consumers outside this repo branch on them.

Storage does not move. The stored literals are still `scenario`; every rename here is a projection at the boundary.
