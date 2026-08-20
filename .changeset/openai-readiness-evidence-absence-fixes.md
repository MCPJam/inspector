---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

OpenAI readiness: five ways evidence absence read as a verdict

Each of these is the same mistake pointing in one of two directions — a run that
established nothing reporting a fault, or a run that read part of something
reporting a pass — and in a product whose whole claim is that it never confuses
"did not run" with "conformed", each is disqualifying on its own.

**A skills listing nobody reached is not a missing extension.** `callJsonRpc`
returned the parsed document and dropped the status and the transport error with
it, so a timeout or a 401 on the unauthenticated probe arrived at the caller as
`undefined` — indistinguishable from a server that answered and said nothing.
The skills lane read that as "this server does not implement the extension" and
raised a class-`required` violation, flipping the headline verdict on a network
event. The status and error now ride along, `skills/list` records
`listUnreachable` when nothing readable came back, and the lane reports the gap.

**A host nobody reached is not a host missing its metadata.** `discoveredVia:
"not-found"` is recorded both when the well-known path answers 404 and when the
request never lands. The PRM check treated both as the second and told the
submitter to publish a document they may already have published. It now keys off
the endpoint's own probe — status 0 means the metadata requests failed the same
way for the same reason — and off a recorded fetch error, and reports those as
`not-evaluated` while a genuine 404 stays `violated`.

**A profile that says nothing about publication was answering "no".**
`hasPublishedVersion` carried `.default(false)`, which turned an omitted field
into an authoritative negative and made the runner's documented fallback to the
gathered evidence unreachable. An update whose profile omitted it graded as a
first submission: the release-contract lane dropped out of the stage as
`not-applicable`, and a change breaking the published tool contract rolled up
`ready`. The field is now optional, and the resolved value is threaded into the
submission checks so the release-notes rule and the lane gate cannot disagree.

**The archive's raw names were the loader's repaired ones.** `Object.keys(zip.files)`
is JSZip's post-normalization view: it resolves `..`, collapses `//` and `./`,
and — being name-keyed — keeps only the last of two records sharing a name. Those
are four of the conditions the portal rejects, so the path rules ran against a
table with the violations already fixed out of it, and because the reader treats
a present `rawEntryNames` as "checked", the result read as a clean archive rather
than an unexamined one. The central directory is now walked directly, which also
survives an encrypted archive whose directory is plaintext, and returns absent
rather than empty for anything it cannot read faithfully (ZIP64, truncation).

**The drift check was red on arrival.** The `llms.txt` parser matched the base as
a string prefix rather than a path segment, left `./` on relative links, and read
the index's own `llms-full.txt` export as a page — a slug that can never be
pinned, since fetching it would ask for `llms-full.txt.md`. The weekly job would
have failed every week with nothing to reconcile, which is how a maintainer
learns to ignore the one alarm that means OpenAI changed the rules. Verified
against the live index: 28 slugs, no phantoms.

Also drops a regenerated `McpAppsHtml.bundled.ts` that no source input in this
branch produced.
