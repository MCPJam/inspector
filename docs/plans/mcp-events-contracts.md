# MCP Events: core contracts (C1–C10), as built

Status: settled contracts for the implementation of [`mcp-events.md`](./mcp-events.md). Each component codes against this page. A change here is a change to every component, so it goes in the same PR as the code that needs it.

Draft pin: `modelcontextprotocol/experimental-ext-triggers-events` @ [`28ec35e`](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/28ec35e905daa241f019981e2836b4a02f1c0368/docs/design-sketch-proposal.md).

## Where each contract lives in code

| Contract | Inspector repo | Backend repo |
|---|---|---|
| C1 profiles | `sdk/src/events/profiles.ts` | — |
| C2 identity | `sdk/src/events/identity.ts` | `events-inbox/src/identity.ts` (mirror, pinned digests) · `convex/lib/eventIdentity.ts` (mirror) |
| C3 registration | `sdk/src/events/coordinator.ts` (client side) | `events-inbox/src/inbox.ts` (receiver side) |
| C4 registry | `sdk/src/events/coordinator.ts` (keeper rules) | `convex/eventSubscriptions.ts` |
| C5 journal | — | `events-inbox/src/inbox.ts` |
| C6 executor | `mcpjam-inspector/server/services/events/executor.ts` | `convex/eventTriggerRuns.ts` |
| C7 authorization | `mcpjam-inspector/server/services/events/viewer-token.ts` | `events-inbox/src/viewer-token.ts` |
| C8 redaction | `sdk/src/mcp-client-manager/rpc-log-redaction.ts` | `events-inbox` rejection records |
| C9 coordinator | `sdk/src/events/coordinator.ts` | — |
| C10 capability capture | `sdk/src/mcp-client-manager/events-capability-capture.ts` | — |

## C1. Profiles

`EventsProfileId = "draft@28ec35e" | "chatgpt@2026-09-30"`. Development overrides are a separate `overrides` set on a run and are never a profile.

Every profile field carries a provenance tag:

- `documented`: from the draft or OpenAI docs, with the URL.
- `observed`: we saw it happen, with the date and the probe that saw it.
- `policy`: MCPJam's own choice, labelled as ours.
- `unobserved`: a field whose value needs a live observation that has not run yet. It is never shown as fact.

Error codes `-32011`…`-32015` are classified only for `events/*` methods (`classifyEventsRpcError(method, error)` returns `undefined` for any other method).

## C2. Identity

All derived keys are `sha256Hex(canonicalJson(value))`. Canonical JSON is the RFC 8785-style serializer in `@mcpjam/evaluators/internal/contract/canonical`: sorted keys, `undefined` properties dropped, `-0` normalized. The inbox and Convex mirror it and pin the digests in the table below.

```ts
bindingKey  = H({ v: 1, kind: "binding",  serverId, credentialOwnerUserId, credentialFingerprint: string | null })
deliveryKey = H({ v: 1, kind: "delivery", projectId, environmentId: string | null, bindingKey, logicalSubscriptionId, eventId })
controlKey  = H({ v: 1, kind: "control",  projectId, environmentId: string | null, bindingKey, logicalSubscriptionId, webhookId })
runKey      = H({ v: 1, kind: "run", namespace, projectId, environmentId: string | null, bindingKey, logicalSubscriptionId, triggerId, eventId })
```

