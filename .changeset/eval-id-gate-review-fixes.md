---
"@mcpjam/inspector": patch
---

Close the id-shape gate's remaining holes on the eval surface, and stop it
losing to the same redaction it was written for.

The gate landed on the eval surface's path parameters. Four caller-supplied ids
on the same routes were not covered, and each one reproduced the original
incident exactly: a value that cannot name a Convex document, rejected by
`v.id(...)` before the handler runs, redacted in production to the same
`Server Error` a crash produces, and answered as a terminal 500 that
`mcpjam_internal` promotes to `origin=mcpjam` and captures once per retry.

- **The grouped-launch body.** `POST /eval-run-groups` hands a model N run ids
  and its own targets took `environmentId` / `namedHostId` as plain strings, so
  the same joined-ids value arrived in the body of the route the ids came from.
  Gated before the dedup and before the attachment checks, so a well-shaped but
  unattached id keeps its actionable 400 and its list of what is acceptable.
- **`POST /eval-suites/:suiteId/environments`.** The path `suiteId` was gated
  and the body `environmentId` beside it was not.
- **`namedHostId` and `suiteId` in `fetchSuiteRunServerSelection`,** which does
  not pass through `readSuiteInProject` and so had no gate at all. Reachable by
  a share-link guest, since the launch route carries no method restriction.
- **`projectId`, at the three sites that forward it to Convex** as a
  `v.id('projects')` argument (`hosts:listHosts`,
  `computerEnvironments:listEnvironments`,
  `projectEnvironments:getEnvironment`). Gated at those sinks rather than on
  every route: elsewhere the path's project id is only compared against a
  document's own field, where a malformed value already answers the 404 it
  should.

Two corrections to the gate itself:

- **`?baseRunId=` is absence, not a malformed id.** Every consumer of
  `baseRunId` is truthiness-based, so an empty value has always meant "compare
  against the previous completed run". Gating on `!== undefined` alone answered
  404 instead, and the platform client drops only `undefined` from a query
  object — so a caller that always writes the key, or a CI script interpolating
  an unset variable, lost the default baseline.
- **The rejection log redacts before it truncates.** The value is whatever a
  client put in an id slot, and slicing first can cut a credential in half and
  leave a fragment the redactor no longer recognizes.

The iteration-steps evidence read is now best-effort in production, which it was
not. It swallowed only the UNREDACTED refusal shapes, and the refusal it guards
("Iteration not found or unauthorized", a plain `Error`) is exactly what
production redacts — so the documented "verdicts still return without evidence"
behaviour worked in dev and answered a captured 500 in production. A redacted
failure is now read as a refusal at this one call site, where the two preceding
reads have already established the caller may see the iteration; a transport
failure still classifies `upstream` and still surfaces.

`docs/reference/openapi.json` gains the `502` the shared read translator can now
return on nine eval operations that documented only `500`.

Finally, the repo's forbidden-symbol guards become a program instead of a shell
negation. `! rg …` fails OPEN: a missing ripgrep exits 127 and `!` inverts that
to success, as does a renamed scan root, so three of the five steps in
`test:checks` could report green having inspected nothing.
`scripts/check-runtime-guards.mjs` treats a missing root or a zero-file scan as
a failure and names the file and line of each violation.
