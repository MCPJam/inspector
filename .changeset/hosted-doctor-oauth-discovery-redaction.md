---
"@mcpjam/inspector": patch
---

Close the remaining hosted doctor reflection paths the transport-detail
redaction did not cover.

`oauth.discoveryError` was never redacted. It carries the failure of the
RFC 9728 metadata fetch, and the host that fetch dials comes from the
`resource_metadata` parameter of the target's own `WWW-Authenticate` challenge —
a second origin, chosen separately from the server URL. So the socket, DNS and
TLS text for that host reached the caller verbatim, and `bench-probe-child`
copies the same string onto a user-visible check detail. It is the same
open-versus-closed differential the redaction exists to remove, aimed at a
different address.

The redaction gate was also whole-envelope. As soon as any probe attempt had
received a response the function returned early and rewrote nothing, so a target
whose first transport answered and whose second failed at the socket leaked the
second attempt's message. Attempts are now decided one at a time on their own
`response`, which is the granularity the reasoning always had. The
envelope-level summaries — `probe.error`, `connection.detail`, `checks[].detail`,
`error` and `oauth.discoveryError` — name no attempt, so they pass through only
when every recorded attempt received a response AND the doctor's connect leg did
not fail; a run that recorded no attempt at all is redacted too. The connect leg
matters on its own: it runs after the probe, records no attempt, and writes its
raw transport error onto `connection.detail`, `checks.connection.detail` and
`error`, so a target that answered the probe and then redirected the connect
elsewhere had that socket outcome reflected verbatim.

Two non-string fields carried the same differential and are redacted with the
message they belong to. `error.code` is derived from the raw message by
substring, which split the three outcomes — `SERVER_UNREACHABLE` for a refused
connect, `INTERNAL_ERROR` for an open cleartext port's TLS record error,
`TIMEOUT` for a filtered one — after the message stopped doing so; it now
collapses whenever the message is replaced. `attempts[].durationMs` is the same
oracle with a stopwatch, since a refused port returns in about a millisecond and
a filtered one burns the whole timeout; a redacted attempt reports `0`, the value
the probe already writes for an attempt it never dialled, while an attempt that
received a response keeps its real latency.

Local and desktop behaviour is unchanged: the redaction is still a no-op outside
hosted mode, where the socket error is the answer.
