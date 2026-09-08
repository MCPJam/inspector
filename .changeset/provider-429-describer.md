---
"@mcpjam/sdk": patch
---

A provider rate limit is described as one, and a server's is not mistaken for it.

An HTTP 429 now resolves to `provider/quota` instead of falling through to a
generic failure, so a rate-limited run explains itself rather than reporting
"No output generated".

Because the same status arrives in the same shape from an LLM provider and from
the MCP server under test, `describeError` gains an optional
`context.surface`. A caller that passes `"mcpServer"` gets the new
`server/rate_limited` slug, attributed to the server rather than to the user's
provider settings. Callers that pass nothing are unchanged.
