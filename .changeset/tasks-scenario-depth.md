---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Extend the Tasks suite past "create and poll".

The Tasks suite already ran a multi-step create/poll flow, but it only ever
observed a task that ran to completion on its own. Six requirements the
extension states were untested:

- **`tasks-invalid-task-id-rejected`** — `tasks/get` for an id the server never
  issued must answer `-32602`. The same rejection on `tasks/update` and
  `tasks/cancel` is only a SHOULD, so a different code there warns rather than
  fails. This one needs no created task, so it establishes something real even
  on a run that could not provoke one.
- **`tasks-status-payload-shape`** — `completed` carries `result`, `failed`
  carries `error`, `input_required` carries `inputRequests`. Read from RAW
  inbound frames, because the SDK's own payload schema rejects a `failed` task
  with no `error` before any check could see it — reading the decoded task would
  score a server green on exactly the state the check exists to catch.
- **`tasks-cancel-ack-shape`** — `tasks/cancel` must be acknowledged with an
  empty result. It deliberately does *not* require the task to become
  `cancelled`: the spec says cancellation is eventually consistent and the
  status "MAY remain working … and MAY ultimately reach a terminal status other
  than cancelled".
- **`tasks-input-required-update-completes`** — the `input_required →
  tasks/update → completion` round trip, gated on a new `inputResponses` option
  (`--input-responses` on the CLI). What a task asks for is server-defined, so
  inventing an answer would submit arbitrary content into somebody's workflow.
- **`tasks-ttl-integer-shape`** — `ttlMs` and `pollIntervalMs` are integer
  milliseconds per the extension's `Task` interface. A negative value only
  warns: the spec states no lower bound and spells "unlimited" as `null`.
- **`tasks-undeclared-capability-names-requirements`** — a `-32021` must carry
  `error.data.requiredCapabilities`. A client told it is missing a capability,
  but not which one, cannot act on the error. Rides the existing undeclared
  probe round, so it costs no extra traffic.

Polling also stops as soon as a task parks on `input_required`. Such a task
cannot advance without a client answer, so the old behavior spent the whole
`pollTimeoutMs` arriving at the state already in hand, and every dependent check
reported its gap seconds later than it had to.

All six land in a new `mcp-tasks` conformance profile's pending bucket, so they
report real verdicts and move no score. `mcp-tasks` is separate from
`mcp-protocol` on purpose: a shared manifest would make a tasks addition bump
the protocol denominator, so a server that never implemented the extension would
see its protocol score's meaning change because we learned something about
tasks.

Not included: a `notifications/tasks` check. It needs a live
`subscriptions/listen` SSE stream and the extension fixture never opens one;
shipping a probe that cannot be validated against a fixture is how a conformance
suite acquires a flaky check.
