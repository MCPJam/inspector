---
"@mcpjam/inspector": patch
---

The two "Tool list changed" switches now govern hosted connections too

`mcpProfile.toolListChanged` models a host that never opens the listen channel
(`listens: false`) or that ignores `notifications/tools/list_changed` when it
arrives (`refetches: false`) — the two ways a real client can leave a server's
tool list stale. Locally both worked. In hosted mode both were silently
ignored: every connection listened and refetched no matter how the host was
configured, so the debugger reported conforming behavior the host does not
have.

The values were computed correctly and then never handed over. `App.tsx`
resolved both leaves into `hostedMcpProfilePins` and stopped there, without
passing them to `useApiContext` — and even had it passed them,
`projectServerSchema` declared neither field, so Zod would have stripped them
off the request body before any route could read them. Two more hops down,
`extractMcpInitializeOptions` did not read them and `toHttpConfig` had nowhere
to put them. The sibling knobs (`firstPageOnly`, `supportsMrtr`,
`toolCallCancellation`) travel all four hops; these two never did.

Hosted **chat** turns were right by accident: a turn with a backing host config
re-derives every conformance knob server-side from that config
(`applyHostConformanceKnobs`), overwriting whatever the body carried. Every
other hosted surface — Tools, Resources, Prompts, tasks, evals, bench, apps,
export, MRTR continuation, and ad-hoc chat turns with no host config — builds
its connection straight from the request body, and so ran as a fully
conforming client.

Both switches now travel the same path their siblings do: only the
non-conforming value reaches the wire, the route schema declares it, the
extractor reads it, and the pins land on every `HttpServerConfig`. An absent
field still means the conforming behavior, so a host with no `toolListChanged`
opinion sends nothing and behaves exactly as before. Server-side host configs
stay authoritative over the body.
