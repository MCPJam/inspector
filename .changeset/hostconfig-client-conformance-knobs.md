---
"@mcpjam/sdk": minor
---

Add two client-conformance knobs to the host-config `mcpProfile` schema
(siblings of `toolParamHeaderMirroring`), modeling real differences between
the clients MCPJam emulates:

- `paginationTraversal` (`"full" | "firstPageOnly"`) — whether the simulated
  client follows `nextCursor` to exhaustion or treats page one as the whole
  result, the way several real hosts do. Under `firstPageOnly` the SEP-2243
  `Mcp-Param-*` mirroring source is page-one-only, matching how such a client
  really behaves.
- `mrtrSupport` (`"full" | "none"`) — whether the client drives MRTR
  `input_required` retry rounds at all. Which elicitation modes an
  MRTR-capable client fulfills stays where it already lives, in
  `clientCapabilities.elicitation.{form,url}`.

Schema freeze only: both fields canonicalize (absent = full behavior and
omitted, so existing hashes are stable), round-trip through `Host` /
`HostJson` and the evals normalizer, and reduce to their wire shape in
`hostConnectionProfile()`. Runtime enforcement lands in follow-up releases.
