# MCP Tasks full-support implementation plan

Status: implementation-ready source of truth

Owners: MCPJam SDK, Inspector, hosted backend, public API, and CLI

Protocol baseline: MCP `2025-11-25` legacy Tasks plus the official
`io.modelcontextprotocol/tasks` extension for `2026-07-28`

This plan supersedes these three drafts. Do not implement them independently:

- `/Users/marcelojimenezrocabado/.claude/plans/hosted-tasks-convex-registry.md`
- `/Users/marcelojimenezrocabado/.claude/plans/hostconfig-tasks-capability.md`
- `/Users/marcelojimenezrocabado/.claude/plans/api-v1-tasks-contract.md`

The drafts contain useful product work, but completing only those drafts would
not produce full Tasks support. Protocol validation, notification delivery,
poll scheduling, durable input-request deduplication, authorization-context
isolation, and several public-contract details must land first or alongside
them.

## 1. Normative baseline

Use these as the implementation sources of truth:

- Official extension listing:
  <https://modelcontextprotocol.io/extensions/overview>
- SEP-2663, Final, extension identifier `io.modelcontextprotocol/tasks`:
  <https://github.com/modelcontextprotocol/ext-tasks/blob/main/seps/2663-tasks-extension.md>
- Extension specification and schema pinned to
  `modelcontextprotocol/ext-tasks@2c1425d9a288b9b1f489430fe1e00bb392b47e48`:
  `specification/draft/tasks.md`, `schema/draft/schema.ts`, and
  `schema/draft/schema.json`
- Legacy compatibility specification:
  <https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks>

The extension is official and SEP-2663 is Final (`seps/2663-tasks-extension.md:3`,
Status: Final). Remove language that calls SEP-2663 a draft or makes acceptance
of the SEP a release condition. Its repository paths still contain `draft`;
pinning the exact commit prevents that path name from becoming an ambiguous
compatibility claim.

One caveat when citing sources: the ext-tasks `README.md:1` still titles the
repository "MCP Tasks Extension (Experimental)" and `README.md:4` still says it
is "**not** an official extension." That README is stale and is contradicted by
both the official extension listing on modelcontextprotocol.io — which lists MCP
Tasks under "Official Extension Repositories", while experimental extensions use
an `experimental-ext-` repository prefix that ext-tasks does not carry — and by
the SEP body itself (`seps/2663-tasks-extension.md:16`), which describes moving
tasks to "an official extension." Cite the site and the SEP, never the README.

Keep the two wires strictly separated:

| Negotiated protocol                   | Valid Tasks wire           |
| ------------------------------------- | -------------------------- |
| Before `2025-11-25`                   | none                       |
| `2025-11-25`                          | legacy core primitive only |
| `2026-07-28` and later known versions | official extension only    |
| Missing or unknown version            | none; fail closed          |

Continue vendoring the extension types while no supported package is
published. Add a CI drift job that diffs the vendored types, runtime schemas,
and conformance fixtures against the pinned commit. Moving to a published
package is a separate, test-preserving change.

## 2. Definition of full support

MCPJam can call Tasks fully implemented only when all of the following are
true:

1. The SDK selects exactly one wire from the negotiated protocol and server
   capability and never mixes legacy and extension fields or methods.
2. Extension eligibility is declared in the per-request client capabilities
   only for a request whose host surface is ready to receive either a normal
   result or `CreateTaskResult`.
3. Every extension response is runtime-validated as the correct
   status-discriminated shape before it reaches a route or UI.
4. Task handles survive reloads and reconnects, and an authenticated hosted
   user can resume only tasks created under the same user and authorization
   context.
5. Polling honors each task's dynamic `pollIntervalMs`; optional task
   notifications reduce polling but are never required for correctness.
6. `input_required` supports the same elicitation, roots, and sampling trust
   and fulfillment rules as the corresponding standalone requests. Requests
   are durably deduplicated by task and input key.
7. Local Tools, hosted Tools, chat/playground, agent execution, public API,
   and CLI have an explicit, tested Tasks behavior. Replay-only surfaces never
   create new work.
8. Public contracts are wire-neutral where possible, preserve the wire in the
   task handle, rate-limit polling, and expose stable task-specific errors.
9. The conformance suite proves the protocol MUSTs below against independent
   legacy and extension fixtures.
10. Disabling Tasks removes the per-request declaration and returns every
    affected surface to its pre-Tasks behavior.

Optional `notifications/tasks` support is required on persistent local/live
connections for feature completeness. Hosted reconnect-per-operation paths may
use polling because the extension makes notifications optional, but must not
claim that a notification stream exists.

## 3. Non-negotiable extension invariants

Implement and test these at the SDK boundary, not separately in each route:

- The server extension capability value must be a non-array object. A missing,
  `null`, boolean, string, or array value is not a declaration. The pinned
  conformance check reports non-empty settings because the pinned extension
  defines `{}`, while runtime detection may retain unknown object keys for
  forward compatibility.
- `tools/call` may return either a normal `CallToolResult` or a flat
  `CreateTaskResult` with `resultType: "task"`.
- A server must not return `CreateTaskResult` for a request that did not carry
  the extension declaration. If Tasks are mandatory for the operation, the
  expected error is `-32003`.
- `tasks/get`, `tasks/update`, `tasks/cancel`, and a task-filtered
  `subscriptions/listen` request carry the extension declaration on that
  request. A non-declaring client must receive `-32003`.
- Streamable HTTP calls to `tasks/get`, `tasks/update`, and `tasks/cancel`
  carry `Mcp-Name: <taskId>` and the correct `Mcp-Method`.
- `CreateTaskResult` is not returned before the handle is durably readable from
  a fresh `tasks/get` connection.
