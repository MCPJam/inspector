---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Publish the eval role-permission matrix as capabilities, and gate suite and
run deletion on it.

`GET /v1/projects/:projectId/capabilities` gains six eval keys: `readEvals`,
`writeEvalSuites`, `launchEvalRun`, `deleteAnyEvalSuite`, `deleteAnyEvalRun`
and `exportEvalTraces`.

They are NOT derived like the swarm keys beside them, and the difference is
the point. Swarm writes rank the organization role alone (`requireProjectRole`),
so a guest holding a project grant cannot author one. Eval writes resolve
project ACCESS, where the grant counts — so reporting org membership for both
would deny a grant-holding guest eval capabilities they actually hold. The
eval edit tier is satisfied by anyone whose access resolves, which is the same
condition under which this endpoint answers rather than 404s.

`deleteAnyEvalSuite` and `deleteAnyEvalRun` carry "any" in the name on purpose.
Deleting someone else's suite takes the project admin tier, but the creator of
a suite may always delete it whatever their role — the escape hatch that lets
an interrupted import roll back the suite it just wrote. A key named
`deleteEvalSuite` reading `false` would tell an ordinary member they cannot
delete the suite they just made.

The eval tab now applies that same rule instead of assuming it. Suite deletion
was pinned to `true` for every caller, which left the whole question to a
mutation the user reached by clicking Delete and watching it fail; run deletion
was pinned to member-management rights, which hid deletion of your own runs.
Both are now per-row — the manage tier, or authorship of that particular suite
or run — so the suite switcher offers delete on the rows a caller can act on
and not the others. Batch run deletion stays visible but disables while the
selection holds a run started by someone else, with the count in the tooltip,
rather than silently deleting the subset it is allowed to.
