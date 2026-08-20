---
"@mcpjam/sdk": minor
---

Add the release-contract lane: what changed since the published version, and
what that change costs.

`captureOpenAIMetadataSnapshot` reduces a scan to the parts a contract
comparison is about — tool names, titles, descriptions, schemas, annotations,
security schemes, tool `_meta`, server `instructions`, UI resource metadata and
CSP — and stores the server's ORIGIN apart from its PATH, because those two
changes have completely different costs. Tools, resources and CSP domains are
sorted at capture: two scans of one server are free to list them in any order,
and a comparison that treated order as contract would report drift forever.

`compareOpenAISnapshots` classifies every difference into one of three
outcomes, and telling them apart is the whole value of the lane:

- an ORIGIN change is a NEW PLUGIN, not a version. A submitter who files it as
  an update loses the review and starts over, so this must never read as a
  routine bump — while a PATH change is exactly that routine bump.
- a tool, schema, annotation, security scheme, `_meta`, `instructions`, UI URI
  or CSP change requires a fresh scan and a new review.
- UI content behind an unchanged URI ships without one, with a note that the
  host may serve a cached copy for up to an hour — otherwise "I deployed it and
  nothing changed" becomes a bug report.

A changed SCHEMA is `manual-review`, never an automatic verdict. An added
optional property and a removed required one are both "the schema changed", and
structural equality cannot tell them apart: reporting `not-ready` for the first
costs a submitter a release, and reporting `ready` for the second breaks their
users. Neither is acceptable, so the check reports what moved and says a person
must decide.

First submissions report the lane `not-applicable` — there is no contract to
break — and it joins the `submission-ready` stage only once a version is
published.
