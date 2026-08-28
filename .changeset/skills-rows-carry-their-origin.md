---
"@mcpjam/inspector": patch
---

Server-served skills re-list when the connection re-negotiates, and each row names the server it came from

**The listing could answer for a handshake that had already changed.** `support.active` is `client advertised ∧ server declared`, and the client half comes from the hosted api-context, which hydrates from a Convex query. A listing issued on mount could go out before the host config landed — advertising the SDK defaults, which deliberately omit `io.modelcontextprotocol/skills` — and come back `active: false` for a reason that stopped being true a moment later. Nothing re-ran it, because the refetch key was the connected-server set, and a capability change is not a connection change to that key. The symptom was a row that appeared while loading and vanished when the answer arrived, with no way back: the only refresh button lived inside the row it had just hidden.

The section now folds the api-context revision into that key, the same `useSyncExternalStore` subscription `useAggregatedTools` uses, for the same reason — a catalog is a fact about a *negotiated connection*, not about a server id.

**Provenance moved onto the row.** The "From MCP servers" heading and the per-server group headers are gone; each skill row carries a server icon and its origin server's label instead. A skill's provenance is the reason its content is untrusted third-party input, and that stays true wherever the row is read — a heading only says it while you are underneath it. Refusals, rejected entries, duplicate URIs and the load-by-URI input keep their per-server wording inline.

With the group headers went their refresh buttons, so the tab's single refresh control now re-reads both halves — and it stays visible when `skills-enabled` hides the project store, since the server skills are exactly what is on screen in that case.
