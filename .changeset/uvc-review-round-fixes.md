---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Scrub credentials from check reasons, and stop clearing a tool nobody declared

A reason string is persisted to `testIteration.metadata.predicates` and read
back by the UI, the API and the agent surfaces. `redact()` walks object KEYS,
so it cannot see a secret sitting in the middle of a sentence — and a tool
error message is exactly that shape (`401: invalid api_key sk-live-abc123`).
Free text captured from a live run now goes through a narrow `scrubText()`
first, on all four interpolations that carry it: `noToolErrors`,
`widgetNoConsoleErrors`, `toolErrorNamesInput` and `noEndingQuestion`. It is
deliberately conservative — an unrecognised secret still reaches the row and
the length cap is what bounds it — because over-matching would eat the half of
the message a reader acts on.

`noDeprecatedToolCalled` and `noDestructiveToolCalled` treated a called tool
that the captured inventory does not describe as clean, so a widget-initiated
or out-of-band call passed both safety checks silently while
`argumentsMatchToolSchema` reported an evidence error for the same call. Both
now report the error, keeping the one-sided rule: a violation already seen is
still proof and is not downgraded.

The inventory those checks read is now narrowed to what progressive discovery
actually advertised, so a check can no longer read a declaration for a tool the
model never saw. With progressive discovery off it is the complete set, as
before.
