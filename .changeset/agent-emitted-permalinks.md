---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

platform: durable resources return the app URL that owns them

A platform operation used to hand back a bare id, so an agent describing a
resource had to invent a URL for it — and the URL it invented carried no
project, which opens whichever project the READER last selected rather than
the one the agent was talking about.

`@mcpjam/sdk/platform` now exports `buildAppPermalink` and one
resource-type → route table. The builder is pure and takes an explicit
`appOrigin` (the platform entrypoint reads no ambient configuration), composes
with `URL`/`URLSearchParams` so segments stay encoded and a route's own query
survives, and refuses an origin carrying credentials, a path prefix, or a
non-HTTP(S) scheme. `PlatformResourceType` is inferred from the table, so a
type cannot exist without a route.

`PlatformOperation` gains a REQUIRED `permalink` policy — `derive`, `response`
(for backend-minted links such as session search), or `none` with a typed
reason — so no operation can ship without the question being answered.
`PlatformOperationContext` gains an optional `onScopeResolved` receipt, fired
where a project selector is resolved, because callers usually pass a project
name or nothing at all and the id exists only afterwards.

Permalinks never enter an operation's return type — they travel in an adapter
envelope — so no direct SDK caller has to change for them. ONE result shape
does change, additively: the eval-case operations now stamp `suiteId` on what
they return (`PlatformEvalCaseWithSuite`), because a case's route needs its
suite and the REST projection has never carried one. `PlatformSessionLink` is
now a `Pick` of the shared permalink shape — the same `{path, url}` wire
contract, derived rather than restated.

`mcpjam cloud` prints `View: <url>` after human output and carries a typed
`permalinks` array in `--format json`; `--quiet` is unchanged.
