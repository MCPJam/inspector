---
"@mcpjam/sdk": minor
---

`XAAFlowState.grantedScope` — the `scope` the authorization server actually returned on the jwt-bearer token response, retained separately from the requested `scope`. A narrower grant is how a RAS downscopes a subject per its own policy (ID-JAG draft -04 leaves scope decisions to the RAS), and consumers previously had no way to see it without re-parsing the HTTP log.