- `tasks/get` returns a discriminated state. Prose requires `resultType:
  "complete"` on the result (`tasks.md:338`), but the pinned JSON Schema never
  defines the field — `resultType` appears nowhere in `schema/draft/schema.json`
  — and each `DetailedTask` variant sets `additionalProperties: false`
  (`schema.json:329`, `:385`, `:435`, `:485`, `:527`), so a validator generated
  faithfully from the schema would reject the very key the prose mandates. Prose
  and schema contradict each other. Accept the response with or without
  `resultType`; discriminate on `status`:

  | Status           | Required payload           |
  | ---------------- | -------------------------- |
  | `working`        | no status-specific payload |
  | `input_required` | `inputRequests`            |
  | `completed`      | `result`                   |
  | `failed`         | JSON-RPC `error`           |
  | `cancelled`      | no status-specific payload |

- A tool result with `isError: true` is still a `completed` task. Only an
  underlying JSON-RPC error produces `failed`.
- `tasks/update` and `tasks/cancel` return an empty acknowledgement. Prose
  requires `resultType: "complete"` on both (`tasks.md:381`, `tasks.md:410`),
  and the same prose/schema conflict applies, so accept the acknowledgement
  either way. They do not return task state. Update callers
  continue observing the task; cancellation callers may stop immediately or
  explicitly refresh, but never infer `cancelled` from the acknowledgement.
- Unknown or expired task IDs return `-32602` for `tasks/get` and should do so
  for update/cancel. The requirement levels differ and the difference is
  load-bearing: `MUST` for `tasks/get`, `SHOULD` for `tasks/update` and
  `tasks/cancel` (`tasks.md:793-795`). MCPJam maps this independently from a
  missing project or server.
- `ttlMs` is required and may be `null`; both `ttlMs` and `pollIntervalMs` may
  change during the task lifetime (`tasks.md:340`, `tasks.md:308`).
- There is no extension `tasks/list`, `tasks/result`, task request parameter,
  or server-provided `model-immediate-response`.
- `notifications/tasks`, when used, arrive through `subscriptions/listen`,
  include a full `DetailedTask`, and are validated identically to
  `tasks/get`.

## 4. Workstream A — protocol boundary and conformance corrections