- `namespace` is `"live"`, `"simulation"`, or `"replay:<replayId>"`. Simulated and replayed events can never collide with, or suppress, a live run.
- Pinned test vector (the inbox and Convex tests assert the same literals):
  - `bindingKey({serverId:"srv_1", credentialOwnerUserId:"user_1", credentialFingerprint:null})`
  - `deliveryKey({projectId:"proj_1", environmentId:null, bindingKey:<above>, logicalSubscriptionId:"esub_1", eventId:"evt_1"})`
  - `runKey({namespace:"live", …same…, triggerId:"trg_1", eventId:"evt_1"})`

  Pinned digests (`sdk/src/events/__tests__/identity.test.ts` is the source of truth; the mirrors assert the same literals):

  | Key | Digest |
  |---|---|
  | `bindingKey` | `a53dbd56bcdde0a36163ff4e93273ed93f05675fb3880daf645e664525d9dea7` |
  | `deliveryKey` (`eventId: "evt_1"`) | `49ae844572c04ce0a222dc947197b4d2e06e898d6438d5d5d856c50898059bdb` |
  | `controlKey` (`webhookId: "msg_gap_1"`) | `a6530fbaa491b23a0c18a9e62d0358143162eb40ac8382ddb162ef9a48cd22d4` |
  | `runKey` (`namespace: "live"`) | `7883b3f010b6dcd0398c74810ec34c1b4b2ae1ecdda4e84e1cab3adffe8c3f68` |
  | `runKey` (`namespace: "simulation"`) | `e4692945e7a17df513f8b3059276ff97765fb1c853eb2731b24050c72baf5688` |

- A run freezes, at schedule time, a snapshot of `{trigger: {id, revision, instructions, modelId, approvalPolicy, hostProfile, maxSteps}, event, subscription: {id, generation, bindingKey, serverId, environmentId}}`. Retries read only the snapshot.

## C3. Registration and rotation

Callback URL: `https://hooks.mcpjam.com/i/{inboxId}/s/{slotId}`. `inboxId` and `slotId` are random 128-bit base32 ids; they are routing, not credentials.

Slot states: `pending → active → removed`. A pending slot also becomes `expired` after `pendingTtlMs` without reconciliation. An expired or removed slot is never reconciled again (`409 slot_expired` / `slot_removed`). `getSecret` also reports the slot's effective `state`; a keeper that finds its slot `expired` (a first subscribe retried past the TTL) allocates a fresh one instead of subscribing a URL that answers `410`.

Reconciliation: the id `events/subscribe` returns is bound to the slot. A different id on a bound slot is a conflict: reported to the keeper, never overwritten. The one exception is pause: the draft does not require a server to reuse an id after `events/unsubscribe`, so once the unsubscribe succeeds the keeper calls `unbind`. The slot goes back to `pending`, keeping its secret, overlap and URL, with the reconciled id cleared and no pending expiry, because a paused subscription holds its slot. Resume's id, new or reused, then binds as a first reconciliation. `unbind` is idempotent and refused on an expired or removed slot.

| Delivery to slot in state | Signature valid | Result |
|---|---|---|
| `pending` (not expired) | yes | verification: echo `{challenge}` · event/control: journal, record observed `X-MCP-Subscription-Id`, `2xx` |
| `active` | yes | as above; an `X-MCP-Subscription-Id` different from the reconciled id is journalled with `idConflict: true` and counted |
| `removed` | yes | journalled with `dispatch: "none"`, `2xx`; the late delivery is reported to the keeper (control dispatch) |
| `expired` / unknown | — | `410 Gone`, bounded rejection record |
| any | no / stale (> 300 s) | `401`, bounded rejection record; never creates or changes a binding |

Verification bodies are answered only when correctly signed with the slot's current or overlapping secret. They are never journalled as events.

Rotation: `rotate` puts a new secret on the slot and keeps the previous one for `overlapMs` (default 10 min). The keeper subscribes with the new secret, and only after a successful response calls `retirePrevious`. If the outcome is unknown, the keeper retries subscribe with the new secret; it does not retire the old one.

## C4. Registry and keeper fencing

Convex table `eventSubscriptions`, one row per logical subscription:

```ts
{
  projectId, organizationId, environmentId?: Id<"projectEnvironments">,
  ownerUserId,                       // whose credentials the binding uses
  logicalId: string,                 // "esub_…", stable across refreshes and mode changes
  binding: { serverId, credentialOwnerUserId, credentialFingerprint: string | null },
  bindingKey: string,                // C2
  locality: "hosted" | "local",
  profile: EventsProfileId, protocolVersion?: string,
  eventName: string, arguments: any, argumentsHash: string,
  descriptor?: { hash: string, payloadSchema?: any, delivery: string[] },
  mode: "webhook" | "poll" | "push",
  desiredState: "active" | "paused" | "removed",
  observedState: "pending" | "active" | "error" | "terminated" | "paused_auth" | "removing" | "removed",
  generation: number,
  lease?: { holder: string, token: string, expiresAt: number },
  nextActionAt: number,
  refreshBefore?: number | null, lastCursor?: string | null,
  inboxId?: string, slotId?: string, callbackUrl?: string,
  serverSubscriptionId?: string, conflictingServerSubscriptionId?: string,
  deliveryStatus?: any, lastError?: { kind, message, at, retryable },
  consecutiveFailures: number, removedAt?: number, settledRemovalAt?: number,
  createdAt, updatedAt,
}
```

