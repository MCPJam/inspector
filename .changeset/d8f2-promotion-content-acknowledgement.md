---
"@mcpjam/inspector": patch
---

D8f2: ask before copying a tester's words into a test case

Promoting a real User Testing session copies someone else's transcript into a
durable, member-owned test case — outside the surface it was written on. The
promote dialog now says so and requires an acknowledgement before it will
submit.

It asks when the **server** says to (`requiresContentTransferAcknowledgement`
on the promote detail), never from a client-side rule about `sourceType`: a
synthetic scenario session is a scenario session and any local rule would ask
about it, wrongly. Playground and swarm promotion are untouched — a checkbox
people click past teaches them to click past the one that matters.

The checkbox is never pre-ticked, resets when the dialog closes or the session
changes, and **blocks** submit rather than warning past it. It is a real
control with a `<label htmlFor>` bound to its id and `aria-describedby`
pointing at the consequence, so the whole sentence is the hit target and the
control is reachable and toggleable by keyboard alone.

Nothing is sent unless the box was actually shown and ticked. A client that
sent `true` regardless would stamp an audit record saying a person decided
something they were never shown.

Backend enforcement stays off until an operator enables it; until then this is
a client that asks and a backend that records.
