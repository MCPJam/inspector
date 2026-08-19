---
"@mcpjam/sdk": patch
---

Claude readiness: name the input that closes each gap, and stop recommending intrusive probes.

Running the grader against two live connectors turned up two reporting bugs that
only appear on a target the run cannot fully reach.

The tool, apps and RFC 8707 checks reported `not-evaluated` without naming an
input that would close the gap, so the run-level summary could only offer inputs
some other check had declared. On an OAuth connector the run could not
authenticate to, the single remaining candidate was `intrusive` — and the report
told the reader to "supply intrusive to close the gap" on a server whose only
actual problem was a missing token. Those checks now name `toolListing`,
`appsResult` and `authorizationRequests`.

`intrusive` is now a GATED input: it registers OAuth clients and spends refresh
grants, so it is only legitimate against a server the submitter controls with a
dedicated test account. It never appears in the summary's `Supply …` clause. A
run whose only remaining gap is intrusive now says nothing failed and that the
gap needs explicit opt-in, instead of reading as advice to go run it.

`claude.auth.rfc8707-resource-canonical` was unreachable in practice: it grades
the `resource` parameter sent to `/authorize` and `/token`, but
`discoverClaudeAuthEvidence` excluded `resourceIndicatorsSent` from the extras a
caller may pass, and an access token carries no record of the requests that
produced it. The extras now accept it (alongside `insufficientScopeChallenge`),
and a new pure `resourceIndicatorsFrom({ authorizationUrl, tokenRequestBody })`
reads the parameter out of the two requests that carry it — returning
`undefined` rather than an empty object when neither did, so an absent parameter
stays `not-evaluated` instead of being graded as a bad one.

New exports: `CLAUDE_GATED_INPUTS`, `CLAUDE_TOOL_LISTING_INPUT`,
`CLAUDE_APPS_RESULT_INPUT`, `CLAUDE_AUTHORIZATION_REQUESTS_INPUT`,
`resourceIndicatorsFrom`.