- Every keeper write is `commit({id, leaseToken, generation, patch})`, which refuses unless the row still has that lease token and generation. A stale keeper's write fails with `stale_generation` or `lease_lost`.
- User edits (pause, resume, remove) bump `generation`. Removal writes the tombstone first: `desiredState: "removed"`, `observedState: "removing"`.
- A removed row's deliveries still land in the journal. Enqueue answers `subscription_removed` and schedules nothing.
- After a successful unsubscribe the keeper schedules one more unsubscribe after `lateRefreshWindowMs` (the longest a refresh can be in flight, 2 × the request timeout). It also schedules one whenever the inbox reports a delivery on the removed slot. Only then is `observedState: "removed"` final.
- Auth loss is a `401`/`403` from the MCP transport or an OAuth refresh failure. It sets `observedState: "paused_auth"`, and the row is not retried until the user reauthorizes, which bumps `generation` and resets `nextActionAt`.
- `locality: "local"` rows are never claimed by the hosted keeper.

## C5. Inbox: journal, dispatch, feed

Worker `hooks.mcpjam.com`, one Durable Object per `inboxId` (SQLite storage). Delivery handling runs in a single `transactionSync`:

1. Dedupe on `deliveryKey` (events) or `controlKey` (control envelopes). A duplicate returns `2xx` with no new entry.
2. Append a journal row with a monotonic `seq`.
3. If the slot is dispatchable (`dispatch_enabled` and not removed), insert a `pending` dispatch state on the row and arm the alarm.

`2xx` is returned only after the transaction commits.

Positions: the upstream `cursor` is stored on the journal row and never used for reads. Reads use `seq`. Consumers are named checkpoints, for example `viewer:<userId>`; the runner is the dispatch state machine, not a checkpoint, so a viewer can never consume runner work.

Dispatch: the alarm POSTs batches (≤ 25) to `POST {INSPECTOR_INTERNAL_ORIGIN}/api/internal/events/enqueue` with header `x-events-inbox-token: EVENTS_INBOX_DISPATCH_TOKEN`:

```ts
// request
{ inboxId, deliveries: Array<{
  seq, deliveryKey, kind: "event" | "gap" | "terminated" | "late_delivery_after_removal" | "id_conflict",
  slotId, logicalSubscriptionId, projectId, environmentId: string | null, bindingKey,
  origin: "webhook" | "poll" | "push" | "simulation" | "replay",
  namespace: "live" | "simulation" | `replay:${string}`,
  eventId?: string, name?: string, timestamp?: string, data?: object, cursor?: string | null,
  webhookId?: string, serverSubscriptionId?: string | null, receivedAt: number,
}> }
// response 200
{ results: Array<{ deliveryKey, outcome: "scheduled" | "no_triggers" | "subscription_removed" |
  "unknown_subscription" | "quarantined" | "control_recorded", runIds: string[] }> }
```

- Any non-200 leaves the batch pending. Retries use exponential backoff from 5 s to 10 min.
- A pending row older than `pendingWorkTtlMs` (72 h, MCPJam policy) gets a terminal `dispatch_expired` and an inbox gap entry.
- Viewer feed: `GET /i/{inboxId}/deliveries?after=<seq>&limit=` returns `{entries, nextAfter, gap?}`. `GET /i/{inboxId}/stream?after=<seq>` is SSE: the DO writes the backlog and registers the live listener in one synchronous step, so no entry falls between them. Both require `Authorization: Bearer <viewer token>` (C7).
- Poll ingestion: `POST /admin/i/{inboxId}/append` with `{slotId?, logicalSubscriptionId, batchId, origin, entries: EventOccurrence[] | control[]}`. It is idempotent on `batchId` and dedupes per entry on `deliveryKey`. The coordinator advances its upstream cursor only after this returns 200.
- Capacity (MCPJam policy, open question 1): 1 000 undispatched entries per inbox, beyond which webhooks get `503` with `Retry-After` and appends get `503`. UI history is the last 5 000 entries or 7 days. The dedupe window is 7 days. A pruned range that a viewer asks for is answered with an explicit `gap`.
- `GET /.well-known/mcp-webhook-receiver.json` returns `{"receivers":["/i/"]}` (draft consent method d).

