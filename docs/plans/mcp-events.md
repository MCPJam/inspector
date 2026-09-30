# MCP Events (triggers) in MCPJam

Status: proposed implementation plan, revised 2026-09-30 after the plan audit. Evidence was checked against `mcpjam-inspector` `main` at `48baa44108` and `origin/main` at `130b2179dd` (neither contains any events code), and against `mcpjam-backend` `main`, on 2026-09-30. The audit document itself is not in this repository; its findings are summarised below. **Implementation status** is at the end of this page. The concrete contracts every component codes against are in [`mcp-events-contracts.md`](./mcp-events-contracts.md).

Audience: whoever implements this, human or agent. Phases are ordered by dependency. A phase is done when its exit gate is proven, not when its code merges.

### Revision 2026-09-30: audit amendments

The audit kept the overall direction: the SDK extension boundary, a separate public receiver on a Worker and Durable Object, and reuse of the shared turn engine. It found that the first version described features without the reliability rules underneath them. All nine findings are adopted. The audit's line references point at the first version (SHA-256 `dc6e9527…`).

What changed:

- **New [Core contracts](#core-contracts) section.** It must be settled before any UI work. It covers:
  - the durable delivery journal and dispatch (audit 1)
  - separate delivery and run identities instead of `eventId` alone (audit 2)
  - a registration state that exists before the server returns its subscription id (audit 3)
  - a subscription registry bound to an account, with leases, generations and tombstones (audit 4)
  - secret redaction at the existing RPC capture boundary (audit 5)
  - a new event-job executor, because the durable agent runner only reaches MCPJam's own platform tools (audit 6)
  - one shared event coordinator instead of loops in each surface (audit 8)
- **Conformance is split into a pinned draft profile and a dated ChatGPT profile**, with MUST and SHOULD kept apart. Checks that would have failed allowed behaviour are corrected (audit 7).
- **Plain-http localhost is no longer a normal option.** It breaks the draft's HTTPS requirement, and the public inbox makes it unnecessary for local development.
- **The ChatGPT probe records only what's externally observable.** Documented behaviour, dated observations and MCPJam policy are kept separate. Retention and capacity are now MCPJam's own stated policy (audit 9).
- **The order changed.** Contracts come first, then one narrow webhook-to-agent path with crash recovery and a real tool call. Poll goes through the same ingestion path, and surfaces expand only after that. Hosted push stays deferred, and the support matrix says so.

The audit's three most specific code claims were checked and hold:
- The SDK transport logger forwards whole outgoing messages without redaction (`sdk/src/mcp-client-manager/transport-utils.ts`).
- The internal agent-turn dispatcher calls `/api/v1/projects/:id/agent`, which runs with curated platform operations as its tools (`server/routes/internal/agent-turns.ts`, `server/routes/v1/agent.ts`).
- Backend jobs are deduplicated by user and request key, and a repeated key with changed input is rejected (`backend:convex/agentTurnState.ts`).

## What MCP events are

MCP events let a server tell a client that something happened (a new comment, a failed build, an incoming email) so an agent can react without anyone typing. Tools let the model ask an app for something; events let the app tell the model.

The client subscribes with an event name and filter arguments. The server delivers each occurrence as `{eventId, name, timestamp, data, cursor}`. A host such as ChatGPT pairs each event with the user's standing instruction ("when someone comments on this doc, reply") and starts an agent turn.

The draft defines three ways to deliver events:

| Mode | Method | How events arrive |
|---|---|---|
| Poll | `events/poll` | The client asks repeatedly. The server returns `events[]`, `cursor`, `hasMore` and `nextPollMs`. |
| Push | `events/stream` | One long-lived request per subscription. Events arrive as `notifications/events/event`, with periodic heartbeats (a MUST; every 30 seconds is a SHOULD). |
| Webhook | `events/subscribe` / `events/unsubscribe` | The server POSTs each event to an HTTPS callback URL chosen by the client. |

Webhook details that matter for this plan:

- **Signing:** the client supplies the secret (`whsec_` followed by base64 of 24–64 bytes). Deliveries are signed per Standard Webhooks with `webhook-id`, `webhook-timestamp` and `webhook-signature`, plus `X-MCP-Subscription-Id`, the server's subscription id.
- **HTTPS is required.** Callback URLs must be `https`.
- **Proving the receiver agreed.** Before delivering anything, the server must confirm the endpoint wants deliveries. It can use any of four methods:
  - a signed `{type:"verification", challenge}` that the receiver must echo
  - an allowlist on the server
  - out-of-band verification
  - a `/.well-known/mcp-webhook-receiver.json` document published by the receiver
- **Expiry:** subscriptions expire at `refreshBefore`, which may be null for no expiry. The client re-subscribes before then with the same key: principal, callback URL, name and arguments.
  - A server may extend a subscription beyond the requested `ttlMs` up to its own minimum.
  - Re-subscribing with the same key is an update, not a duplicate.
- **Control messages:** the server can also POST `gap` and `terminated` bodies. These carry their own `webhook-id` and no `eventId`.
- **Delivery guarantees:** events can arrive out of order or more than once. The server assigns `eventId`, often reusing the upstream system's id, and ids are not unique across servers.
- **Security:** event payloads are untrusted data, like tool results, and receiving an event grants no authority to act.

Sources:

- The MCP Triggers & Events working group ([charter](https://modelcontextprotocol.io/community/working-groups/triggers-events)) was chartered 2026-03-24 and is led by Clare Liguori (AWS) and Peter Alexander (Anthropic).
  - Its draft is `docs/design-sketch-proposal.md` in [`modelcontextprotocol/experimental-ext-triggers-events`](https://github.com/modelcontextprotocol/experimental-ext-triggers-events).
  - Pin it at commit [`28ec35e`](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/28ec35e905daa241f019981e2836b4a02f1c0368/docs/design-sketch-proposal.md). The file last changed 2026-09-04 and was merged 2026-09-08.
  - It is not an accepted SEP.
- OpenAI ships a subset in ChatGPT ([docs](https://developers.openai.com/plugins/build/mcp-events)): top-level `capabilities.events`, protocol `2026-07-28` via `server/discover`, webhook delivery only, no poll or stream, no `gap` or `terminated`, a 256 KiB body limit, and no retries on `410` or `413`.

## Product decisions (settled 2026-09-30)

1. **Full spec.** Support poll, webhook and push. Hosted push stays deferred until its infrastructure questions are answered, and the support matrix says so.
2. **A dedicated public webhook-receiving service, separate from the tunnel.** `tunnel-edge` exposes local MCP servers. Events need a public mailbox that accepts deliveries even when no MCPJam client is open.
3. **Agent reaction is in scope.** It behaves like ChatGPT, gets its own sidebar tab, and works across Playground, Evals, Swarms and User Testing.
4. **The hosted plane is horizontally scaled.** No design may assume a webhook reaches the replica holding the viewer's connection.
5. **Mock ChatGPT as closely as possible, honestly.** Keep three kinds of fact separate:
   - what OpenAI documents
   - what we observed ourselves, with dates
   - MCPJam's own policy

   Where ChatGPT's internals can't be observed (retention, prompting), MCPJam states its own policy and labels it as ours.

## What existed before this work

**Nothing implemented events.** There was no `events/*` method, `whsec_` handling, Standard Webhooks signing or inbound webhook receiver in `sdk/`, `mcpjam-inspector/`, `cli/` or `mcpjam-backend`.

What mattered from the investigation and the audit:

- **The official client drops the capability.** `@modelcontextprotocol/client` 2.0.0 parses server capabilities with plain zod objects, which silently remove unknown keys.
  - `getServerCapabilities()`, `getDiscoverResult()` and `getInitializationInfo()` never show a top-level `events`. Confirmed on the legacy path in a live run, and by reading `ServerCapabilities2026Schema`.
  - The server does send it: a raw capture of `server/discover` returned `capabilities.events: {}`.
  - Capturing the raw handshake is therefore justified.
- **Custom methods work through the official client.**
  - Requests use `requestWithSchema` with a loose result schema, then zod checks (`sdk/src/mcp-client-manager/skills-ext.ts`, `tasks-ext.ts`).
  - `events/*` is on neither protocol version's method list, so no per-version override is needed.
  - Extension notifications need the three-argument handler form. `official-sdk-client-adapter.ts` sent only `EXTENSION_NOTIFICATION_METHODS`, then just `notifications/tasks`, through it.
- **Custom methods also work on the server side.** A proof-of-concept events server (official `@modelcontextprotocol/server` 2.0.0, three-argument `setRequestHandler`) passed an end-to-end webhook test on `2026-07-28`. That test used plain-http localhost, so the fixture had to move to HTTPS.
- **The RPC logger captured whole messages.** `wrapTransportForLogging` in `transport-utils.ts` passed every outgoing message to the logger unredacted. From there it reached the wire-log bus, replay buffers, hosted RPC logs, exports and CLI output. `events/subscribe` would have leaked `params.delivery.secret` through this path.
- **Push is awkward on the official client.**
  - `Client.listen` is hard-coded to `subscriptions/listen`.
  - A generic long request always has a timer: 60 seconds by default, at most about 24.9 days, and only progress notifications reset it.
  - The installed transport supports `onRequestStreamEnd`, but `requestWithSchema` doesn't forward it.
  - Non-progress notifications go to one global handler per method, and `SubscriptionCoordinator` installs its handlers directly, replacing others.
- **Polling is reusable in part.** `task-lifecycle.ts` has usable pure interval, backoff and `Retry-After` logic. Its task-terminal state model doesn't fit.
- **Hosted mode holds nothing.** Every hosted operation runs through `withEphemeralConnection` (`server/routes/web/auth.ts`). `server/routes/web/tasks.ts` documents that notification endpoints are absent for this reason.
- **The durable agent runner is not an MCP event executor.**
  - `server/routes/internal/agent-turns.ts` dispatches to `/api/v1/projects/:id/agent`.
  - That route runs `runUnifiedAssistantTurn` with curated platform operations as tools, not the trigger's environment and servers.
  - Its lease and checkpoint machinery is reusable. Its tool catalog, approvals, model and billing are not.
- **Backend job deduplication** (`backend:convex/agentTurnState.ts`) is keyed by user and request key, and rejects a repeated key with changed input. It won't add source or trigger namespacing on its own.
- **The tunnel can't receive webhooks as-is.** `tunnel-edge` only lets `/api/mcp/adapter-http/{serverId}` through, with a `?k=` secret. `TunnelScope` is `"adapter-http" | "harness-web"`.
- **Infrastructure.**
  - Neither repo uses Redis.
  - MCPJam already deploys Cloudflare Workers with Durable Objects on `mcpjam.com` subdomains, for example `mcpjam-multiaccount` with its `LabState` object.
  - Third-party webhooks today (GitHub checks) land in Convex.
- **Close precedents to copy.**
  - `SubscriptionCoordinator` and its SSE bridge, plus `docs/subscriptions-listen-design-notes.md`.
  - The wire-log bus and `traffic-log-store.ts`.
  - `client/src/lib/tool-form.ts` for building forms from a schema.
  - Host presets (`sdk/src/host-config/templates/seed-host-template.ts`).
  - The lease and checkpoint machinery of agent-turn jobs.
  - `runUnifiedAssistantTurn`, which Playground, evals, swarms and user testing all use.

## Architecture

```text
MCP wire adapters (webhook / poll / push / simulate)
                  │
                  ▼
shared event coordinator  +  canonical subscription registry (Convex)
                  │
                  ▼
event inbox (Worker + Durable Object): journal + dedupe + pending dispatch
           │                                  │
           ▼                                  ▼
viewer feed + checkpoint          idempotent job enqueue (Convex, one job per matching trigger)
                                              │
                                              ▼
                              event-job executor ──▶ shared turn engine (runUnifiedAssistantTurn)
```

Who owns what:

| Component | Owns |
|---|---|
| Wire package (`@mcpjam/sdk`) | Schemas, capability capture, profile rules, Standard Webhooks primitives, redaction helper |
| Event coordinator | Lifecycle transitions for every mode: subscribe, refresh, poll, stream, unsubscribe, gap, terminate. Runs in the inspector, with a local adapter and a hosted adapter. |
| Subscription registry | Identity, account binding, desired and observed state, generation, leases |
| Event inbox | Receiver slots and secrets, accepted deliveries, deduplication, pending dispatch, viewer checkpoints, read authorization, retention |
| Event-job executor | Resolving environment and account, the tool catalog, host profile, permissions, budgets, conversation order, recovery from failed tool calls |

UI, CLI, evals and swarms adapt these components. None of them runs its own event loop.

**Only MCPJam talks to MCP servers.** Subscribe, refresh, unsubscribe, poll and stream need the user's server credentials and stay in the inspector. The inbox never holds MCP credentials.

## Core contracts

Summarised here; the settled, code-level versions (field names, digests, route shapes) are in [`mcp-events-contracts.md`](./mcp-events-contracts.md).

- **C1. Profiles.** `draft@28ec35e` (the pinned draft) and `chatgpt@<date>` (OpenAI's documented behaviour plus dated observations). Development overrides such as the plain-http fixture mode are always labelled and never count as a conformance pass. Conformance results, host emulation and UI labels all name their profile. Error-code meanings (`-32011`…`-32015`) are pinned to the events profile and method.
- **C2. Identity.** Tenant, connection binding, logical subscription id, receiver slot id, server subscription id (observed, reconciled, never trusted to route before reconciliation), delivery key `hash(tenant, binding, logical subscription, eventId)` and run key `hash(tenant, binding, logical subscription, trigger, eventId)`. Identities are not credentials. Simulation and replay get their own run-key namespace. Each run freezes its inputs when first scheduled.
- **C3. Registration and rotation.** Each webhook subscription gets its own callback URL `https://hooks.mcpjam.com/i/{inboxId}/s/{slotId}`; the path identifies the secret before the server's id exists. States: allocate (pending) → subscribe (a correctly signed challenge is accepted against the pending slot) → reconcile (active). Events before the subscribe response are accepted if signed; a lost response is retried with the same key; a conflicting id is recorded, never merged; abandoned pending slots expire; unsigned traffic never creates or changes a binding. Rotation registers the new secret first, refreshes, accepts both secrets for a bounded overlap, and reconciles an unknown-outcome refresh before retiring the old one. **For the working group:** the draft says receivers pick the secret by `X-MCP-Subscription-Id`, which can't work for the first challenge.
- **C4. Subscription registry and keeper fencing.** One Convex row per logical subscription with a generation and a lease; keeper writes are compare-and-set; unsubscribe writes a tombstone first; a late refresh is handled by unsubscribing again; lost authorization pauses until reauthorization; local-server subscriptions are refreshed by the local app only.
- **C5. Delivery journal and dispatch.** Dedupe record + journal entry (monotonic sequence) + pending dispatch commit atomically before `2xx`. Upstream cursor, inbox sequence and consumer checkpoints are distinct; viewers never consume runner work. Dispatch retries on a Durable Object alarm into an idempotent enqueue. Poll goes through the same append boundary. Capacity is bounded with backpressure and explicit inbox gaps. No Convex row per raw delivery.
- **C6. Job scheduling and the event-job executor.** At-least-once ingestion plus idempotent job scheduling; a new executor on the agent-turn lease machinery that runs the trigger environment's tools with source type `"event"`; event turns and chat messages are serialized; unknown tool outcomes are parked; budgets are reserved before execution; approvals come from saved policy.
- **C7. Authorization.** Checks at registering a receiver, issuing a viewer token, refreshing, dispatching a run, and executing tools. Short-lived, revocable viewer tokens; an unguessable URL is not authorization.
- **C8. Secrets and redaction.** Redact at the capture boundary before any logger sees a frame; the real request stays unchanged; bounded rejection metadata; a maintained Standard Webhooks implementation or independent vectors.
- **C9. Event coordinator.** Transport-independent core with ports; one internal envelope; the draft's cursor, batch, `hasMore`, `nextPollMs`, `maxAgeMs`, gap, null `refreshBefore` and failure rules; descriptor caching; shared pure backoff.
- **C10. Capability capture.** Raw handshake capture of top-level `capabilities.events`, reset on reconnect, account change and protocol switch; no invented `extensions[...]` id.

## Support matrix (target)

| Mode | Local app | Hosted | CLI | Unattended triggers |
|---|---|---|---|---|
| Webhook | Yes, through the inbox (plain-http localhost only as a labelled non-conformant fixture) | Yes | Yes | Yes, if the server is reachable from the hosted runner |
| Poll | Yes | Yes (keeper) | Yes | Yes, if the server is reachable from the hosted runner |
| Push | Yes (phase 6) | **Deferred**: same infrastructure questions as the hosted `subscriptions/listen` route | Yes (local) | No |

Servers that run on the user's machine only work while the local app runs, for refresh, polling and tool execution.

## Phases

### Phase 0: ChatGPT observation (small; parallel with phase 1)

Goal: a dated `chatgpt@<date>` profile that separates documented from observed behaviour.

- **From the docs now:** top-level `capabilities.events`, `2026-07-28`, webhook only, no poll or stream, no `gap` or `terminated`, the 256 KiB limit, and no retries on 410 or 413.
- **Observe** with an instrumented public HTTPS events server, with the recorder redacting secrets: capability placement, `events/list` and `events/subscribe` parameters (`ttlMs`, secret length, cursor, callback URL shape), refresh cadence against the `refreshBefore` we grant, unsubscribe on chat/automation end, its answer to our challenge, its responses to deliveries we control (valid, bad signature, stale timestamp, duplicate id, oversize body), and how events look in the ChatGPT UI.
- **Not observable, so MCPJam policy instead:** ChatGPT's retention, its internal prompting, and its retry and suspension internals.

Exit gate: every field in the ChatGPT profile is tagged documented, observed (dated) or MCPJam policy.

### Phase 1: contracts, wire package and coordinator core (medium–large)

Wire package, redaction and capture, Standard Webhooks primitives, coordinator core with a fake-clock lifecycle suite run against every adapter, an HTTPS test server with switchable faults, and a push spike.

Exit gate: the lifecycle suite passes; a sentinel secret never appears in the RPC log, buffers, exports or CLI output across subscribe, refresh and failed requests while the server receives the exact secret and raw-body signature tests pass; the push spike handles two concurrent streams, heartbeat-only periods, the server closing the stream without a result, and cancelling one stream without closing the connection.

### Phase 2: first vertical slice, webhook to agent run (large)

Event inbox (Worker + Durable Object), registry and keeper, idempotent enqueue and the event-job executor, a minimal debugging view.

Exit gate: the audit's gates for findings 1–6 (journal crashes, identity collisions, registration races, fencing, redaction end to end, execution recovery and budgets).

### Phase 3: poll through the same ingestion path, plus conformance (medium)

Exit gate: the phase 2 gates pass again with poll delivery, and conformance passes allowed alternatives while telling MUST apart from SHOULD.

### Phase 4: surfaces (large)

Events tab (Inspect), Triggers tab (Explore), Playground event runs, tracing `webhook` rows, local and hosted adapters, and `mcpjam events list|subscribe|unsubscribe|poll|watch`.

Exit gate: the local and hosted adapters pass the same lifecycle suite, and a user can go from subscribe to trigger to run in both.

### Phase 5: Evals, Swarms and User Testing (large; each needs a design pass with its owner)

Environments carry triggers; evals get an "event" step (canned against the versioned `payloadSchema` in the simulation namespace, or live through a tool with an inbox wait); swarms and user testing get an "event" stage.

Exit gate: one eval suite and one swarm run exercise events end to end on the executor from phase 2.

### Phase 6: push (medium locally; hosted deferred)

Exit gate: local push against the fixture, including reconnecting with the cursor, runs through the same journal and executor.

## Conformance

Results report the profile, each check's strength (MUST fails, SHOULD warns) and the protocol pin. Receiver consent accepts any of the four methods; a lifetime extended up to a server minimum is allowed; a second unsubscribe may answer `NotFound`; `webhook-id` equals `eventId` for events only; body size is a draft SHOULD and a ChatGPT limit; heartbeats are a MUST and the 30-second cadence a SHOULD; rejecting private callbacks is a SHOULD with explicitly configured destinations allowed; non-HTTPS callbacks break the TLS MUST and the plain-http fixture mode never counts as a pass. A separate ChatGPT readiness check runs the `chatgpt@<date>` profile.

## Rules that apply throughout

- **Labelling:** mark events "Draft" in the UI instead of hiding them behind a flag, and name the profile.
- **Advertising:** MCPJam's client declares nothing for events unless the ChatGPT profile shows ChatGPT does.
- **Event data is untrusted:** show it as data, never pass it to the model as instructions. Secrets are redacted at capture (C8).
- **Shared files:** `MCPClientManager.ts`, `official-sdk-client-adapter.ts`, `managed-mcp-client.ts`, `transport-utils.ts` and `assistant-turn.ts` should have one owner at a time.
- **Unchecked literal lists:** grep for every list of source types, log kinds and surface ids when adding `"event"`, `"webhook"`, `"events"` and `"triggers"`.

## Risks

- **Spec churn.** The extension is a draft, and the profile pin contains the damage.
- **Unattended spend and writes.** Runs cost money and can change data with nobody watching. Budgets are reserved up front (C6), and unknown writes are parked, never repeated.
- **Abuse.** The inbox is a public endpoint, so it needs rate limits, bounded rejection logging and revocable slots.
- **Local servers.** They can't be refreshed or run tools while the app is closed, and the support matrix states this.

## Open questions

1. What retention and capacity numbers should MCPJam's policy use (UI history, pending-work lifetime, deduplication window, unread cap)? *Proposed defaults are implemented and labelled as policy: 7 days / 5,000 entries of UI history, 72 h pending work, 7-day dedupe, 1,000 undispatched entries per inbox.*
2. Who pays for unattended trigger runs, and what are the default rate limit and spending cap? *Implemented defaults, to be confirmed: the trigger owner's organization pays through the existing `/stream` spend checks; 30 runs/hour and $2/day per trigger.*
3. Where will the draft place the capability if it moves under `extensions`, and how should the first-challenge secret selection be fixed? Raise both with the working group.

## Implementation status

As of 2026-09-30. This spans two PRs: MCPJam/inspector (SDK, CLI, inspector server and client, docs) and MCPJam/mcpjam-backend (`events-inbox/` Worker + Durable Object, Convex registry and jobs).

| Phase | Status | Evidence |
|---|---|---|
| 0 ChatGPT observation | Tooling built; live observation **not yet run** | `CHATGPT_PROFILE` tags every field documented, observed (dated), policy or `unobserved`. `sdk/scripts/chatgpt-events-probe.ts` is the instrumented server and `summarizeProbeObservations` turns its log into dated facts. Running it needs a public HTTPS deployment connected to a ChatGPT plugin, which is outside the repo. |
| 1 Contracts, wire, coordinator | Done | [`mcp-events-contracts.md`](./mcp-events-contracts.md). Tests: `sdk/tests/events-lifecycle.test.ts` (the lifecycle suite, also run against the hosted inbox client in the inspector server); `events-wire.integration.test.ts` (raw capability capture on both eras, and the sentinel secret absent from every captured frame across subscribe, refresh and a failed request whose error quotes it, while the server receives it exactly); Standard Webhooks tests against the published vector and an independent HMAC; push gates in `events-push.integration.test.ts` (two streams, heartbeat-only, dropped stream, cancelling one stream, rollover). |
| 2 Webhook → agent vertical slice | Built; gates covered by unit/integration tests, not yet run on deployed infrastructure | Inbox: 61 tests (journal atomicity under an injected write failure, dispatch retry, lost response and expiry, the C3 table, rotation, backpressure, feed gaps). Convex: registry CAS and lease fencing, tombstones and late-delivery re-unsubscribe, idempotent enqueue, run keys, frozen inputs, FIFO, budgets, tool-journal parking, authorization loss, plus an inbox→Convex contract test. Inspector: keeper against the real fixture, executor against the fixture's tool with a scripted model (replay, park-on-unknown, spend refusal, prompt containment, transcript ordering). |
| 3 Poll + conformance | Done | Poll goes through the same inbox append before the cursor advances (lifecycle suite, keeper tests). `runEventsConformance` covers MUST/SHOULD by profile, with allowed alternatives passing (`events-conformance.integration.test.ts`). |
| 4 Surfaces | Done | Events tab (Inspect), Triggers tab (Explore), Tracing `webhook` rows, the Playground event card, local `/api/mcp/events/*` and hosted `/api/web/events/*` routes, and `mcpjam events list|poll|watch|subscribe|unsubscribe|conformance`. |
| 5 Evals, Swarms, User Testing | Partial: needs owner design passes | Code-first `runEventStep` and the shared event-turn prompt are built; triggers attach to environments. Suite-file `event` steps and the swarm stage are proposed in [`mcp-events-phase5-design.md`](./mcp-events-phase5-design.md). |
| 6 Push | Local done; hosted deferred | `EventsPushRuntime` is wired into the local runtime and the CLI. Hosted push stays deferred, as the support matrix says. |

**Before first deploy:**
- Set the Worker secrets and confirm `INSPECTOR_INTERNAL_ORIGIN` (see `events-inbox/README.md`).
- Set the inspector env: `EVENTS_INBOX_ADMIN_TOKEN`, `EVENTS_INBOX_DISPATCH_TOKEN`, `EVENTS_INBOX_VIEWER_KEY`, `EVENTS_KEEPER_ENABLED=1`, `EVENTS_EXECUTOR_ENABLED=1`.
- Confirm the policy numbers in open questions 1 and 2.
- Raise the [working-group notes](./mcp-events-working-group-notes.md) upstream.
