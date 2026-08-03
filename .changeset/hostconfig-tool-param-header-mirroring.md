---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Add a host-config knob for SEP-2243 `Mcp-Param-*` mirroring, and enforce the
mirrored headers product-wide.

`mcpProfile.toolParamHeaderMirroring` (`"mirror"` | `"omit"`, absent ⇒ mirror)
lets a simulated host stand in for a client that never sends `Mcp-Param-*`, so
a server can be tested against the non-conforming clients that exist in the
wild. It maps onto the new wire-level `MCPServerConfig.mirrorToolParamHeaders`
and is honored on both `tools/call` send paths.

`Mcp-Param-*` is now judged like the standard three headers: a new
`tools-x-mcp-header-declarations-valid` conformance check and
`readiness-x-mcp-header-declarations` readiness signal, real match / mismatch /
missing verdicts in the tracing panel, and `mcpjam tools call --no-param-headers`
/ `--mcp-header` for reproducing a header mismatch from the CLI.
