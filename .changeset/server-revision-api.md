---
"@mcpjam/sdk": minor
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

A saved server's revision history is readable outside the History tab. The API serves `GET /projects/{projectId}/servers/{serverId}/revisions`, `.../revisions/{revisionNumber}` and `.../revisions/{revisionNumber}/diff`, the SDK adds `listServerRevisions`, `getServerRevision` and `diffServerRevisions` with matching operations, and the CLI adds `cloud projects servers revisions`, `revision` and `revision-diff`. The same three are tools on the hosted MCP server and in Playground chat. A diff returns each changed tool's old and new definition and each changed server info field's values. These read stored data, so they work for stdio servers too.
