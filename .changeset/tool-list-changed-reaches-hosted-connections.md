---
"@mcpjam/inspector": patch
---

The two "Tool list changed" switches now reach the connection, hosted and local

`mcpProfile.toolListChanged` models a host that never opens the listen channel
(`listens: false`) or that ignores `notifications/tools/list_changed` when it
arrives (`refetches: false`) — the two ways a real client can leave a server's
tool list stale. **Neither switch reached a connection.** Every connection
listened and refetched no matter how the host was configured, so the debugger
reported conforming behavior the host does not have.

The values were computed correctly and then never handed over — at four
separate hand-offs, all of them silent.

**Hosted.** `App.tsx` resolved both leaves into `hostedMcpProfilePins` and
stopped there, without passing them to `useApiContext`. Even had it passed
them, `projectServerSchema` declared neither field, so Zod would have stripped
them off the request body; two hops further,
`extractMcpInitializeOptions` did not read them and `toHttpConfig` had nowhere
to put them. The sibling knobs (`firstPageOnly`, `supportsMrtr`,
`toolCallCancellation`) travel every one of those hops; these two never did.

Hosted **chat** turns were right by accident: a turn with a backing host config
re-derives every conformance knob server-side (`applyHostConformanceKnobs`),
overwriting whatever the body carried. Every other hosted surface — Tools,
Resources, Prompts, tasks, evals, bench, apps, export, MRTR continuation, and
ad-hoc chat turns with no host config — builds its connection straight from the
request body, and so ran as a fully conforming client.

**Local.** The same pair died one hop earlier and for the same reason. The
client put both leaves on `connectionDefaults` and `/api/mcp/connect` received
them, but `parseConnectionDefaults` — the shape gate that must name every field
it keeps — did not read them, and `toMCPServerConfig` had no field to set. A
local connect was as conforming as a hosted one, whatever the host asked for.

Both switches now travel the same path their siblings do on both surfaces: only
the non-conforming value reaches the wire, the boundary declares it, the
extractor or parser reads it, and it lands on the SDK config. An absent field
still means the conforming behavior, so a host with no `toolListChanged`
opinion sends nothing and behaves exactly as before.

**The wire declaration is now written once.** Chasing this bug turned up two
more instances of it, both the same shape and neither about `toolListChanged`:
`projectServerSchema` had never declared `toolCallCancellation`, so that knob
was stripped on every hosted surface except chat (which extracts from the
pre-parse raw body) since the day it shipped; and `hostedBatchSchema` — the
schema every hosted **eval** body is parsed through — declared none of the
conformance knobs at all. Three knobs, three schemas, one failure mode: Zod
strips what a schema does not name, and the result is not an error but a
silently conforming session. The six fields now live in one exported
`conformanceKnobWireShape` that both schemas spread, so a new knob reaches
every body-built surface by being added in one place.

The hosted local-runtime **stdio** divert was dropping `toolCallCancellation`
for the same reason at a different hop: it forwarded the sibling knobs to
`resolveLocalStdioServerConfig`, which has always accepted cancellation and
writes it onto the child config, but the hand-off never passed it. Cancellation
is era-scoped, not transport-scoped, so a stdio connection has to honor it too.

One thing this does **not** change: on the body-built surfaces a server-side
host config is not re-derived over the request body. Only chat turns do that
(`applyHostConformanceKnobs`); everywhere else the body is the source, exactly
as it already was for the sibling knobs.

One asymmetry is deliberate. `dropToolListChanged` edits an inbound JSON-RPC
frame, so it is forwarded on stdio as well as HTTP; `suppressListenChannel`
refuses a server→client GET stream that only Streamable HTTP has, so — like
`mirrorToolParamHeaders` — it is not written onto a stdio config, where it
could never act.