Admin API (header `x-events-inbox-admin-token: EVENTS_INBOX_ADMIN_TOKEN`, used only by the inspector):

| Route | Body → result |
|---|---|
| `POST /admin/i/{inboxId}/slots` | `{logicalSubscriptionId, projectId, environmentId, bindingKey, dispatch, pendingTtlMs?}` → `{slotId, callbackUrl, secret}` |
| `POST /admin/i/{inboxId}/slots/{slotId}/secret` | → `{secret, previousSecret?}` (keeper refresh; never logged) |
| `POST …/reconcile` | `{serverSubscriptionId}` → `{state, conflict?}` |
| `POST …/rotate` | `{overlapMs?}` → `{secret}` |
| `POST …/retire-previous` | → `{}` |
| `POST …/dispatch` | `{enabled}` → `{}` |
| `POST …/remove` | → `{}` (tombstone) |
| `GET  …/state` | → slot state, counts, recent rejections |
| `POST /admin/i/{inboxId}/append` | see above |
| `POST /admin/i/{inboxId}/viewer-epoch` | → `{epoch}` (bumps: revokes every viewer token) |

## C6. Jobs and the event-job executor

Convex `eventTriggers` rows (`projectId, environmentId, subscriptionId, name, instructions, enabled, revision, modelId?, approvalPolicy: "deny_writes" | "auto_deny", maxSteps, rateLimitPerHour, spendCapMicrosPerDay, batching: "off"`) and `eventTriggerRuns` jobs (lease fields from `lib/leasedSteps.ts`, `runKey` unique per project, `status: pending | running | completed | failed | parked | skipped`, `namespace`, `conversationKey`).

- Enqueue is one internal mutation for the whole batch. For each delivery it inserts at most one run per enabled trigger, keyed by `runKey`, and a repeat returns the existing run ids. The run's frozen input goes into `eventTriggerRunPayloads` (key `input`) in the same mutation, so the inbox may reclaim the entry once dispatch is acknowledged.
- The executor claims with a lease, resolves the environment named in the snapshot, and connects its servers with `createAuthorizedManager` under the trigger owner's delegated bearer. It runs `runUnifiedAssistantTurn` with `sourceType: "event"`, `origin: "event"`, `streamSink: "none"`, `persistMode: "caller"` and `approvalMode: "auto-deny"`. Event data is passed as an untrusted context block, never as instructions.
- Approval policy is snapshotted with the run. `deny_writes` (the default) runs only tools every server marks `readOnlyHint: true`, and denies the rest before any effect. `auto_deny` runs write tools too, with the turn engine's `approvalMode: "auto-deny"`, so a tool that would need interactive approval is denied: nobody is watching.
- Every tool call is journaled (`beginCall` / `finishCall`). A call that began and never finished is `tool_outcome_unknown`: the run parks with that reason instead of re-executing.
- Ordering: one running run per `conversationKey` (`trigger:<triggerId>`), FIFO by `createdAt`.
- Budgets: each trigger has a rate limit (runs per hour) and a daily spend cap, checked in the claim mutation before a run starts. Per-step spend is reserved by the existing `/stream` precheck, whose reservation is atomic across replicas. A refusal ends the run with `spend_refused`, not a retry loop.

## C7. Authorization

