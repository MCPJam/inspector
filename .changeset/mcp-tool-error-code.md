---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
"@mcpjam/cli": patch
---

Capture and surface the MCP error code on failed tool spans in eval traces.

When a `tools/call` fails, the eval trace capture now records the JSON-RPC
error code (`mcpErrorCode`, aligned with OTel `rpc.response.status_code`) on
both the tool span and its synthesized error span. Only negative codes are kept:
server JSON-RPC faults (e.g. `-32602` Invalid params, `-32601` Method not found)
and SDK-local lifecycle codes (`-32000` connection closed, `-32001` request
timeout). Positive `.code` values such as transport HTTP statuses (e.g. `401`)
are no longer mistaken for an MCP error code.

The inspector trace timeline shows the code on the tool detail pane with a
neutral "MCP error" label and the standard code name, rather than asserting it
is always a server JSON-RPC fault.

`@mcpjam/sdk` adds the optional `mcpErrorCode` field to `EvalTraceSpanInput`, and
`@mcpjam/cli` picks up the updated trace types.
