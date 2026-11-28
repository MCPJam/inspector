---
"@mcpjam/sdk": patch
---

Capabilities Consistent (`capabilities-consistent`) can now fail. The official client never lists what a server did not declare, so the check could never see a feature served without its declaration. It now asks for each undeclared `tools/list`, `prompts/list`, `resources/list` and `resources/templates/list` itself, and one that returns items fails. On 2026-07-28, a declared listing that answers with an error (Method not found included) also fails, because that revision says a server that declares the capability MUST answer it. A listing with no answer, such as a timeout, a gateway, a 429 or a 401, reports could not run instead of a pass.
