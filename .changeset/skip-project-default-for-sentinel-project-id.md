---
"@mcpjam/inspector": patch
---

Stop asking the backend for a project default host config under a project id
that is not a Convex row. The Playground passes `sharedProjectId ??
activeProjectId`, so a guest with no cloud project reached
`hostConfigsV2:getProjectDefault` with the string sentinel `"none"` — truthy,
and rejected by `v.id("projects")` before the handler runs, where nothing
client-side could catch it. All four call sites now gate on
`shouldQueryProjectId`, the guard the rest of the Convex-reading hooks already
use.
