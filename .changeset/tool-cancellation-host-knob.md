---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Model tool cancellation as a host behavior: a Protocol-tab knob and a caniuse row

A server author has no way to answer the question that decides whether a stopped
turn costs them anything: **when the user hits stop, does the host tell me?** If
it does not, the tool runs to completion on the server — side effects, tokens and
all — while the host has already moved on. Hosts genuinely differ here, and
nothing in the host config recorded it, so it could not be simulated, compared,
or published.

`mcpProfile.toolCallCancellation` now does, as a sibling of `paginationTraversal`
and `mrtrSupport` and with the same delete-on-default discipline: `"full"` is
absence, so a host that never touches the control keeps its canonical hash, and
only the degraded `"none"` is ever stored.

**One knob, not one per era.** Which signal a conforming client sends is fixed by
the negotiated revision and transport, never chosen by the host: closing the
response stream on `2026-07-28` Streamable HTTP, `notifications/cancelled`
everywhere else — all of 2025, and stdio on any revision. (`2025-03-26` and
`2025-06-18` are identical here; `2025-11-25` differs only in routing
task-augmented requests through `tasks/cancel`.) Two fields would imply a host
could answer them independently, which the spec does not allow. So the era
changes the row's LABEL — "Tool cancellation (2026)", "(2025)", or "(2025 +
2026)" when the version is unpinned and could negotiate either — while the
comparison matrix and caniuse.dev keep the plain label, because adjacent columns
there are hosts pinned to different revisions and a single suffix would be wrong
for half the row.

Cancellation is deliberately NOT modeled as a capability. The spec declares none:
it is a *pattern*, not something a client advertises. But `HOST_CONFIG_FIELDS`
already carries observed behaviors — `paginationTraversal`, `mrtrSupport`,
`toolListChanged` — and this is one of them.

`false` is enforced by withholding the caller's abort signal from the request
and racing the caller against it locally instead (`awaitWithAbort`). The signal
is the only thing that reaches the wire, so withholding it withholds whichever
mechanism the negotiated revision would have used, while the turn still ends
promptly for the user. It is deliberately not implemented by hiding the
transport's `hasPerRequestStream`: that would make a modern connection fall back
to POSTing `notifications/cancelled`, a message no conforming client sends on
`2026-07-28`. The simulated host must be silent, not wrong.

**Public rows now appear with their data.** caniuse.dev hides any field no
published host has been measured for yet, rather than showing a row of "Not yet
tested" — a question dressed as an answer. The row appears on its own the moment
the first real host value lands, with the hosts still queued behind it reading
"Not yet tested" rather than being published as silently abandoning every
cancelled call. No allowlist to maintain: the data decides. The internal matrix
still shows every field, because that is where a value gets filled in, and a row
you cannot see is a row you cannot populate.

ChatGPT's measurement is unparked in the same change set: stopping a tool call
ends its turn without telling the server, which keeps running the tool. That one
value is what makes the row appear — every other host reads "Not yet tested"
until it is probed.
