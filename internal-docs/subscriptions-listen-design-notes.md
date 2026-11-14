# `subscriptions/listen` — coordinator design + follow-on surfaces

Status: the **shared SDK coordinator** landed
(`sdk/src/mcp-client-manager/subscription-coordinator.ts`). Everything under
"Follow-on surfaces" below is deliberately **not built yet** and is described
here so the next PRs do not have to re-derive the model. Auto-negotiation
activation is also a later step.

## 1. The state model (era-neutral, adapter-specific)

The 2025-era model — *a set of subscribed resource URIs plus two RPCs, and
unsolicited list-changed notifications on whatever channel happens to be open*
— is not extended. It cannot express the facts a debugger needs: which filter
was requested, which subset the server agreed to, which stream a notification
arrived on, and why a stream ended.

**Desired interests** (what the user wants, era-independent):

```ts
{ toolsListChanged?, promptsListChanged?, resourcesListChanged?, resourceUris? }
```

**Streams** (zero or more, per connection):

| field                                     | meaning                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `localId`                                 | MCPJam-local identity, stable for the record's lifetime                       |
| `mcpSubscriptionId` / `idBinding`         | the listen request's JSON-RPC id, and whether it was reported or observed     |
| `requestedFilter`                         | what we sent                                                                  |
| `acknowledgedFilter`                      | what the server agreed to — a **separate** fact, never inferred               |
| `rejectedInterests`                       | selections dropped by capability gating or absent from the ack                |
| `status`                                  | `opening \| active \| graceful-closed \| remote-closed \| cancelled \| error` |
| `closeReason`                             | `graceful \| remote \| local-abort \| error`                                  |
| `openedAt` / `acknowledgedAt` / `closedAt`| lifecycle timing                                                              |
| `reconnectAttempt`                        | bounded re-listen counter                                                     |

**Legacy adapter** — the existing list-changed handlers plus
`resources/subscribe` / `resources/unsubscribe` per URI, modelled as one
synthetic always-`active` stream (no ack exists on that era; the successful
subscribe calls *are* the acknowledgement, recorded as such).

**Modern adapter** — one explicit `client.listen(filter)` →
`McpSubscription`. Resource URIs ride in `resourceSubscriptions`. A listen
filter is immutable, so a change in desired interests is a controlled
close+reopen. A remote loss re-listens; it never resumes (there is no
`Last-Event-ID` / replay for listen streams). Multiple concurrent
subscriptions are legal.

## 2. Deliberate choices

- **Explicit `listen()` over `ClientOptions.listChanged`.** The auto-opened
  subscription (`client.autoOpenedSubscription`) hides the requested filter,
  the subscription identity, the ack timing and the close reason. MCPJam is a
  debugger; it drives `listen()` itself so all four are observable.
- **Advertise = enforce, and show the absence.** A selection the server does
  not advertise is omitted from the requested filter and recorded as
  `capability-not-advertised`; a requested selection missing from the ack is
  recorded as `not-acknowledged-by-server`. Neither is silently dropped.
- **Ack before active.** A stream is `opening` until the acknowledgement is
  observed; notifications arriving before that are refused
  (`stream-not-active`), not delivered.
- **Handlers registered once, demux by subscription id.** Per-stream handler
  registration would fan one notification out to every stream.
- **Unrequested types are refused** (`unrequested-type`) and kept in a
  rejection log rather than delivered.
- **Request-scoped notifications stay out.** `notifications/progress` and
  `notifications/message` belong to the originating request's stream; the
  coordinator never registers them.
- **Refresh never hides the trigger.** `onNotification` fires before
  `onStale`, always.

### Known SDK gap

`McpSubscription` in `@modelcontextprotocol/client@2.0.0-beta.4` does not
expose the listen request id. The coordinator therefore accepts an optional
`subscriptionId` on the handle and otherwise **observes** the id from the first
stamped message on the stream, but only when exactly one stream is awaiting a
binding; otherwise the notification is recorded as
`unknown-subscription-id` rather than guessed. If upstream later exposes the
id, `idBinding` flips from `observed` to `reported` with no other change.

## 3. Follow-on surfaces (NOT built in this PR)

### 3.1 Local Inspector / desktop UI

- Show stream lifecycle and both filters in History: open → ack (with the
  acknowledged subset and any rejected selections) → close, with the close
  reason and timings.
- On a **modern** server, replace the per-resource Subscribe/Unsubscribe
  buttons with *desired-filter* edits plus an explicit, visible reopen — the
  buttons would otherwise imply per-URI RPCs that no longer exist.
- On a **legacy** server, keep the existing Subscribe/Unsubscribe buttons; the
  legacy adapter still drives the two RPCs.
- Render rejected interests inline (absence must be visible), and show a
  re-listen as a new stream row, not as a silent continuation of the old one.

### 3.2 CLI mode

- Open a filter from flags; print the acknowledgement as a distinct event
  (requested vs acknowledged), then stream notifications tagged with their
  subscription id.
- Clean signal exit (SIGINT/SIGTERM ⇒ `close()` ⇒ `local-abort`), and a final
  report that distinguishes graceful completion from remote loss.
- Optional bounded re-listen, off by default, attempt count reported.
- Structured JSON on stdout with **no human-readable text mixed in**; human
  text goes to stderr.

### 3.3 Hosted passthrough route — **INFRA INVESTIGATION GATE**

Not to be built until these are answered, since each can silently break a
long-lived downstream stream:

- proxy / load-balancer idle timeouts and whether keepalive frames are needed;
- abort propagation from the browser through the route to the upstream listen;
- disposal on replica shutdown / deploy;
- cost ceiling for max simultaneously open streams per replica;
- auth/token refresh *during* a long stream;
- sticky-connection duration limits;
- browser reconnect behavior after a replica restart.

Architectural constraint regardless of the answers: **each long-lived
downstream stays on the replica that owns it.** Do not write every notification
to Convex to cross replicas — that turns a debugging stream into a persistent
write firehose and reorders/delays the very events being debugged.

## 4. Tests

`sdk/tests/subscription-coordinator.test.ts` — dual-era, in-memory fixture that
emits an acknowledgement then notifications tagged with subscription ids:
ack-before-active; unrequested-type refused; requested vs acknowledged tracked;
concurrent streams demuxed by id; graceful vs remote close; bounded re-listen
after remote loss; local abort ⇒ `cancelled`; legacy adapter still drives
`resources/subscribe` + list-changed.
