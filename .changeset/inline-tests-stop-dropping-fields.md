---
"@mcpjam/inspector": patch
---

Inline eval tests no longer drop the public case fields — including `isNegative`

Both inline-test items on the v1 eval surface (`POST /eval-suites` `tests[]`
and `POST /eval-runs` `tests[]`) were bare `z.object`s inside strict parents,
and a bare object strips unknown keys silently. The keys they did not name are
exactly the public case-authoring names the API returns on a read
(`isNegative`, `iterations`, `checks`), so a caller who wrote down what a GET
gave back got a 201 with all of it dropped.

`isNegative` is the one that hurts. It is what makes a case pass when a tool is
NOT called, so dropping it stored the case with the OPPOSITE meaning — a 201
for a suite that asserts the reverse of what was sent.

Both items are `.strict()` now, and they accept the public names as aliases:
`isNegative` → `isNegativeTest`, `iterations` → `runs`, `checks` →
`predicates`. Legacy spellings keep working; sending both spellings of one
field is a 400 rather than a silent precedence rule. `repetitions`,
`passThreshold` and `kind` have no home on this path at all, so they are
rejected with a message naming the case route that does persist them.

`docs/reference/openapi.json` said `additionalProperties: true` on both items —
"extras pass through", the opposite of what the code did. It now says
`additionalProperties: false` and documents every field these items accept.
