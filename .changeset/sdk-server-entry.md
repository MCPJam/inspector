---
"@mcpjam/sdk": minor
---

Add `@mcpjam/sdk/server`, building blocks for an MCP server that run on Node and on Workers: capabilities per protocol revision, list paging, URI template matching, the server half of the skills extension (`registerSkillsMethods`, manifest entries, the not-found error) and output-schema checks with the JSON Schema validator passed in. The mock servers in `@mcpjam/sdk/mocks` now use them.