**Status: MERGED** — PR [#3511](https://github.com/MCPJam/inspector/pull/3511),
2026-07-28. A0–A4 landed together, so the blocking gate on downstream
workstreams is lifted and Workstream B may start. Two review findings landed
as a follow-up PR rather than in #3511 — see A2 below; neither re-blocks
downstream work. The subsections are kept as the record of what was decided
and why, with what actually shipped noted per item.

This was the blocking first PR. Product expansion must not ship before it.

### A0. Unblock the extension methods on the 2026-07-28 wire era

This is the true first item, ahead of validation. With
`@modelcontextprotocol/client@2.0.0-beta.4`, the extension methods cannot reach
a conforming server at all on a `2026-07-28` connection. No amount of schema
correctness matters until this is resolved.

What the client does:

- `isSpecRequestMethod(method)` returns true if **either** era registry defines
  the method — it is a union across `ALL_CODECS = [rev2025Codec, rev2026Codec]`.
- `tasks/get`, `tasks/result`, `tasks/list`, and `tasks/cancel` are defined in
  the `rev2025-11-25` registry **only**. The `rev2026-07-28` registry defines no
  tasks methods at all. `tasks/update` is in neither registry.
- `_assertOutboundRequestInEra(codec, method)` throws
  `SdkErrorCode.MethodNotSupportedByProtocolVersion`
  (`METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION`) when a method is spec-known but
  absent from the resolved era's codec. It throws locally, before anything
  reaches the transport.
- The assertion runs on **both** `request()` and `requestWithSchema()`. Passing
  an explicit result schema is not an escape hatch; the client's own comment
  says "an explicit schema never smuggles a deleted method onto the wire."

Net effect: a `tasks/get` on a `2026-07-28` connection is rejected client-side
as a deleted 2025-era method, even though on that connection it is an
**extension** method that the era registry has no opinion about.

Root cause: the extension reuses method names that the 2025 core owned, and the
era gate is a **v2-only** construct. ext-tasks itself devDepends on
`@modelcontextprotocol/sdk ^1.29.0` (ext-tasks `package.json:18`), a v1 SDK with
no era gate, so this interaction was never exercised upstream.

This is deliberate upstream behavior, not an oversight: the `SdkErrorCode`
documentation for `MethodNotSupportedByProtocolVersion` names `tasks/get`
toward a `2026-07-28` peer as its canonical example. Verified unchanged in
`2.0.0-beta.5` — the registries and the assertion are byte-identical.

Resolution taken:

- Route `tasks/get`, `tasks/update`, and `tasks/cancel` through
  `requestWithSchema` with a loose result schema, so result decoding does not
  depend on an era registry entry that does not exist.
- Add a narrowly scoped, per-instance override of the era assertion that
  returns early **only** for those three method names and **only** on the
  `2026-07-28` era. Every other method keeps the stock gate.
- Fail loud if the seam disappears on a client bump: the override must assert
  that the method it patches still exists, rather than silently becoming a
  no-op.

Two things to state plainly:

- Every merged extension test before this used mocked or seeded client
  managers, which never execute the era gate. That is why CI was green while no
  extension call could reach a real `2026-07-28` server.
- The exit condition for the override is an **upstream** change — either the
  era registries gaining extension-awareness or the gate exempting
  extension-owned methods. Until then the override stays, and the drift check
  in §1 must cover it.

### A1. Make runtime schemas status-discriminated

Update:

- `sdk/src/mcp-client-manager/tasks-ext-types.ts`
- `sdk/src/mcp-client-manager/tasks-ext-schemas.ts`
- `sdk/src/mcp-client-manager/tasks-ext-guards.ts`
- `sdk/src/mcp-client-manager/tasks-ext.ts`
- `sdk/src/mcp-client-manager/tasks-dispatch.ts`

Required changes:

- Replace the optional-field `DetailedTaskExt` interface with a union of
  working, input-required, completed, failed, and cancelled task types.
- Accept get/update/cancel responses **with or without** `resultType:
  "complete"`. Do not require it. The prose mandates it (`tasks.md:338`,
  `:381`, `:410`) but `resultType` is defined nowhere in
  `schema/draft/schema.json`, and every `DetailedTask` variant is
  `additionalProperties: false` (`schema.json:329`, `:385`, `:435`, `:485`,
  `:527`) — a strict validator built from the schema would actively reject the
  key. Record this prose/schema conflict in a code comment and in the
  conformance notes so the next reader does not "fix" it back to a hard
  requirement. Keep `resultType: "task"` on `CreateTaskResult` required: that
  one is a genuine MUST (`tasks.md:102`) and it is the discriminator the whole
  task-detection path keys on.
- Validate timestamps as plain strings. `createdAt` and `lastUpdatedAt` are
  `"type": "string"` with no `format: "date-time"` and no pattern anywhere in
  `schema.json`; "ISO 8601" appears only in a JSDoc comment
  (`schema.ts:69`, `:74`). Do not reject a non-ISO-8601 timestamp.
- Validate `ttlMs` and `pollIntervalMs` as numbers, not as non-negative safe
  integers. The schema is plain `"number"` (`ttlMs` is `number | null`);
  "integer milliseconds" is doc-comment prose with no RFC 2119 keyword
  (`schema.ts:79`, `:87`). Both values **MAY** change over a task's lifetime
  (`tasks.md:340` for `ttlMs`, `tasks.md:308` for `pollIntervalMs`), so a
  changed — including a shrinking — value is normal and must never be surfaced
  as an anomaly, a validation failure, or a debugger warning.
- Preserve unknown fields for debugger display after the required shape passes.
- Validate `inputRequests` against the MRTR request union, including safe
  handling of hostile object keys.
- Validate empty acknowledgements instead of returning arbitrary raw objects.
- Require an object value for the advertised extension capability.
- Retain the wire value as part of every internal task handle.

Do not turn validation failures into generic “unsupported” responses. Raise a
typed invalid-server-response error carrying the method, wire, and safe
violation summary.

### A2. Correct the conformance verdicts

Update `sdk/src/tasks-conformance/runner.ts` so the extension test for
undeclared capability covers all required operations:

- undeclared eligible `tools/call` must not produce a task;
- undeclared `tasks/get`, `tasks/update`, and `tasks/cancel` must receive
  `-32003`;
- undeclared task-filtered `subscriptions/listen` must receive `-32003`.

The current interpretation that a bare `tasks/get` may succeed is incorrect
for the pinned extension and must be removed from code, docs, and fixtures.

Implemented in PR #3511, plus two corrections found in review that the
original item did not anticipate:

- **A skipped check can no longer produce a green.** The suite returns
  `outcome: "passed" | "failed" | "incomplete"`, and `passed` is true only when
  every *selected* check produced a verdict. Every skip carries a `skipReason`:
  `"not-applicable"` (cannot apply to this server — extension-only checks on a
  legacy connection, `Mcp-Name` over stdio, any task check when the wire is
  `none`) never holds a run back; `"could-not-run"` (applies but was never
  exercised) makes the run `incomplete`. Reported as a root `incompleteReason`,
  and per-category `couldNotRun` counts.
  Motivation: against the conformant extension fixture *without* `toolName`,
  the suite returned `passed: true` on 2 of 8 checks with 6 silently skipped.
- **Probe-tool selection fails loud.** Auto-selection reads
  `execution.taskSupport`, which the 2026-07-28 `ToolSchema` strips, so it can
  never work on the extension wire. No `toolName` — or a `toolName` the server
  does not list — is now an `incomplete` run naming the flag, the tool, and the
  tools the server does list. Legacy auto-selection is unchanged.
- **CLI exit codes:** `0` passed, `1` failed, **`3` incomplete** (`2` stays
  reserved for usage errors), plus the reason on stderr.

Fixed in the follow-up PR, not in #3511: the discriminator blind spot. A server that
answers a `tools/call` with a flat task payload carrying **no**
`resultType: "task"` is invisible to every check that reads the *decoded*
result — task detection keys on that discriminator at the transport seam — so
it currently scores green on both `tasks-result-type-discipline` and
`tasks-undeclared-creation-refused`. Closing it means judging the discriminator
on the raw inbound JSON-RPC (the run already captures it) for both checks, with
a failure message that names the consequence: the client cannot discriminate
the response, so the task is never tracked and the work runs to completion
server-side with no handle (`tasks.md:102`).

### A3. Verify headers and connection durability

Add wire-capture assertions for:

- `Mcp-Name` and `Mcp-Method` on all three task methods;
- no task routing headers on legacy calls;
- no loss of unrelated client capabilities when the task declaration is
  merged into per-request `_meta`;
- a returned handle being readable after disconnect/reconnect.

### A4. Acceptance gate

No downstream PR may merge until:

- SDK unit and type tests pass;
- the extension fixture passes the corrected required-capability checks;
- malformed status variants are rejected at the SDK boundary;
- the legacy fixture remains byte-for-byte free of extension fields.

## 5. Workstream B — one lifecycle engine

Create a shared lifecycle engine in the SDK instead of letting the Tasks tab,
chat, API, and CLI each implement polling and state transitions.

Suggested modules:

- `sdk/src/mcp-client-manager/task-lifecycle.ts`
- `sdk/src/mcp-client-manager/task-input-driver.ts`
- extensions to `subscription-coordinator.ts`

The engine owns:

- stable identity `(scope, serverId, wire, taskId)`;
- the latest validated state and dynamic TTL/poll interval;
- per-task `nextPollAt`, exponential error backoff, and `Retry-After`;
- terminal-state handling and typed expiration/not-found handling;
- notification reconciliation;
- durable input-request key state;
- cancellation-requested state;
- callbacks for state, task-created, input-required, and terminal events.

### B1. Poll scheduling

Replace the current shared `Math.min(...)` interval behavior with a per-task
due-time scheduler. No task may be polled faster than its latest advertised
`pollIntervalMs`, including when requests are batched or a user enters a
shorter interval.

This critique is confirmed in code. `mcpjam-inspector/client/src/components/TasksTab.tsx:187`
collapses every active task to a single `Math.min(...)` across their poll
intervals, so the fastest task's floor is applied to all of them. Worse,
`mcpjam-inspector/client/src/components/TasksTab.tsx:258` resolves the interval
as `userOverride ?? serverSuggestedPollInterval ?? userPollInterval` — a `??`
chain, not a `max`, so a user override replaces the server's floor entirely
rather than being clamped by it. Only the hosted path applies any floor at all.

The user setting is a minimum preferred interval, not permission to violate the
server floor:

```text
effective interval = max(
  server pollIntervalMs,
  user minimum,
  retry backoff,
  Retry-After
)
```

Batch only tasks that are due. If a surface cannot schedule individually, the
batch interval is the maximum floor among members, not the minimum.

### B2. Notifications with polling fallback

Extend the modern subscription coordinator with:

- desired and acknowledged `taskIds`;
- a `tasks` notification kind and handler;
- full `DetailedTask` validation;
- per-request task capability injection on `subscriptions/listen`;
- filter-change close/relisten behavior;
- automatic removal of terminal or dismissed task IDs.

On a persistent local/live connection, subscribe when the server and
transport support `subscriptions/listen`. Reconcile notifications into the
same lifecycle engine. If the stream is rejected, closes, or does not
acknowledge a task, resume polling without losing the handle.

Keep the existing legacy `notifications/tasks/status` adapter intact. Legacy
notifications and extension notifications enter the same normalized lifecycle
engine but retain their wire-specific validators.

Hosted reconnect-per-poll remains polling-only until MCPJam has a real
long-lived hosted connection. Do not emulate notifications with registry
status updates.

### B3. Complete `input_required`

Use the extension's complete input request union:

- `elicitation/create`;
- `roots/list`;
- `sampling/createMessage`.

Route each through the same policy, consent, schema validation, and handler as
its standalone counterpart. A task channel is not more trusted than a direct
server-to-client request.

Rules:

- Persist key states by `(scope, serverId, wire, taskId, inputKey)` so reloads
  do not re-prompt for a request already answered.
- Store key state and timestamps, never elicitation content, sampling prompts,
  roots, or responses.
- Support partial `tasks/update` responses.
- Mark a key responded only after the update acknowledgement succeeds.
- Keep unanswered/unsupported keys visible; never mark them handled merely
  because the UI cannot render them.
- Reject a request method the client did not declare with a typed protocol
  error and an actionable UI. Do not hang indefinitely.
- Apply size/count limits to keys, request maps, and response maps before
  rendering or forwarding them.

An execution surface may declare the Tasks extension only when it has a
complete handler path for the standalone capabilities it declares. Add fixture
coverage for all three request methods and for an undeclared method.

### B4. Durable tracker

Upgrade `client/src/lib/task-tracker.ts` through a versioned migration:

- preserve `wire` in identity;
- persist `lastUpdatedAt`, latest `ttlMs`, latest `pollIntervalMs`, and next
  due time;
- persist responded input-key state without payloads;
- enforce per-scope count, age, string-length, and serialized-size limits;
- safely ignore corrupted or future-version records;
- never infer deletion solely from the TTL captured at creation.

The browser tracker remains authoritative for anonymous/local use and is also
the immediate write path for authenticated users. The hosted registry is a
best-effort recovery index, not the only copy.

## 6. Workstream C — host policy and execution surfaces

Keep product policy separate from the wire extension:

```text
hostConfig.mcpProfile.extensions["com.mcpjam/tasks"] = { enabled: boolean }
```

`com.mcpjam/tasks` is MCPJam configuration. It must never be advertised to an
MCP server. The wire declaration is always
`io.modelcontextprotocol/tasks: {}` in the request's client capabilities.

### C1. Tri-state policy

Add `sdk/src/host-config/tasks-policy.ts` with:

- `readTasksPolicy(...) -> unset | on | off | invalid`;
- `setTasksPolicy(..., true | false)`;
- `clearTasksPolicy(...)`;
- `taskModeForSurface(...) -> off | expose | await`.

Semantics:

- unset: preserve today's Tools-tab explicit task controls; all newly enabled
  surfaces remain off;
- on: enable only the surfaces listed as supported below;
- off or invalid: remove task affordances and declarations everywhere;
- invalid: fail closed and show an editor repair warning.

The editor must offer On, Off, and Use default/reset. A binary switch cannot
represent all three valid states. Labels must say “supported interactive
surfaces,” not “all surfaces.”

### C2. Surface matrix

| Surface                               | Unset             | On               | Wire behavior                                         |
| ------------------------------------- | ----------------- | ---------------- | ----------------------------------------------------- |
| Local/hosted Tools                    | explicit controls | expose           | legacy explicit TTL or extension declaration          |
| Local/hosted/BYOK chat and playground | off               | expose           | extension only                                        |
| MCPJam agent                          | off               | expose           | extension only                                        |
| Eval execution                        | off               | await            | extension task is driven to a bounded terminal result |
| Protocol/conformance harness          | explicit test     | explicit test    | test owns exact wire                                  |
| Saved-result replay/pinned replay     | off               | off              | never creates new work                                |
| Public API/CLI                        | explicit request  | explicit request | API opt-in is its policy boundary                     |

For `await` mode, the shared lifecycle engine polls to terminal within the
evaluation timeout and uses configured input handlers. If required human input
cannot be fulfilled, return a deterministic `TASK_INPUT_REQUIRED` outcome
rather than hanging.

### C3. One tool-execution seam

Extend `getToolsForAiSdk`/`convertMCPToolsToVercelTools` with:

- a resolved task mode, not a raw policy boolean;
- `onTaskCreated(event): void | Promise<void>`;
- a shared lifecycle driver for `await` mode.

The task-created event is the single fan-out point for:

1. immediate durable browser tracking;
2. hosted chat stream delivery;
3. best-effort hosted registry recording;
4. analytics/diagnostics.

A registry failure must never convert a successful tool call into a failure.
Tracking and client event delivery are functional paths and must not be hidden
inside an unobserved promise.

For chat/agent `expose` mode, MCPJam may return an MCPJam-authored synthetic
tool result to the model and surface a “View task” affordance. The extension
does not define `model-immediate-response`; do not read or document such a
server field for the extension. A legacy compatibility value may be labeled
explicitly as legacy-server-supplied.

Policy off/unset means no extension declaration. If the server requires Tasks
and returns `-32003`, show an actionable message that names the host setting.

### C4. Hosted mixed-version rollout

Add a hosted client feature/version handshake for the `data-task-created`
stream part. A hosted route may declare Tasks only when the connected client
can persist the event. Keep Tasks disabled for guests during the mixed-bundle
rollout because guests have no registry recovery path.

Tests must prove:

- unknown stream parts still degrade safely;
- old clients are not offered task results;
- chatbox/environment turns use authoritative host policy and cannot enable
  Tasks from request-body tampering;
- direct owner turns cannot override an explicit Off policy;
- each supported route includes or omits the per-request declaration exactly
  as the matrix says.

## 7. Workstream D — secure hosted task registry

The extension removed `tasks/list` because task IDs may be bearer-like handles
and a safe cross-caller listing scope cannot be assumed. The hosted registry
must not recreate a project-wide `tasks/list`.

### D1. Ownership and authorization-context identity

Create rows only for authenticated, non-guest users. Required identity:

```text
(projectId, serverId, ownerUserId, authContextKey, wire, taskId)
```

`authContextKey` is a stable, non-secret fingerprint of the server credential
or account binding used to create the task. Never hash or store a bearer token
directly. Listing, status reporting, and dismissal must resolve the current
user and current authorization context server-side and query the exact
identity prefix.

Assign the key when a credential binding is created. Preserve it across token
refreshes for the same binding, rotate it on explicit reauthorization or
account replacement, and use a documented `public` sentinel for servers with
no authentication. This makes the key reproducible across devices without
coupling registry identity to short-lived access tokens.

Team-wide sharing is out of scope until it has an explicit grant model. A
project member must not discover, poll, mark expired, update, or cancel another
member's task merely because both can access the project.

### D2. Minimal schema

Store only recovery metadata:

```text
projectId
serverId
ownerUserId
authContextKey
wire
taskId
createdAt
updatedAt
lastObservedAt
lastKnownStatus
terminalAt?
```

`lastObservedAt` is the last time a live `tasks/get` under the same
authorization context answered for this handle at all — any status, including a
`-32602`. It is the retention clock's only input for a non-terminal row, and it
is distinct from `updatedAt`, which moves on any row write. `terminalAt` is
stamped when the task reaches a terminal status or is marked expired.

Do not store result/error payloads, `statusMessage`, tool arguments,
`inputRequests`, input responses, sampling content, roots, or model output.
Do not store `toolName` unless a later privacy review gives it a concrete need.

Use:

- an exact identity index including owner and auth context;
- an owner/context list index;
- retention scan indexes on `terminalAt` and on `lastObservedAt`;
- a 200-row cap per owner/server/auth-context and a defensive 2,000-row global
  project cap.

### D3. Internal operations

Implement:

- `upsertHostedTask`: transactional insert-or-update and bounded eviction. Evict
  in this order — expired rows, then terminal rows by oldest `terminalAt`, then
  non-terminal rows by oldest `lastObservedAt`. Do not evict by oldest
  `createdAt`: the oldest row is often the longest-running live task, which is
  the one the registry exists to recover;
- `listHostedTasks`: exact owner/context only;
- `reportHostedTaskStatuses`: patch-only and exact owner/context only;
- `pruneHostedTasks`: bounded, cursor-driven draining until the backlog is
  empty.

Do not prune from `ttlMs` observed only at creation. `ttlMs` is `number | null`
and `null` means unlimited, the value MAY change over the task's lifetime, and
the server — not the client — is the party permitted to discard the task once a
TTL elapses (`tasks.md:136-140`, `tasks.md:340`). An elapsed TTL is therefore a
revalidation hint, never a deletion trigger: it may raise a handle's poll
priority, and nothing more.

Retention runs from the end of a task's life, not from its beginning. There is
no registry maximum age measured from `createdAt`. Concretely:

- the retention clock starts at `terminalAt` — set when a live `tasks/get`
  reports a terminal status (`completed`, `failed`, `cancelled`) or when the
  task is marked expired — and a terminal or expired row is deleted 24 hours
  later;
- a non-terminal row is never deleted for being old. A task may legitimately
  still be `working` or `input_required` after seven days, and dropping its
  handle would destroy exactly the durability the registry exists to provide.

Mark a task expired only after a live `-32602` on `tasks/get` under the same
authorization context. The method pinning is load-bearing and matches §3: only
`tasks/get` carries the `MUST` for `-32602`, while `tasks/update` and
`tasks/cancel` carry a `SHOULD` (`tasks.md:793-795`), so a `-32602` from update
or cancel is a warning that triggers a confirming `tasks/get`, never proof on
its own.

Growth is still bounded, by unobservability rather than by age. `lastObservedAt`
advances whenever a live `tasks/get` answers for the handle, so a genuinely
long-running task that is being polled keeps refreshing it. A non-terminal row
whose `lastObservedAt` is older than seven days is dormant: nobody has been able
to confirm it for a week, which is the signature of a server that vanished, a
revoked credential, or an abandoned handle. The pruner attempts one bounded
revalidation for such a row when a live client context is available, and reaps
it otherwise. An orphaned row therefore ages out on a fixed seven-day bound
after the last contact, while a live, polled task never does. The per-owner and
per-project caps in D2 remain the hard backstop.

MCPJam is deliberately **not** defining a maximum task lifetime here. If it ever
wants one — for storage cost or compliance reasons — that must be written down
as an explicit product decision with its consequence stated plainly: recovery
handles for tasks that are still running are dropped at the cutoff, and those
tasks become invisible and uncancellable from any device that did not create
them. It must not arrive disguised as a retention default.

Validate and cap every identifier and batch. `lastKnownStatus` is an enum plus
MCPJam's local `expired` tombstone. Reporting an unknown identity never
inserts.

### D4. Internal HTTP boundary

The internal routes remain service-token protected, but service-token
possession is not permission to choose an arbitrary browser-supplied owner.
The Inspector must resolve the authenticated owner and authorization context,
and the backend must accept only the verified internal representation.

Use a request-lifetime background primitive such as `waitUntil` for registry
writes, or a short bounded await if the runtime has no safe background work.
Do not rely on a detached `void fetch(...)` after the response ends.

Deploy and probe the backend routes before enabling the Inspector integration.
Routing 404, timeout, or registry outage degrades to the browser tracker and is
observable, never fatal to task creation or polling.

### D5. Integration point

Record task creation at the shared event seam so Tools, chat, agent, eval, and
public API do not drift. Merge registry handles into the hosted task view as a
separate recovery source, deduplicated by full identity, then fetch live state
from the MCP server.

Never write registry rows into another user's browser tracker. A user's local
dismissal is a view preference; global deletion requires a separately
authorized operation.

## 8. Workstream E — public API contract

Ship Tasks as a preview namespace, but make identity and error semantics stable
from day one.

### E1. Stable task handle and envelope

Every follow-up request accepts:

```ts
type PublicTaskHandle = {
  taskId: string;
  wire: "legacy" | "extension";
};
```

Requiring `wire` prevents a stored handle from silently switching behavior
after a server configuration or protocol-version change.

The response is a discriminated union with this base:

```ts
type PublicTaskBase = {
  taskId: string;
  wire: "legacy" | "extension";
  status: "working" | "input_required" | "completed" | "failed" | "cancelled";
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  raw: unknown;
};
```

Status variants require the same `inputRequests`, `result`, or JSON-RPC
`error` fields as the SDK union. `raw` is era-native, preview, size-limited,
and excluded from the additive-only stability promise.

### E2. Endpoints

Add `server/routes/v1/tasks.ts`:

| Route                | Legacy                  | Extension               |
| -------------------- | ----------------------- | ----------------------- |
| `tasks/get`          | yes                     | yes                     |
| `tasks/result`       | yes                     | `422 TASKS_UNSUPPORTED` |
| `tasks/cancel`       | yes                     | yes                     |
| `tasks/update`       | `422 TASKS_UNSUPPORTED` | yes                     |
| `tasks/list`         | yes                     | `422 TASKS_UNSUPPORTED` |
| `tasks/capabilities` | yes                     | yes                     |

Use the shared task-aware execution helper for `tools/call`:

- legacy: explicit mutually exclusive `taskOptions`;
- extension: explicit `allowTaskResult`;
- normal synchronous results retain the existing response shape;
- task creation returns the normalized envelope and full handle;
- authenticated creation emits the shared task-created event;
- guests cannot opt into durable work they cannot poll.

For extension update/cancel, return
`{ wire: "extension", acknowledged: true }`, optionally with a separately
fetched task only when the caller explicitly requests a refresh. Never return
`task: null` as if null were extension state.

### E3. Errors, limits, and rate limiting

Add stable error codes:

- `TASKS_UNSUPPORTED` — 422, never retry;
- `TASK_NOT_FOUND` — 404 for a `-32602` on `tasks/get`, stop polling. A
  `-32602` on `tasks/update` or `tasks/cancel` is only a `SHOULD`
  (`tasks.md:793-795`), so it maps to the operation's own failure and does not
  by itself retire the handle;
- `TASK_INPUT_REQUIRED` — automation cannot fulfill input;
- existing `VALIDATION_ERROR`, `TIMEOUT`, and `RATE_LIMITED`.

Map both `MCPTasksWireError`/Tasks feature errors and unknown-task errors;
do not rely on one guard. Keep `TASK_NOT_FOUND` distinct from a missing project
or server.

Ship per-key and per-user polling limits in the first preview release, with
`Retry-After`. Enforce:

- task ID, cursor, input key, and JSON body size limits;
- maximum input responses per update;
- JSON-object validation that rejects arrays and prototype-pollution keys;
- bounded operation timeouts and connection cleanup.

Mirror the public contract and fixtures byte-for-byte in
`mcpjam-backend/convex/publicApi/contract.ts`, update OpenAPI in the same PR,
and keep drift tests blocking.

## 9. Workstream F — CLI

`cli/src/commands/tasks.ts` already exists for conformance. Extend that module;
do not create a second Tasks command implementation.

Add cloud commands:

- `mcpjam tasks get`
- `mcpjam tasks result`
- `mcpjam tasks cancel`
- `mcpjam tasks update`
- `mcpjam tasks list`
- `mcpjam tasks capabilities`
- `mcpjam tasks watch`

`watch` must:

- require or retain the handle's wire;
- use the lifecycle engine's dynamic interval and `Retry-After`;
- persist/reload the handle when requested;
- render transitions on stderr and the final envelope on stdout;
- terminate predictably for completed, failed, cancelled, timeout,
  not-found, and input-required states;
- never poll faster than the server floor.

Add matching explicit Tasks flags to cloud `tools call` and local-direct
`tools call`, preserving the legacy/extension XOR. Do not expose an extension
`modelImmediateResponse` field.

## 10. Workstream G — fixtures, tests, docs, and observability

### G1. Independent fixtures

Maintain two runnable fixtures:

- exact legacy `2025-11-25`;
- exact extension `2026-07-28` pinned to the ext-tasks commit.

The extension fixture needs configurable cases for:

- normal synchronous response;
- task creation and fresh-connection durability;
- every status variant;
- dynamic TTL and poll interval;
- partial and repeated input requests;
- elicitation, roots, and sampling input;
- update and cancel eventual consistency;
- unknown/expired ID;
- task notification acknowledgement, delivery, and disconnect;
- required-capability errors;
- invalid shapes and hostile input keys;
- `isError: true` completed result versus JSON-RPC failed task.

### G2. Conformance matrix

The conformance suite must prove:

| Area          | Required assertions                                                                          |
| ------------- | -------------------------------------------------------------------------------------------- |
| Dispatch      | version/capability matrix; malformed capability; unknown version fails closed                |
| Declaration   | eligible requests declare once; ineligible requests do not; unrelated capabilities preserved |
| Creation      | `resultType: task`; normal result fallback; durable handle                                   |
| Get           | discriminated payload; `resultType: complete` accepted but not required (§4/A1); dynamic TTL/poll interval accepted in both directions |
| Update        | partial/full responses; empty ack accepted with or without `resultType`; dedupe; eventual re-observation |
| Cancel        | empty ack accepted with or without `resultType`; no inferred state; optional refresh         |
| Errors        | `-32003` undeclared (fail); `-32602` unknown — fail for `tasks/get` (MUST), **warn-only** for `tasks/update`/`tasks/cancel` (SHOULD, `tasks.md:793-795`); typed malformed response |
| Methods       | extension list/result absent; legacy-only fields absent on extension                         |
| HTTP          | `Mcp-Name` and `Mcp-Method` on get/update/cancel                                             |
| Notifications | taskIds filter; capability declaration; ack subset; full detailed task; polling fallback     |
| Security      | owner/auth-context isolation; guest refusal; size limits; no payload persistence             |
| Recovery      | reload, reconnect, cross-device same owner/context, no cross-owner recovery                  |

### G3. Product end-to-end matrix

Run both supported wires, where applicable, through:

- local Tools;
- hosted Tools;
- local chat/playground;
- hosted emulated and BYOK chat/playground;
- MCPJam agent;
- eval `await` mode;
- public API;
- CLI create/watch/update/cancel;
- authenticated registry recovery;
- guest/no-registry behavior.

For every surface, assert both policy-on and policy-off traffic at the raw RPC
layer.

### G4. Documentation

Update:

- SDK Tasks concepts and API reference;
- Inspector Tools, Tasks, chat/playground, agent, host policy, and protocol
  version docs;
- public API preview docs and OpenAPI;
- CLI reference;
- conformance check reference;
- troubleshooting for `-32003`, `-32602`, rate limits, unsupported input, and
  lost authorization context.

Documentation must call the extension official, distinguish it from the
legacy experimental primitive, state the pinned revision, and identify
polling-only hosted paths.

### G5. Operational signals

Emit bounded, payload-free metrics for:

- created tasks by wire and surface;
- schema rejection by method/reason;
- poll frequency, backoff, and rate-limit responses;
- notification subscription/ack/fallback;
- input-required method and outcome;
- unknown/expired tasks;
- registry write/read degradation;
- blocked ownership/auth-context mismatches;
- terminal outcome and time-to-terminal.

Never log task result/error payloads, input payloads/responses, sampling
content, roots, bearer tokens, or raw task IDs. Use a request-scoped hash when
correlation is necessary.

## 11. PR and deployment order

Land in this order:

1. ~~**SDK correctness:** Workstream A — the A0 era-gate unblock first, since
   nothing else in the extension path can be exercised against a real
   `2026-07-28` server until it lands — then the corrected schemas, corrected
   conformance verdicts, and the vendored schema drift check.~~
   **DONE** — PR #3511, merged 2026-07-28. Step 2 is unblocked.
2. **Lifecycle engine:** Workstream B polling, notification integration,
   complete input driver, tracker migration.
3. **Host policy:** tri-state resolver/editor and raw-wire policy tests.
4. **Interactive/automation surfaces:** Tools, chat/playground, agent, eval
   await mode, shared task-created event.
5. **Backend registry:** owner/auth-context schema, internal operations,
   retention, and security tests; deploy and probe.
6. **Inspector registry integration:** shared event sink, recovery merge, and
   degradation behavior.
7. **Public API contract:** routes, limits, rate limiter, OpenAPI, and backend
   contract mirror.
8. **CLI:** extend the existing Tasks module and add lifecycle/watch tests.
9. **Release gate:** full conformance/E2E matrix, docs, metrics, and staged
   rollout.

If a PR needs an SDK bump, publish and consume that SDK before merging routes
that depend on its validation or lifecycle behavior. Deploy backend internal
routes before enabling their Inspector callers.

## 12. Rollout and rollback

Use separate server-controlled gates for:

- extension support on new host surfaces;
- hosted registry reads/writes;
- public API preview;
- automated eval `await` mode.

Roll out in this order:

1. local Tools and corrected conformance;
2. hosted Tools with browser tracking;
3. authenticated chat/playground and agent with client-version handshake;
4. registry recovery;
5. eval await mode;
6. public API and CLI preview;
7. guests only after mixed-client risk is gone and a durable recovery decision
   is documented.

Rollback must not be described as "disable the per-request declaration". The
extension requires the declaration on the lifecycle methods themselves: a
non-declaring client issuing `tasks/get`, `tasks/update`, or `tasks/cancel`
**MUST** receive `-32003` (`tasks.md:797-799`). A blanket declaration kill would
therefore keep every stored handle while making it unpollable, unanswerable, and
uncancellable — the tasks keep running and consuming server resources, invisible
to the user and to MCPJam.

MCPJam's position is **lifecycle-only continuation**. Rollback disables task
*creation* and leaves the *drain* path intact:

- surfaces stop declaring `io.modelcontextprotocol/tasks` on `tools/call`, and
  task affordances disappear from creation UI, so no new handles are minted;
- surfaces keep declaring the extension on `tasks/get`, `tasks/update`, and
  `tasks/cancel` for handles that already exist, for exactly as long as any
  outstanding handle is non-terminal;
- registry and public-API gates close for writes but keep serving reads of
  existing handles, so a user on another device can still find and cancel work
  they started.

Explicit cancellation is the operator escalation, not the default. If the
rollback is caused by a defect in creation or product policy, draining is
correct and cancelling would destroy work the user asked for. If the rollback is
caused by a defect in the lifecycle wire itself — where continuing to speak
`tasks/*` is what is unsafe — the procedure inverts to cancel-then-disable:
`tasks/cancel` every outstanding handle first, verify terminal status with
`tasks/get`, then drop the declaration entirely.

In-flight `input_required` tasks get an explicit rule, because they never reach
a terminal status on their own. During a drain they remain answerable: the
handle is shown read-only with two actions, respond (`tasks/update`) or cancel
(`tasks/cancel`), both of which still carry the declaration under
lifecycle-only continuation. When the rolled-back defect is in the input path
itself — elicitation, roots, or sampling handling — MCPJam does not offer
respond and cancels instead. An unattended drain that reaches its deadline
cancels rather than abandons.

Abandonment is the residual case, and it is bounded rather than silent. Anything
still non-terminal after cancel-then-disable is marked locally as unrecoverable
with the reason shown; MCPJam stops polling; and the registry row ages out under
the D3 unobservability bound, since `lastObservedAt` stops advancing once
polling stops. Stored browser handles are never removed as part of rollback, and
registry rows are never exposed project-wide.

Legacy `2025-11-25` behavior is unaffected by any of this. The legacy wire
carries no per-request extension declaration, so a creation-scoped or
declaration-scoped gate cannot reach it; legacy tasks continue to be created,
polled, and cancelled exactly as before. Every gate above is scoped to the
extension declaration specifically, not to Tasks as a product concept.

## 13. Final release checklist

- [ ] Ext-tasks commit pin and drift check are recorded in code and docs.
- [ ] The A0 era-gate override lets `tasks/get`, `tasks/update`, and
      `tasks/cancel` reach a real `2026-07-28` server, is scoped to those three
      methods, and fails loud on a client bump.
- [ ] Extension coverage is proven against a real fixture connection, not a
      mocked or seeded client manager.
- [ ] Corrected SDK schemas and `-32003` conformance checks pass.
- [ ] All task methods carry the right extension declaration and HTTP headers.
- [ ] Per-task scheduling never violates `pollIntervalMs`.
- [ ] Notifications work on persistent connections and fall back to polling.
- [ ] Elicitation, roots, and sampling task inputs use standalone trust rules.
- [ ] Input keys survive reload without persisting payloads.
- [ ] Host policy is tri-state and every surface matches the published matrix.
- [ ] Extension chat uses MCPJam-authored immediate text, not a nonexistent
      extension field.
- [ ] Hosted registry is owner- and authorization-context-scoped.
- [ ] No registry result, status-message, input, or model payload is stored.
- [ ] Registry retention starts at terminal status or a confirmed `tasks/get`
      `-32602`, never at creation or at an elapsed `ttlMs`, and an unobservable
      row still ages out.
- [ ] Rollback is creation-scoped: the drain path keeps declaring on
      `tasks/get`/`tasks/update`/`tasks/cancel`, and no handle is stranded.
- [ ] Public envelopes include `wire` and `lastUpdatedAt` and are
      status-discriminated.
- [ ] Preview polling endpoints ship with rate limiting and `Retry-After`.
- [ ] Existing CLI Tasks code is extended, not duplicated.
- [ ] Independent legacy and extension fixtures pass SDK, route, API, CLI, and
      UI suites.
- [ ] Policy-off and guest paths prove no task declaration leaves MCPJam.
- [ ] Docs consistently distinguish legacy Tasks from the official extension.

Only after every item is complete should MCPJam describe Tasks as fully
implemented. Earlier milestones should be labeled “legacy compatible”,
“extension core lifecycle”, or “preview”, according to what has actually
shipped.
