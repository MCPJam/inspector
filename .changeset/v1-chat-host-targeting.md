---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

Agent chat turns can drive a harness host, and never silently emulate one

`POST /v1/chat-sessions/messages` — the route behind `mcpjam cloud sessions send`
and the Platform MCP `send_chat_message` — had no host concept at all. It took a
model plus an `environmentId`/`serverIds` target, and the environment was
consulted only for its SERVER selection. Aim a turn at an environment whose host
declares `harness: "cursor"` and it ran MCPJam's emulated engine, answered 200,
and reported a plain `anthropic/…` model. The product said it had driven Cursor
CLI and had driven something else. Every agent surface was in that position; only
the browser could drive a harness at all.

The turn now resolves a HOST, server-side, and that host decides the engine.
An environment carries its own — the backend resolves it in the same atomic read
as the server set — so a harness environment runs its harness with nothing new in
the request, on continuations included, because `environmentId` is a resume pin.
A new `hostId` names one directly: alone it also connects the host's own selected
servers, and alongside an environment it is an assertion that the environment's
host is the one you think it is.

The security properties are the browser route's, not a lighter version of them.
`harness` and `computer` are read ONLY from the config the server fetched for the
pointer; the request schema is strict, so a body carrying either is a 400. A host
config that cannot be loaded fails the turn instead of falling back to "no host,
therefore emulated" — a host we cannot read might be a harness host. A `hostId`
that contradicts the environment's own is rejected (`HOST_TARGET_CONFLICT`)
rather than resolved by precedence, the same rule `normalizeExecutionTarget`
applies on the browser side.

Refusals are pre-stream and named, never a downgrade. The turn runs the SAME
`checkHarnessRuntimeAvailable` gate chat, swarms and eval admission call, so a
missing computer plane, a disabled broker, an enterprise-managed host or an
ineligible model answers 422 with `details.reason: "HARNESS_UNAVAILABLE"` and a
machine-readable `details.kind`, before the lease has spent anything. Two
refusals are this surface's own: it runs `auto-deny` approvals, so a host that
requires tool approval has nobody to ask; and `toolMode`/`allowedTools`/
`maxToolCalls` are applied by withholding tools from the engine this route
builds, which a harness — building its own set inside its sandbox — never sees.
A `read_only` harness turn is refused rather than run with the whole tool surface
live while the response still reports the narrowing.

And every turn now names its engine. `engine` is `"emulated"` or
`"harness:<id>"` on every response, harness or not. A turn that said nothing was
indistinguishable from one that ran the harness, which is what let this go
unnoticed; it is also the receipt for the one gap host targeting cannot close on
its own, since `hostId` is per-turn (the ingest boundary's `resumeConfig`
projection carries no host, so pinning it would validate, 200, and be dropped) —
a continuation that forgets it reports `emulated`, out loud.

`hostId` is threaded through the SDK client and the `send_chat_message`
operation, and reaches the wire rather than merely passing validation. The CLI
gains `mcpjam cloud sessions send --client <hostId>`.
