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
unnoticed.

A CONTINUATION cannot fall through to the other engine either. `hostId` is
per-turn — the ingest boundary's `resumeConfig` projection is an allowlist that
carries no host, so pinning it would validate, answer 200 and be dropped — and a
session established by `hostId` alone therefore pins no target of its own. A bare
continuation of one is REFUSED (400, `details.reason: "HOST_TARGET_REQUIRED"`,
before the lease) rather than resolved as "no host pointer, therefore emulated":
the session's earlier turns may have run a real harness, and splicing a second
engine into the same transcript is the original bug arriving one turn later. The
caller re-sends the `hostId` the first turn's response reported, and the host's
CURRENT server selection is re-resolved from it — a host edit is visible to the
session it was made for, which a copy of the first turn's set would have hidden.
Making the engine durable instead is a backend change: `AGENT_RESUME_PIN_KEYS`
and the ingest projection would both have to carry a host.

The one shape that guard cannot recognise is refused where it would be CREATED.
A session pinning its own `serverIds` continues as an ordinary `serverIds` turn
— indistinguishable from one that never named a host — so `hostId` alongside
`serverIds` on a HARNESS host is refused up front (422,
`details.kind: "surface-unpinnable-host"`) instead of producing a session whose
turn two silently changes engine. Both escapes are lossless and named in the
error: an `environmentId` pins its host durably, and `hostId` alone plus
per-turn `allowedServerIds` narrows the same set. On an emulated host the
pairing is untouched — there is no engine to lose.

An environment-backed harness turn now delivers the ENVIRONMENT's resolved
skills. The emulated engine already honoured them; the harness read
`runtimeSkillsOverride`, which nothing set here, so it fell back to the live
project-wide catalog and wrote the whole project's skills into the sandbox — the
environment's decision honoured on one engine and discarded on the other, from
two responses that look identical. Presence is authoritative, so an environment
resolving zero skills delivers zero — while an environment resolver too old to
carry `skills` at all (an additive, deploy-skew field) stays ABSENT and keeps
the live fetch, because "we were not told" must not be published as "this
environment has none". Per-skill supporting files and pinned plugin
versions still do not cross (they travel as `effectiveCapabilities`, which the
`runAssistantTurn` facade does not expose): a harness turn here delivers the
environment's skill bodies, narrower than the Playground but no longer a
different set.

`hostId` is threaded through the SDK client and the `send_chat_message`
operation, and reaches the wire rather than merely passing validation. The CLI
gains `mcpjam cloud sessions send --client <hostId>`.
