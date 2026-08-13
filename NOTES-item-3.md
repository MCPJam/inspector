# NOTES — item 3 (validation step)

**Status: not started. Blocked transitively, with nothing coherent to ship.**

Item 3 adds the validation step to the endpoint item 2 was to create. That endpoint does not
exist — see NOTES-item-2.md for the blocker (the connection-request state machine is entirely
`internal*` and has no `/internal/v1/*` HTTP surface, so the Inspector cannot acquire a lease or
report a result).

Unlike item 2, item 3 has **no unblocked half worth extracting**, which is why this note ships
without code beside it:

- Step 1, "resolve the acting user's credential and exercise normal refresh resolution", reads a
  credential the backend owns. There is no path to it for the same reason there is no path to the
  state machine.
- Step 2, "connect to the saved server", needs the server row that item 2's later work creates.
  Discovery deliberately creates nothing.
- Step 3, capability capture, is a thin wrapper over the doctor's existing
  `collectConnectedHttpServerDoctorState` and is not worth a module on its own.

The one piece that *would* have been extractable — the outcome→taxonomy mapping — is a four-line
table over a credentialed connection attempt, and every arm of it is a claim about a live
connection's failure mode. Pinning it against a hand-built fake with no connection behind it would
test the fake.

## What must be preserved when someone builds it

Recording these because they are the parts a later implementer is most likely to get subtly wrong,
and both are stated in the brief:

**A server with no tools is still connected.** Successful `initialize` *is* readiness. An empty
tool list is a legitimate server, not a failure — treating it as one would reject working servers
at the last step of the flow.

**`retryable` and `authentication-failed` are not interchangeable.** The mapping is:

| condition | outcome |
| --- | --- |
| `initialize` succeeded | `ready` |
| 401 / invalid token | `authentication-failed` |
| network / timeout | `retryable` |
| invalid MCP response | `terminal` |

The reason the middle two must not collapse: `retryable` leaves the request in `validating` and
schedules another attempt, so a stored credential survives a server that was briefly unreachable.
`authentication-failed` sends the user back to consent. Mapping a transient network failure onto
`authentication-failed` would ask a user to re-authorize a server whose credential was never
invalid — and they would do it, because the message told them to.

This is the same distinction the discovery classifier already enforces on its own side
(`error` → `retryable`, never a discovery result), and it is tested there in
`server/services/__tests__/server-connection-discovery.test.ts`. The validation step should be
tested the same way, including the empty-tool-list case and the assertion that a `retryable`
report leaves the status unchanged.