| Point | Check |
|---|---|
| Register receiver (allocate slot) | inspector: project `member` for the subscription's project; admin token to the inbox |
| Issue viewer token | inspector: project `member` now; token `{inboxId, projectId, userId, epoch, exp ≤ 10 min, scope: "feed:read"}` HMAC-signed with `EVENTS_INBOX_VIEWER_KEY` |
| Refresh | keeper: Convex re-checks the owner is still a project member and the binding's server is still in the project before leasing |
| Author a trigger (create, edit, enable) | Convex: the caller is the subscription's **owner**. A run acts with the owner's credentials, so no one else (a project admin included) decides what it does |
| Stop a trigger (disable, remove) | Convex: the owner or a project admin; stopping runs nothing, and a run already in flight stops at its next checkpoint or tool call |
| Simulate an event | inspector: project `member`, the subscription is in the project, and `eventSubscriptions:authorizeSimulation` (read with the caller's bearer) confirms the caller owns it; a simulated event runs the triggers with the owner's credentials |
| Dispatch a run | enqueue mutation: subscription not removed, trigger enabled, owner still a member |
| Start a run | claim mutation: trigger enabled, subscription neither removed nor paused, owner still authorized (a refusal parks the subscription `paused_auth`), then the rate limit and spend cap |
| Keep a run acting | `runs/checkpoint` and `runs/begin-call`: the claim's authority checks again, before the step or tool call. A refusal ends the run `failed` with the reason and takes back its lease, so the executor gets `409 lease_lost` and stops |
| Execute tools | executor: delegated bearer for the owner, `createAuthorizedManager` re-authorizes each server |

The feed connection closes at token expiry; the client reconnects with a fresh token, which re-runs the membership check.

## C8. Redaction

`redactRpcMessageForLog(message)` runs inside `wrapTransportForLogging` before any logger sees a frame. It returns a copy with:

- `params.delivery.secret` → `"whsec_<redacted>"` on any request;
- credential-shaped query and fragment parameters in `params.delivery.url` redacted (`redactUrlSecrets`);
- any string anywhere in an `events/*` request, response, or notification that parses as a `whsec_` secret → `"whsec_<redacted>"`.

The object handed to `inner.send` is the original. The inbox stores rejection metadata only as `{reason, slotId?, at, headerNames, bodyBytes}`: never bodies or signature values.

## C9. Coordinator

`sdk/src/events/coordinator.ts` exports `EventsCoordinator` over ports:

```ts
interface EventsCoordinatorPorts {
  clock: { now(): number };
  rpc(record: SubscriptionRecord): Promise<EventsRpcPort>;           // credentials live behind this port
  inbox: InboxPort;                                                   // allocate/secret/reconcile/unbind/rotate/retire/remove/append
  onDescriptorsChanged?(serverKey: string): void;
}
step(record: SubscriptionRecord): Promise<StepOutcome>              // one lifecycle transition, never loops forever
```

`StepOutcome = { patch: Partial<SubscriptionRecord>, nextActionAt: number, appended?: number, error?: ClassifiedFailure }`. The keeper commits `patch` with CAS (C4). Poll drains `hasMore` for at most `maxPagesPerStep` (default 5) before yielding, so one noisy subscription cannot starve the rest. `nextPollMs` gets a floor of `max(1000, profile floor)`. `challenge_failed` stops retrying after `maxChallengeFailures` (default 5) consecutive challenge failures. Failures of other kinds before them do not count: `consecutiveFailures`, and the backoff with it, restarts at 1 when the previous `lastError.kind` was something else.

## C10. Capability capture

`EventsCapabilityCapture.observe(rpcEvent)` correlates outgoing `initialize` / `server/discover` requests to their responses and records the raw `result.capabilities.events` (top-level; `undefined` when the server did not declare it). It is reset on `clear(serverId)`, which the manager calls on connect, disconnect, and protocol switch. It also keeps the whole raw `capabilities` object, so the Events tab can show exactly what the server sent.

## Backend HTTP API (Convex, `/internal/v1/events/*`)

Every route takes header `x-inspector-service-token: INSPECTOR_SERVICE_TOKEN` (`isAuthorizedInspectorServiceRequest`, fail-closed) and a JSON body. They are registered from `convex/eventRoutes.ts` (`registerEventRoutes(http)`).

| Route | Body → 200 result | Errors |
|---|---|---|
| `inboxes/ensure` | `{projectId}` → `{inboxId}` | 404 unknown project |
| `subscriptions/claim` | `{holder, limit?, leaseMs?}` → `{items: Array<{subscription, leaseToken, generation, ownerExternalId, organizationId}>}` | — |
| `subscriptions/commit` | `{subscriptionId, leaseToken, generation, patch, release?}` → `{ok: true, generation}` | 409 `{error: "stale_generation" \| "lease_lost"}` |
| `subscriptions/get` | `{subscriptionId}` → `{subscription}` | 404 |
| `subscriptions/control` | `{inboxId, logicalSubscriptionId, kind, cursor?, error?, serverSubscriptionId?, at}` → `{ok}` | — |
| `enqueue` | C5 request → C5 response | — |
| `runs/claim` | `{holder}` → `{claim: null}` or `{claim: {run, token, input, messages, step, calls, ownerExternalId, organizationId}}` | — |
| `runs/checkpoint` | `{runId, token, messages, step}` → `{ok}` | 409 `lease_lost` |
| `runs/begin-call` | `{runId, token, callId, operation, input, replayable}` → `{replay: boolean, result?}` | 409 `lease_lost` · 409 `tool_outcome_unknown` |
| `runs/finish-call` | `{runId, token, callId, result}` → `{ok}` | 409 `lease_lost` |
| `runs/finish` | `{runId, token, status: "completed" \| "failed" \| "parked", result?, error?, costMicros?, chatSessionId?}` → `{ok}` | 409 `lease_lost` |

The client calls user-facing Convex functions directly, all project-member checked:

- `eventSubscriptions:{list, get, create, setDesiredState, reauthorize}`
- `eventTriggers:{list, create, update, setEnabled, remove}`
- `eventTriggerRuns:{listForTrigger, listForProject, get}`

## Inspector routes

Types: `mcpjam-inspector/shared/events-api.ts`.

**Local (`/api/mcp/events/*`, local mode only).** These routes drive the singleton manager and the local events runtime: an in-memory registry, `MemoryEventInbox`, and the coordinator loop.

| Route | Body → result |
|---|---|
| `POST support` | `{serverId}` → `{support, rawCapabilities?, protocolVersion?}` |
| `POST list` | `{serverId, cursor?}` → `EventsListResponse` |
| `POST poll` | `EventsPollRequest` → `EventsPollResponse` (one-off; not a subscription) |
| `GET subscriptions?serverId=` | → `{subscriptions: EventsSubscriptionView[]}` |
| `POST subscriptions` | `EventsCreateSubscriptionRequest` → `{subscription}` |
| `POST subscriptions/:id/state` | `{desiredState}` → `{subscription}` |
| `POST subscriptions/:id/rotate` | → `{subscription}` |
| `POST simulate` | `EventsSimulateRequest` → `{entry}` (namespace `simulation`) |
| `GET feed?after=` | → `{entries, nextAfter}` |
| `GET stream?after=` | SSE of `EventsStreamFrame` |
| `POST hooks/i/:inboxId/s/:slotId` | the local development receiver. Plain http on the inspector's own port, labelled `insecure-local-receiver`, never a conformance pass; unauthenticated and signature-verified. |

**Hosted (`/api/web/events/*`, bearer auth).** Server operations use `withEphemeralConnection`; the registry is Convex, called from the client.

| Route | Body → result |
|---|---|
| `POST list` | `projectServerSchema` + `{cursor?}` → `EventsListResponse` |
| `POST poll` | `projectServerSchema` + poll params → `EventsPollResponse` |
| `POST viewer-token` | `{projectId}` → `EventsViewerTokenResponse` (checks membership) |
| `POST simulate` | `{projectId} & EventsSimulateRequest` → `{accepted}` |
| `POST slot-state` | `{projectId, subscriptionId}` → `EventsSlotStateResponse` |

**Internal.**
- `POST /api/internal/events/enqueue`: inbox dispatch (header `x-events-inbox-token`). It validates payloads against the subscription's descriptor, quarantines malformed ones, forwards to Convex `enqueue`, and rings the executor.
- `POST /api/internal/events/dispatch`: executor doorbell (service token).
