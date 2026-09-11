# WebMCP Inspector

A managed browser pointed at a page, so the WebMCP tools that page registers can
be listed, invoked, watched across navigations, and handed to a model.

Visibility follows `local-browser-enabled` in Node/Electron and
`hosted-browser-enabled` in hosted deployments.

## What it is for

WebMCP lets a web page register tools for an AI agent. Chrome ships its own
"Model Context Tool Inspector" extension that lists those tools, invokes them,
and offers a built-in agent chat, so this surface is not built to match it. It
is built for the things that extension does not do:

- **Any model.** Page tools go through the ordinary playground chat, so the
  developer tests their page against whichever model they actually ship on.
- **MCP and WebMCP together.** One conversation can hold the project's MCP
  servers and the page's tools at once, which is the shape a real agent has.
- **Evidence that outlives the session.** An activity timeline spanning
  navigations, before/after screenshots per invocation, and a JSON or OTLP
  export.

Readiness checks and eval-suite targets build on this; they are not here yet.

## Shape

```
client/src/components/webmcp-inspector/   the /webmcp workspace
  ├ WebmcpInspectorTab.tsx                 three-panel workspace (Tools-shaped)
  ├ WebmcpToolsSidebar.tsx                 URL + tools list / invoke form
  ├ ActivityTimeline.tsx                   activity as a log rail
  └ ElectronWebviewPane.tsx                the ONLY <webview> in the app
client/src/stores/webmcp-inspector-store  session state, SSE stream
client/src/lib/webmcp-inspector/          aliases, chat dispatch, export
shared/webmcp-inspector-protocol.ts       the wire contract
server/routes/mcp/webmcp-inspector.ts     /api/mcp/webmcp/*
server/services/webmcp-inspector/         providers, runtime, registry, hub
src/main.ts                               the switch, webviewTag, the guest guard
```

The workspace shares `ThreePanelLayout` with Tools / Resources / Prompts / Tasks:

- **Left** — URL field, tool list (searchable), and on select the invoke form.
- **Center** — the live page (webview, hosted Browser panel, or frame stream).
- **Right** — session activity as logs (search, copy, JSON / OTLP export).

The right rail is a custom slot, not the JSON-RPC `LoggerView`. Activity is
WebMCP evidence (registrations, invocations, before/after screenshots), not MCP
traffic. Session state and JSON-RPC traffic stay in separate stores. What is
shared is the chrome: `LogRow`, `LogToolbar`, `ToolDetailsAccordion`, and
`SelectedToolHeader` (tools identified by `{ id, label, description }`, so two
frames that both register `submit` stay distinct).

`provider.ts` is the browser boundary. Everything above it — runtime, registry,
routes — is written against that interface and never imports Playwright, so the
hosted stage can run the browser elsewhere without reaching into tool identity,
queueing, activity or lifecycle. Three implementations sit under it:
`playwright-provider.ts` (a Chromium it launched), `browserd-provider.ts` (one
on an MCPJam computer), and `electron-webview-provider.ts` (one the CLIENT
mounted — see below). `provider-shared.ts` carries the two things the two
CDP-speaking providers must not answer differently: the bridge-error
translation the timeline displays, and the screenshot budget the export
carries.

The WebMCP state machine itself — the tool map, the pending invocations, the
cancel-reason bookkeeping — lives in ONE place:
`server/services/browserd/daemon/webmcp-bridge.ts`. It used to exist twice, once
there and once inline in `playwright-provider.ts`, so every hard-won behaviour
in it had to be fixed twice or drift. The bridge imports nothing at all, which
is what lets Playwright's `CDPSession` satisfy its `CdpLike` structurally and
makes the eventual move into a shared `webmcp-runtime/` package a file move
rather than a refactor. Anyone doing that extraction should move the file rather
than inverting the dependency in place.

What stays in the provider is everything OUTSIDE the WebMCP domain — the
screencast, input dispatch, navigation, screenshots, lifecycle — plus the
translation between the bridge's vocabulary and this interface's:
`WebMcpBridgeError{failure}` becomes `WebMcpToolGoneError` or
`WebMcpInvocationCancelledError{reason}`, and `{invocationId, output}` loses an
id the runtime already has its own handle for. Unsupported detection stays at
the provider's `start()`, so a browser that cannot do WebMCP fails session
creation with an explanation instead of succeeding into an empty tool list.

TIMEOUT OWNERSHIP is the one part worth stating twice. The runtime owns the
per-invocation deadline, so when it hands the bridge a signal the bridge does
not arm its own, and it derives the cancel reason from `signal.reason`. Two
deadlines on one invocation means whichever fires first names the failure — and
the browser answers every cancel `Canceled` regardless of why, so a bridge that
ignored the reason would record every timeout as a user cancellation.

`viewportTransport` on the session is the same seam for the viewer. A local
session reports `native-window` (the browser opens on the developer's machine
and they drive it) or `headless`; the hosted provider reports an interactive
URL; a session whose picture comes from the CDP screencast reports
`frame-stream`; and a surface the CLIENT mounted reports `electron-webview`.
The client renders whichever it is handed — and it branches on the kind in ONE
exhaustive place (`viewportBehaviour` in `WebmcpInspectorTab.tsx`), whose
`satisfies never` default makes the next kind a typecheck failure rather than a
silent fall-through to window behaviour.

## Watching the page inside the product

The inspector's center pane shows the page as it paints, over the same session
that carries tools and invocations:

```text
Page.screencastFrame → ack FIRST → drop a byte-identical repeat → drop an oversized paint → 10fps throttle (~30fps during input, mandatory trailing frame)
→ runtime publishFrame → hub's coalesced slot → binary WS (or SSE)
→ Node-local WS: newest JPEG per animation frame → shared BrowserPaneSurface
```

Six properties hold this together, and each one is a bug if it is dropped:

- **Ack before anything else.** Chromium sends the next frame only once the
  current one is acknowledged. Acking after consumption lets a slow consumer
  starve the stream into stillness.
- **Frames never enter the replay ring.** They live in a single coalesced slot
  beside the latest tool snapshot, so a page animating at 10fps cannot flush the
  timeline the session exists to produce. A reconnecting client replays exactly
  one frame: the current one.
- **The throttle's trailing frame is mandatory.** The last paint of a burst is
  the one that shows what the page ended up looking like; drop it and a settled
  page leaves the pane stale forever.
- **Frames do not tick the idle clock.** A CSS spinner paints forever, and a
  session that could not be reaped while animating would hold a capacity slot
  nobody is using. Asking for the stream _does_ tick it — that is a person
  opening the pane.
- **A frame identical to the one before it is dropped.** Not an optimisation:
  every `Page.captureScreenshot` makes Chromium produce a compositor frame to
  satisfy the copy request, and the screencast sends that frame back
  byte-for-byte. Dropping the repeated paint avoids unnecessary decode and
  presentation work.
- **A frame describes its own geometry.** Dimensions come from the JPEG's SOF
  marker and ride the wire beside a `scale` (device pixels per CSS pixel), so a
  still captured at one scale and a streamed frame captured at another are safe
  to mix. CDP's screencast metadata reports DIP whatever the device scale
  factor is, and clicks are scaled against whatever a frame claims to be.

### Human interaction in the Node package

The workspace subscribes only to session, tools, activity, and control state.
Frame and screenshot subscriptions live inside the viewport, so streaming does
not rerender the activity rail or tools panel. Node-local binary frames are
coalesced before blob allocation and store publication. A socket write callback
proves transport progress, not that a viewer rendered a frame; this client
coalescing reduces presentation work without claiming to bound upstream buffers.

A local `frame-stream` socket advertises `{type:"capabilities",features:["input"]}`.
The viewer can then send `{type:"input",seq,events}` and receives
`{type:"input_ack",seq,dispatched,refused?}`. HTTP and socket input share the same
validation. The server adapts WebMCP events to the existing browser-pane relay
queue, preserving pointer modifiers, wheel direction/target changes, and input
order. Pending messages are bounded. The client retains ordering across socket
batches and HTTP fallback; it does not wait for an HTTP response per gesture.

A refused or interrupted input is surfaced. Unacknowledged input is never
replayed automatically, because the browser may already have executed it. Old
servers omit the capability and keep receiving ordered HTTP input. Electron's
native surface and hosted browser transport do not opt into this path.

The `webmcp:frame-stats` report includes `inputToAck` for socket input. It measures
dispatch completion, not the resulting paint. `inputToPaint` starts when input enters the store, including its queue wait; `dispatchToPaint` starts after that queue. Both remain a next-frame
proxy; the E2E interaction fixture paints a scroll marker to distinguish a real
scroll response from an unrelated animation frame. The marker test reports
input-to-frame-arrival separately from viewer decoding and display.

### Shared capture and pane geometry

Node-local inspection delegates capture and CDP input to browserd's
`createTabViewport`. The inspection provider retains browser launch, tool bridge,
popups and session lifecycle; it does not implement another screencast or mouse
controller. Hosted inspection already uses the Playground browser panel.

The shared stream uses stable JPEG quality 75, a 100ms resting floor and a 33ms
floor during human input. Oversized frames are dropped at 256 KiB. Automatic
settle screenshots, oversize substitutes and quality-driven encoder restarts
have been removed. Explicit timeline screenshots still use their own budget.
This trades automatic sharp-at-rest frames for a stable interactive capture path.

The Node UI uses DPR 1 and resizes the embedded browser to the pane's content
bounds after an 80ms resize debounce. Explicit API callers can still request
DPR up to 2. Native-window sessions retain their window geometry. Frame geometry
comes from the JPEG itself; pointer coordinates use its device-to-CSS scale.

The current inspection adapter still owns its socket and SSE/screenshot fallback
lifecycle. Those adapters are not a second capture/input engine; their remaining
lifecycle consolidation is tracked in [the unification plan](browser-viewer-unification-plan.md).

Frames are TRANSIENT and deliberately distinct from the screenshots on
invocation entries: those are persisted evidence at a 64 KiB budget, exported
with the session; a frame is a 256 KiB picture that the next paint replaces and
that nothing keeps. Never source one from the other.

## The embedded surface, in the desktop app

Inside the Electron app, "In app" means something better than a frame stream:
the client mounts a REAL Chromium surface and the server attaches to it.

That fixes a bug as well as the lag. The packaged desktop app's WebMCP tab could
not work at all before this: forge packages `.vite` with no `node_modules`, and
`playwright` is externalized in `vite.main.config.ts`, so `import("playwright")`
always rejects in the shipped app. There was no browser to launch. Attaching to
a surface the app already has is the only path to a working inspector there — and
because it deletes the capture/encode/stream/decode loop entirely, it is also the
only path to input that feels native rather than ~200ms behind.

OWNERSHIP IS INVERTED, and everything else follows:

```text
client mounts <webview>  →  waits for dom-ready  →  getWebContentsId()
      →  POST /sessions {display:"in-app", webContentsId}
      →  server: webContents.fromId → ownership guard → debugger.attach("1.3")
      →  the same WebMcpBridge, over a CdpLike backed by webContents.debugger
```

- **Mount, then start.** The server attaches rather than creates, so the surface
  must exist and have an id before the request goes out.
  `getWebContentsId()` THROWS until the guest attaches, so the client cannot
  mount and start in one tick either.
- **`dispose()` detaches, and never destroys.** React owns the element. What it
  does leave behind is a DENY window-open handler, replacing the app-wide one
  from `src/main.ts` — a deliberate change, so a surface whose session has ended
  cannot launch the viewer's browser.
- **A `webContentsId` is a capability.** `webContents.fromId` will hand back the
  app's own UI renderer, where the user's servers and tokens live. Four checks
  stand between a request and a CDP attach: the id resolves to a live surface,
  it is a `webview`, it is on `WEBMCP_WEBVIEW_PARTITION`, and its host is one of
  our own windows. Each is separately pinned by a test that fails when it is
  removed.
- **The surface is tab-scoped**, diverging from the "browser outlives the
  screen" rule the other transports follow: unmounting the component destroys
  the guest, so a session left open would be attached to a `webContents` that no
  longer exists. Leaving the tab ends the session. A persistent App-level
  webview host is a follow-up.
- **No screencast, no poll, no input forwarder, no aspect lock.** The pixels are
  already on screen and the surface takes real input; every one of those would
  be work done twice or work done wrongly.

All `<webview>` usage is confined to `ElectronWebviewPane.tsx`, and the server
only ever learns a number — so a future move to `WebContentsView` rewrites that
one component and changes no protocol and no provider. The element is never
reparented: moving a `<webview>` in the DOM destroys its guest.

The main process's half is in `src/main.ts`: `appendSwitch("enable-features",
"WebMCP")` before `whenReady` (switches freeze there, and the flag lives in the
renderer — note that `appendSwitch` REPLACES the value for a key, so a future
feature must comma-join into that one call), `webviewTag` on the main window, a
`will-attach-webview` guard that refuses any guest off the partition and
overrides `preload`, `nodeIntegration`, `contextIsolation`, `sandbox` and
`webSecurity` on the ones it allows (the element's attributes are a request,
not a fact — `disablewebsecurity` would otherwise drop the same-origin policy
inside a guest the provider then navigates to arbitrary pages), and deny-all
permission handlers on the partition's session. The renderer learns
it is packaged from `--mcpjam-packaged` in `process.argv`, because a sandboxed
preload cannot read `process.env` and `isElectron` is true in dev too.

Compatibility is a degrade, not a failure: a server that strips `webContentsId`
answers `frame-stream`, and the client renders the streamed pane it was handed.

## Driving the page from the pane

Three destinations, chosen per session:

- **Chrome window** — a real window on this machine, which the developer drives
  directly with their own devtools open. The pane streams a VIEW of it and is
  read-only: forwarding pane input would drive the same page a second time, so
  every click would land twice. Hidden in the packaged desktop app, where
  Playwright cannot launch at all.
- **In app, in the desktop app** — the embedded surface above. Reports
  `electron-webview`; the section above covers it.
- **In app, everywhere else** — no window at all. The browser runs headless,
  starts its screencast without being asked (nothing else would ever turn it
  on), reports `frame-stream`, and the pane is the only way to see or touch the
  page.

On the wire, an omitted `display` still means `window`, so an older client and
any programmatic caller are unchanged. The inspector's own UI sends `in-app`
explicitly, because that is what someone opening the screen now expects. A
hosted session refuses `in-app` outright rather than downgrading it: a hosted
browser already has a viewport with its own take-control lease, and honouring
`in-app` would drive one desktop from two places. `webContentsId` is refused
outside Electron (`electron-only`) and refused alongside any `display` but
`in-app` (`webview-display-mismatch`) — a surface the client mounted IS the
in-app view.

The rest of this section is about the FRAME-STREAM pane. An embedded surface
receives the viewer's real mouse and keyboard from the OS; none of the
forwarding below applies to it.

Input is a BATCH (`{type:"input", events:[…]}`), capped at 64 events. Pointer
movement is the flooding vector, and batching solves the rate at the transport
rather than asking every caller to remember to. The client half lives in
`client/src/lib/browser-pane/input.ts`, shared with Playground:

- **Scaling** happens on the client, against the CSS dimensions of the frame
  currently on screen (its device size divided by its `scale`) — only the client
  knows its rendered rectangle and how `object-contain` letterboxes the picture
  inside it, and the page's own coordinate space is CSS pixels. A click on a
  letterbox bar is dropped rather than mapped to the nearest edge.
- **Batching** coalesces moves to the latest and flushes on the next animation frame, but
  button and key transitions flush IMMEDIATELY: a click that waits out a batch
  window reads as a click that did not register.
- **Held keys are released on blur.** The page never learns that focus left the
  pane, so a modifier held at that moment would stay held for the rest of the
  session and turn every later click into a ctrl-click.

Server-side, the session runtime orders input from every socket and HTTP caller.
The shared viewport sends each wheel directly through CDP, including coordinates
and modifier snapshot in one call. Paste and IME use `Input.insertText`.
The shared client preserves dominant-axis wheel reversals and merges minor-axis
trackpad jitter. It pipelines ordered socket batches and serializes HTTP fallback.
Ack timeout disables socket input without closing the frame stream or replaying
input whose outcome is uncertain.

`BrowserPaneSurface` uses explicit shared authority for local inspection; it
renders no takeover ceremony. Hosted/Playground authority remains lease-based.
Pointer capture continues a drag outside the pane; blur/cancellation releases
held input. Native non-passive wheel handling prevents host scrolling. Paste is
sent as text once. Shift+Escape leaves the pane; bare Escape reaches the page.

Input ticks the idle clock (a human driving the pane must not be reaped) and
writes NO timeline entry, mirroring `capture_screenshot`. Its consequences
already produce entries: a click that navigates writes `navigated`, one that
fires a page tool writes `external_invocation`.

SECURITY: forwarded input runs with whatever session the browser profile holds.
That is identical to the native window it replaces — the human could always
click — and no approval semantics change. The MODEL's path to the page remains
the gated tool calls; this is the person's own hands, on their own page.

## Where the browser runs, and what gates each case

`transport` is a per-session choice, not a deployment fact. `local` opens
Chromium on the machine running the inspector; `hosted` drives one on the
member's own MCPJam computer through browserd, and reports
`remote-interactive-url` so the UI embeds the Browser panel instead of claiming
a window opened.

| Gate               | Local                                                 | Hosted                                                                   |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| Route mount        | `/api/mcp/webmcp` (the family is `!HOSTED_MODE` only) | `/api/web/webmcp`, behind `bearerAuthMiddleware` + `requireVerifiedAuth` |
| Server kill switch | `MCPJAM_WEBMCP_INSPECTOR_ENABLED` (default on)        | same                                                                     |
| Reachability       | —                                                     | `MCPJAM_WEBMCP_INSPECTOR_HOSTED_ENABLED=1`                               |
| Backend verdict    | —                                                     | `desktopProvisionable` from the runtime-config bootstrap                 |
| Client visibility  | `local-browser-enabled` (PostHog)                   | `hosted-browser-enabled` (PostHog)                                       |

Off means **404, not 403**: a disabled capability should not be discoverable.
The nav item's flag key must stay in `SIDEBAR_RESOLVED_FLAG_KEYS` or the item is
invisible forever.

`MCPJAM_WEBMCP_INSPECTOR_HOSTED_ENABLED` is deliberately **not**
`HOSTED_BROWSER_TOOLS_ENABLED`. Both switches lead to the same hosted browser,
but one lets a person drive their own page and the other hands six `browser_*`
tools to a model — with bash co-tenancy and approval threading behind it. One
variable would make turning on the first turn on the second.

### Authentication is not inherited from the bearer middleware

`bearerAuthMiddleware` validates `sk_` keys and guest tokens, then lets an
unrecognized WorkOS JWT through labelled `unverified_passthrough` — on the
stated understanding that routes forward the bearer to Convex and let Convex
judge it. This router does that only when it _establishes_ a session; every
command afterwards is served from an in-process map. Hence `requireVerifiedAuth`
on the mount, and an owner recorded on every hosted runtime, checked on every
request. A mismatch is a **404**, never a 403: hosted ids are derived, so they
are guessable, and a 403 would confirm which ones exist.

## Hosted sessions survive replicas, but not by pinning

A hosted session id is derived from its inputs — `hosted:<projectId>:<computerId>`
— because there is one persistent browser per desktop computer and therefore one
inspector session for it. Any replica can work out what an id refers to, attach
to the daemon the `browserSessions` row describes, and serve the request. Three
rules keep that safe (`services/webmcp-inspector/hosted-session-resolver.ts`):

- **Never reserve.** Re-hydration is reached from reads — a refresh, a
  reconnecting stream — and provisioning from those would wake a computer its
  owner deliberately let sleep, and bill for it. An asleep machine is reported
  as `409 hosted-desktop-asleep`, never woken.
- **Never serve someone else's session.** Ownership is proved by asking the
  control plane with the _caller's_ bearer; a computer that is not theirs comes
  back with a different id, or none.
- **Never register an empty tool map.** Invocations resolve their `toolKey` at
  dequeue, so a runtime registered before its first snapshot would answer "the
  page no longer offers that" for a tool the person is looking at.

Eviction of a hosted session publishes `detached`, not `closed`. The browser is
still running; only this replica's handle went away, and the client re-fetches.

The session id is also what the embedded viewport reads to decide which
project's computer it may authorize against. Not the sidebar's active project:
that moves when somebody switches projects, and the panel would then be looking
at a different machine than the session it claims to be showing.

The two kinds are capped **separately** (`MCPJAM_WEBMCP_HOSTED_MAX_SESSIONS`,
default 50, against `DEFAULT_MAX_SESSIONS` of 2). They count different things —
a Chromium window on this machine versus a handle to a browser on the member's
own desktop — and both live in one process whenever the local inspector runs a
hosted browser, so counting them together let two hosted handles fill the local
limit and refuse to open a window.

## Unattended runs drive their OWN box, not the member's

Everything above is about ONE hosted browser per `(project, member)` — the
Playground's computer, with their logins, a panel that can watch it and a lease
a person can take. `hosted:<projectId>:<computerId>` says so in its shape.

That identity is wrong for work nobody is watching. N parallel eval iterations
or swarm sessions in a project all resolve to the SAME computer, so they would
share one daemon, one tab and one cookie jar — and an `ephemeral` request
against the box a member is using mid-session is a mode mismatch, which means a
relaunch, which `pkill`s their Chromium.

So `ensureBrowserSession` takes a TARGET:

| Target               | Reserves                 | Stream | Relaunch claim / lease fence | Lifetime         |
| -------------------- | ------------------------ | ------ | ---------------------------- | ---------------- |
| `computer` (default) | yes, per member          | yes    | yes                          | the member's box |
| `sandbox`            | no — already provisioned | no     | no                           | the run          |

`ensureBrowserSession` REFUSES `ephemeral` on a computer target by name
(`ephemeral_requires_sandbox`), mirroring the local engine's
`owner_key_required`. A `sandbox` target names a per-run desktop box the caller
already provisioned — both its control-plane row and its vendor id — so this
path reserves nothing and bills nothing.

The omissions on the sandbox arm are decisions, not gaps. A relaunch claim and
a lease fence exist to stop two parties fighting over one SHARED box: another
replica, or a person at a keyboard. A per-run box has one run and one driving
process, and no panel can reach it. The record compare-and-swap stays as the
cross-replica backstop. There is no stream because nobody is watching, and the
handle and record TYPES are unions rather than shapes with optional fields —
so a `streamUrl: ""` placeholder that some future panel would render cannot be
constructed.

`persistent` on a sandbox target is refused too: a durable profile on a box
that dies with the run could keep nothing.

### Shipping ahead of the backend

A control plane that does not know the target answers 400. That is a TYPED
`unsupported_target` outcome, not a generic "unreachable", and `ensureOnSandbox`
refuses on it BEFORE it connects. The two need opposite behaviour: unreachable
means relaunch, and relaunching here would pay a cold desktop boot — the most
expensive thing on this path — on every attempt to reach the same dead end.

### Boot-to-ready is measured, not assumed

One cold desktop per iteration is the cost this design does not hide: every
iteration pays a boot before its first `browser_navigate`. Each fresh sandbox
boot logs `browser.sandbox_boot` with `connectMs`, `bootMs` and `totalMs`, so
the number exists from the first staging run rather than being guessed later —
and so a warm pool is scoped against a measurement rather than a hunch.

### Which run, as well as which box

`unattendedOwnerKey` stays an INDEPENDENT assertion. The target says which box;
the owner key says which run. The local engine has no target at all and keys on
the run alone, so dropping either would silently share something.

## The daemon takes a tool NAME, not the inspector's key

V1 keys a tool as `origin::name`, because two origins on one page can offer the
same name. The daemon does not: `webmcp_invoke.toolKey` is the tool's own name,
resolved against the live page, and `frameId` beside it is what disambiguates —
name resolution prefers the main frame, so a subframe's tool would otherwise be
shadowed by a same-named one above it.

Sending a composite there fails in the most confusing way available: the bridge
looks for a tool literally called `frame-main::search`, finds none, and answers
`webmcp_tool_gone` for a tool the person can see in the list. `frameId` is
optional on both sides — the daemon falls back to name resolution when it is
absent or when that frame has since gone — so an older daemon and a newer
caller still work together in either direction.

## Invocations are idempotent, and can end in `unknown`

Local calls can also end in `unknown` after cancellation or timeout. On Chromium
151.0.7922.34, CDP can acknowledge `Canceled` while the page callback continues
and performs side effects: the callback does not receive the draft's abort
signal. MCPJam therefore reports that cancellation was requested and execution
may continue, including when the browser never acknowledges the request. Verify
page state before retrying. Calls cancelled while queued or before dispatch
remain `cancelled`, because they never reached the page. A browser session ending
with a pending call likewise leaves its effects unknown. This is consumer-side
outcome reporting, not a guarantee of browser conformance or a way to undo work.

A hosted request can be dropped mid-flight or retried onto another replica, so
the client mints the `invokeId` and it flows all the way to the daemon's
at-most-once queue as its `commandId`. Both ends de-duplicate: the runtime
replays a settled outcome rather than enqueueing a second invocation (which
would write a second timeline entry and a second pair of screenshots for one
call), and the daemon recognises the id if a retry gets that far.

Hosted invocations answer **inline** rather than pointing at the event stream,
because the subscriber watching that stream may be attached to a different
replica than the one running the tool. That inline answer is the SETTLE, not a
summary of it: it carries the same `WebMcpInvocationOutcome` — output,
truncation flag, pre-cap byte count, `errorMessage` — that `invocation_settled`
carries on the stream, because for a hosted caller it is all they will get. Chat
fulfils a model's page-tool call straight from that value, so an outcome that
says `succeeded` and carries nothing answers the model with `null`.

`unknown` is a real terminal state. Hosted cancellation now sends
`webmcp_cancel {commandId}` immediately, so the daemon can latch cancellation
before it knows the browser invocation ID or dequeues the call. The caller
stops waiting and reports `unknown` once dispatch may have happened, because
Chromium can acknowledge cancellation while page code continues. Calls stopped
before dispatch retain a definite cancellation outcome.

A client that loses its settlement stream also retains `unknown` and its
original invocation ID. Its wait budget covers the serialized queue, tool
deadlines and screenshot overhead. `GET /sessions/:id/invocations/:invokeId`
reads a retained result without enqueueing any execution: pending returns 202,
a retained outcome returns 200, and an expired or replica-local missing result
returns `unknown`. The store exposes this as `recoverInvocationResult`.
This lookup is bounded by the runtime's retention window; it cannot recover
an outcome another replica never observed. Verify page state when it remains
unknown rather than retrying with a fresh invocation ID.

## Keeping the machine awake

The idle sweep hibernates a computer 30 minutes after its `lastActiveAt`, and
only bash commands and terminal I/O used to bump it. A person can watch a hosted
browser, drive it by hand, and invoke page tools for an hour without the control
plane seeing anything it counts — so the machine hibernates underneath them.

Two clocks, both touched from the route: the session row's (`kind: "command"` per
command, `kind: "panel"` on stream presence) and the computer's, throttled to
once a minute per computer by `utils/computers/activity-touch.ts`. The backend
applies its own 2-hour ceiling to presence touches, so a tab left open over a
weekend cannot hold a machine awake indefinitely. Closing the tab does **not**
hibernate: only the 30-minute sweep does, because there is no browser-close hook
the way there is for a terminal.

A per-run box has no hibernation clock of its own, but it does have a REAPER
that decides by activity — and the only things that touch one are a bash exec
and a reserve. A browser-only run makes neither: it drives the daemon over
HTTP. So a `command` touch on a sandbox-target session bumps
`evalSandboxes.lastUsedAt` in the same transaction, and a backend test pins the
inspector's once-a-minute throttle against the shortest sandbox TTL so a future
TTL cut cannot silently reap a box mid-turn.

## The tool poll has a budget

Tool discovery is polled, not pushed. Every `observe` used to be a `commandId`
the daemon had to remember for the life of its boot, against a 50,000 ceiling —
about a day of one watched session before it answered `at_capacity` to
_everything_. Two changes: reads are exempt from at-most-once tracking (they have
no side effects to protect, and re-running one returns something fresher), and
the poll is gated on somebody actually watching, backing off to 10s when nothing
has driven the page for a minute. It also pauses entirely while a person holds
the handoff lease, since the daemon refuses to observe then anyway.

The real fix is push: `daemon/webmcp-bridge.ts` already has an `onChange`
channel emitting complete snapshots. What is missing is a transport out of the
sandbox.

## The stream password never reaches the browser

The Browser panel used to embed E2B's noVNC page with the desktop password in
the iframe `src`. That password is not a view credential — the daemon's lease
gates model-driven commands, not VNC input, and `view_only` is a flag the client
applies to itself — so anyone who read it out of the DOM had full keyboard and
mouse on the member's desktop.

`routes/web/computer-browser-stream.ts` proxies RFB instead: it authenticates
upstream with the password from the session row, offers the browser security
type `None` on a socket the panel's own ~60s token already authenticated, and
pipes bytes. `GET /session` no longer returns `streamUrl` or `streamPassword`.

Proxying is also what makes the lease real for a _human_ viewer, since the
daemon never sees VNC packets. `utils/computers/rfb-client-filter.ts` is an
**allowlist** — not a denylist — because noVNC sends `QEMUExtendedKeyEvent`
(type 255) for every keystroke once the QEMU pseudo-encoding is negotiated, so
dropping only `KeyEvent`/`PointerEvent`/`ClientCutText` is a complete bypass.
`xvp` (power control) and `SetDesktopSize` are refused under any lease.

Two handshake details that fail silently when wrong: Node exposes no single-DES
cipher, so `des-ede3` with the key repeated three times is used (EDE with equal
keys _is_ single DES); and the VNC key is the password's first 8 bytes with each
byte bit-reversed — E2B mints 16 characters and `x11vnc -storepasswd` keeps 8.

The upstream websockify path is written to E2B's own recipe and marked
`VALIDATE-ON-STAGING`; the handshake itself is unit-tested against the protocol.

## Known gaps

- **Playground page tools are local-only.** `routes/mcp/chat-v2.ts` reads
  `pageTools` and classifies their approvals; the hosted route at
  `/api/web/chat-v2` never looks at the field. `WebmcpPageToolsSection` is
  hidden hosted rather than rendering a capability that would be silently
  ignored. Threading page tools through the hosted chat path is its own change.
- **Viewport constants disagree**: `BROWSERD_OBSERVATION_VIEWPORT` is 1024×768
  and `WEBMCP_VIEWPORT` is 1280×800. Cosmetic while hosted input goes over VNC
  rather than the pane — `dispatchInput` is a no-op on the hosted provider — but
  a pane that ever forwarded input to a hosted session would be off by 25%.

## What the CDP domain actually does

`webmcp-cdp.spike.test.ts` asserts all of this against a real browser, so a
Chromium bump that drifts the protocol fails there rather than in production.
The findings that shaped the code:

- **`WebMCP.enable` succeeds even when the feature is off**, and simply never
  reports a tool. Support is probed in the page instead
  (`document.modelContext`), after the first navigation.
- **`--enable-features=WebMCP`** is the minimal switch that exposes the page
  API. WebMCP is an origin trial, so without it a developer's own page registers
  nothing. `--enable-experimental-web-platform-features` also works and is
  deliberately not used: it would change how the inspected page behaves in
  unrelated ways.
- **Navigation fires no `toolsRemoved`**, and the main frame keeps its id. The
  provider synthesizes removal per frame; without it the registry would serve
  tools from pages the user has left.
- **Cross-origin subframe tools never reach the page's CDP session**, and the
  frame is absent from `Page.getFrameTree` — it is a separate target. That is
  not a scope boundary but the reason for one session per such frame; see
  **Cross-origin frames** below.
- **Annotations are carried through, per field.** The page API reads the `*Hint`
  key names and the CDP `Annotation` type reports them under the bare ones:
  `readOnlyHint` → `readOnly`, `untrustedContentHint` → `untrustedContent`,
  values included. `consequentialHint` is **not** copied at the pinned
  151.0.7922.34 (current Chromium does copy it, so this is a version fact and
  the spike fails when it changes), and `autosubmit` can only come from markup.
  A tool that declared the BARE names gets `false`, because those are not the
  keys Blink reads. None of this changes the rule: **a page's claim about itself
  never decides approval.**
- **Declarative tools** (`<form toolname>`) carry a `backendNodeId` and no
  `stackTrace` — the inverse of an imperative registration, which is what
  `registrationKind` reads. Blink derives their `inputSchema` from the form's
  controls: `min`/`max`/`step` become `minimum`/`maximum`/`multipleOf`, a
  `<select>` or radio group becomes an `enum` with `anyOf` consts beside it,
  `multiple` becomes an array, and the date-ish inputs get a `format` — `date`
  is a real JSON Schema format name, the rest are regexes.
- `invokeTool` takes `{frameId, toolName, input}` and returns `{invocationId}`
  before the tool settles — and before its own `toolInvoked` event. Statuses are
  `Completed | Canceled | Error`; on `Error` the message is on
  `exception.description`, not `errorText`.
- Oversized output passes through untruncated, so the 256 KiB cap is ours.

### Cross-document results are the platform's job

A WebMCP tool can finish in a document other than the one that started it: a
declarative form navigates, an imperative tool sets `location.href`. **Chromium
delivers those results itself, and we pass them through untouched.** It defers
until the destination document has finished parsing, collects **every**
`application/ld+json` block into a JSON **array**, and answers the ORIGINAL
invocation through the same probe behind `WebMCP.toolResponded`. The bridge keys
pending invocations by id and settles on that event whatever frame it came from,
so nothing in this repo reconstructs a result from a page — and nothing should
start to. This is written down because the code makes it look like a gap: the
bridge drops a navigated frame's tools and has no notion of a destination
document, so the next person to read it will reach the same wrong conclusion.

Measured per navigation shape (`webmcp-cdp.spike.test.ts`, "cross-document tool
results"), and end to end through the provider and runtime
(`playwright-provider.integration.test.ts`):

| shape                                 | delivered         | output                                     |
| ------------------------------------- | ----------------- | ------------------------------------------ |
| same-tab `toolautosubmit`             | yes               | array of the destination's JSON-LD         |
| named `target` frame                  | yes               | same, while the invoking document survives |
| imperative `location.href`            | yes               | same                                       |
| no `toolautosubmit`, a person submits | yes, when they do | same                                       |
| returns a value, then navigates       | yes, **twice**    | its own value first                        |
| `target="_blank"`                     | **no**            | nothing, ever                              |

Details worth keeping:

- **No intermediate null.** The declarative path suppresses the empty response
  the invoking document would otherwise produce, so exactly one answer arrives
  and settling on the first is settling on the real one.
- **A missing block set is `Completed` with `[]`** — an authoritative, empty
  answer, not an absence of one. Malformed blocks are skipped; the valid ones
  around them are kept.
- **The parse deferral is invisible.** The answer lands within tens of
  milliseconds of the navigation, four orders of magnitude inside the 60s caller
  deadline in `session-runtime.ts`.
- **Two answers for a return-then-navigate tool.** `submit_and_return` is
  answered with its own returned value and then, once the destination parses,
  with that document's JSON-LD. The first is the invocation's true outcome, so
  the bridge settles on it and DROPS the second rather than buffering it as
  somebody's early response.
- **Once answered, the invocation id is spent**: `cancelInvocation` rejects it.
- **A pending DECLARATIVE invocation cannot be cancelled at all.** A form
  waiting on a person is not a "pending execution" to the domain, so
  `cancelInvocation` rejects its id — where the same call on a pending
  _imperative_ invocation is accepted and answers `Canceled`. Stopping one still
  frees the caller, through the grace timer that settles a cancel the page never
  answers; what it does not do is stop the page. So the form stays live, a
  person submitting later answers an invocation already reported as unknown,
  and `settle()` remembering the id is what makes that late answer get dropped
  instead of buffered.

`target="_blank"` is the one shape that loses the response, and it is lost in
the browser rather than on the way to us: nothing arrives on the opener's
session, on the new tab's own session with the domain enabled there, or with
`Target.setAutoAttach` on the opener, and the invocation is pending in no
renderer at all. So there is nothing for a compatibility measure to recover —
extracting the destination's JSON-LD ourselves would be manufacturing a tool
result the browser deliberately did not produce, and presenting it as the page's
answer. The invocation stays pending until the caller's deadline. The spike pins
the behaviour so a Chromium that starts answering it fails loudly.

### Cross-origin frames

A cross-origin frame is a separate Chromium target, so its tools reach only a
CDP session attached to that frame. The bridge therefore listens on a SET of
sessions — the page's, plus one per separately-targeted frame — and merges what
they report into its single `${frameId} ${name}` map. Frame ids are unique
across sessions, so merging changes no identity and `toolKey` is untouched.

- **Attachment is a probe, not an origin comparison.** Comparing origins does
  not identify a separate renderer; Chromium's process allocation does. So the
  provider attempts `context.newCDPSession(frame)` and reads the answer.
  Playwright throws `"This frame does not have a separate CDP session…"` when
  there is nothing to attach to, and **that error alone** is swallowed. Every
  other failure is logged and raised as a session notice on the timeline,
  because a frame we could not reach is a frame whose tools are silently
  missing — the exact blind spot child sessions exist to close.
- **A session token, not a frame id, is what teardown quotes.** A frame keeps
  its CDP id across a cross-origin navigation, so a frame id names the frame and
  never one particular session on it. `addSession` answers with a token per
  attachment; a removal that arrives after the frame has been re-attached names
  an attachment that is already gone and does nothing. Cleanup keyed on the
  frame id would delete the live session's tools and leave a working frame
  showing an empty list.
- **`remove` is not `swap`.** `Page.frameDetached` carries a reason. A swap is a
  target moving — it is what the page's session reports the moment a frame
  becomes cross-origin — so only what THAT session registered is dropped. A
  removal is the frame going away, and takes every session's tools for it.
- **Nested targets.** In the Playwright providers, attachment does not recurse:
  Playwright's own auto-attach already does, so `page.frames()` is a flat list
  that reaches a widget inside a widget and one sweep covers it. Electron has no
  such list, so `Target.setAutoAttach` is sent again on each child session —
  attachment is recursive there or it is incomplete.
- **Cancellation binds to the owning session**, captured at invoke time. A
  cancel routed through whatever session currently owns the frame would reach a
  renderer that never started the invocation.
- **No silent default to the main session.** `WebMCP.invokeTool` rejects a frame
  id belonging to another target ("FrameId does not belong to current target"),
  so a plausible-looking fallback is not a degraded call — it is a call to the
  wrong renderer, which for a same-named tool runs something nobody named. An
  invocation whose owning session cannot be resolved is `webmcp_tool_gone` with
  a reason.

## Identity

Providers report `{frameId, name}` — the browser's identity, and useless as
ours, because frame ids churn across navigations. The runtime assigns
`origin::name` (plus a short frame-derived suffix when one origin registers the
same name twice), stable across reloads and readable in a URL or a transcript.
The live frame id is resolved at the moment of invocation.

For chat, tools additionally get an opaque `page_<8hex>` alias bound to the
observed registration. Aliases remain stable while that registration lives;
a reload or re-registration produces a new alias. The snapshot carries the
frame and registration sequence, plus boot/tab/navigation identity for hosted
browsers. Approval retains that snapshot, the runtime checks it at dequeue,
and the provider checks it again at CDP dispatch. A missing binding prevents
chat advertisement and invocation. Manual invocations capture the current
binding at enqueue. Neither CDP adapter substitutes a different frame.

A stale chat call is a **definite refusal before execution**, marked
`errorCode: "tool-gone"` in both SSE and inline outcomes. The client refreshes
the tool list through `GET /sessions/:id?refreshTools=1` (hosted providers read
it from browserd) and returns the refusal to the model. The existing automatic
client-tool continuation sends a fresh snapshot; the model can choose current
arguments and issue a new call, which follows the normal approval gate. No
manual MCPJam refresh is needed and old approvals are never transferred.
This recovery is limited to three consecutive stale refusals per session,
reset after a successful call. Unknown outcomes, cancellation, timeouts, and
ordinary tool errors never trigger this refresh/retry guidance. Recovery does
not itself execute a replacement tool; a model may explain that no suitable
tool remains instead of issuing another call.

Same-origin duplicate tool keys extend their frame-hash suffix until unique;
a hash collision cannot make two selections execute the first frame's tool.

## Approval

Manual invocation from the tab is **not** gated. A person clicking Invoke on a
tool they can see, on a page they opened, has already made the decision.

Every model-driven page call follows **Tool Approval**, the host's one approval
switch, exactly like an MCP server's tool or a browser verb. It used to gate
unconditionally, on the reasoning that a page tool runs code on a third-party
site and the only claims about what it does come from that site. That reasoning
still holds and still decides one thing: the page's own annotations are **never**
read, so nothing the site says can lower the gate. What it no longer decides is
whether to overrule the person who set the switch — a family that answers "not
you" teaches people the setting is decorative, which costs more than the pill
was worth.

So: switch on, every page call pauses; switch off, none do. The page never gets
a vote either way.

Page tools are a third client-fulfilled namespace beside `app_` and `ui_`.
Adding the alias to `isClientFulfilledToolName` is what wires the server's pause
and skip gates, so the two sides cannot disagree about who executes a call.

## Limits

|                     |                                                         |
| ------------------- | ------------------------------------------------------- |
| Concurrent sessions | 2                                                       |
| Idle TTL            | 10 min, refreshed by API calls **and** browser activity |
| Absolute lifetime   | 60 min                                                  |
| Invocation timeout  | 60s, cancellable                                        |
| Queue depth         | 5 behind the running invocation                         |
| Result cap          | 256 KiB (marker included), input echo 16 KiB            |
| Activity ring       | 200 server-side, 500 client-side                        |

Invocations are serialized per session: page tools mutate one shared page, and
running two at once would interleave their effects.

## Known limitations

- **Popups are reported, not inspected.** They are deliberately left open —
  closing one, or re-hosting its URL in the main tab, breaks OAuth and anything
  using `window.opener`. Their tools belong to a separate target, and unlike a
  cross-origin FRAME nothing attaches a session to them.
- **A tool whose form targets `_blank` never settles.** The browser produces no
  response for it at the pinned Chromium (see **Cross-document results** above),
  and there is nothing to recover, so the invocation runs out the caller's
  deadline and the timeline records its outcome as unknown after timeout.
  Nothing observable distinguishes this case from a page that is merely slow.
  Every other navigation shape is answered natively.
- **Chat sees a per-turn snapshot** of the page's tools; a registration that
  happens mid-turn surfaces on the next one, including the automatic
  continuation after a stale-registration refusal.
- **Headed needs a display.** Over SSH, in a container, or on a bare WSL
  install, set `MCPJAM_WEBMCP_HEADLESS=true`: discovery, invocation and
  screenshots all still work, only driving the page by hand does not.
- **Page output is untrusted.** It renders as text, never as markup, and is
  capped. The hosted stage will need more than this.
- **A surface is not bound to the session that asked for it.** The ownership
  guard proves a `webContentsId` names one of OUR webview guests — which is what
  keeps the app's own renderer out of reach — but it does not prove the caller
  is the tab that mounted that particular guest. A local caller who learned
  another eligible id could drive that surface. The blast radius is a page the
  user themselves opened for inspection, and every `/api/mcp/*` route is equally
  reachable by a local caller today; binding the id to its requesting session
  (a nonce handed to the pane at mount) is the fix if that changes.
- **The embedded surface does not survive leaving the tab.** Unmounting the
  component destroys the guest, so the session ends with it. A persistent
  App-level webview host would fix this and is a scoped follow-up.
- **The embedded surface denies every permission.** Camera, microphone,
  clipboard read, geolocation: all refused on `WEBMCP_WEBVIEW_PARTITION`. "The
  developer's own page" is not a security boundary — it navigates, and it embeds
  third-party frames — so loosening any single one is a deliberate follow-up with
  its own reasoning rather than a default.
- **`capturePage` on an occluded window is platform-dependent.** A minimized app
  can hand back an empty or stale bitmap; the budget chain resolves `undefined`
  rather than putting a blank JPEG in the timeline, but the timeline will simply
  say "no screenshot" for those invocations.

## Running the tests

```bash
# The session service, both providers, the shared WebMCP state machine, and the
# routes. The Electron provider's suite needs no Electron — it runs against the
# fake in `__tests__/fake-electron.ts`.
npx vitest run --project server \
  server/services/webmcp-inspector/ \
  server/services/browserd/daemon/__tests__/webmcp-bridge \
  server/routes/mcp/__tests__/webmcp-inspector

# The store, the surface, and the input forwarder.
npx vitest run --project client \
  client/src/lib/webmcp-inspector/ \
  client/src/components/webmcp-inspector/ \
  client/src/stores/__tests__/webmcp-inspector-store
```

The CDP and provider suites need Chromium. They skip locally when it is missing
and **fail** under `CI`, where the pinned Playwright image ships it — a silent
skip there would mean the one test guarding an experimental protocol quietly
stopped running.

## Checking the embedded surface by hand

Unit fakes cannot prove this half. The switch actually enabling WebMCP in a real
guest, `will-attach-webview` enforcement, real debugger traffic, permission
denial, popups, packaged behaviour and the latency itself are all integration
facts — so these two passes are part of "done", not extra credit.

**In dev.** Run it with `NODE_ENV` set explicitly:

```bash
NODE_ENV=development npm run electron:start
```

The variable is a TIMING problem, not a missing one. `startHonoServer` does set
`NODE_ENV=development` when the app is unpackaged — but `src/main.ts` reads it
into `isDev` at module load, before that assignment runs. So a bare
`electron:start` leaves `isDev` false for the life of the process:
`createMainWindow` loads the embedded server instead of forge's Vite renderer,
and that server (unpackaged Electron) 307s every front-end route to the
hardcoded `http://localhost:8080` from `getInspectorFrontendUrl`. Setting the
variable on the command line is what makes `isDev` true early enough; the window
then loads forge's renderer and `/api` proxies to `:6274` (the log says which
port).
Then: WebMCP tab → In app →
`https://googlechromelabs.github.io/webmcp-tools/demos/explainer/`. What to look
for, in order — scrolling and typing that feel native rather than streamed
(the point of the whole thing); three tools appearing; `getAvailability`
invoking with a screenshot in the timeline; an in-page navigation updating the
URL bar. Then start a session with the guest's devtools already open: the attach
fails and says to close them. "Chrome window" still works in dev, where
`node_modules` exists.

Worth observing rather than assuming: **invoke a tool with the window
minimized.** `capturePage` on an occluded window is platform-dependent, so the
timeline may legitimately show no screenshot for that invocation — the budget
chain resolves `undefined` rather than storing a blank.

**Packaged** — this is the pass that proves the bug fix:

```bash
npm run build && npm run electron:package && npm run electron:install
```

In the installed app an in-app WebMCP session should work end to end (it could
not before), "Chrome window" should be absent, closing the session should empty
the pane, and quitting mid-session should leave no orphaned processes.

### Node input fallback and ordering

The client awaits each socket acknowledgement before sending its next batch; this removes HTTP overhead, not per-batch dispatch waiting. An acknowledgement timeout marks that input uncertain and disables socket input for that connection, while binary frames keep flowing. Only later input falls back to HTTP; the uncertain batch is never replayed. The per-connection caps also protect against other callers, even though this client sends one batch at a time.

The session runtime serializes input from all sockets and HTTP callers, so a slow socket dispatch cannot overlap a later fallback request. Failed dispatches do not wedge the tail. Queued input is checked again before dispatch for session close/replacement or caller cancellation. Socket dispatch refreshes activity and reports a missing session explicitly. Wheel coalescing preserves reversals on the dominant axis while summing minor-axis trackpad jitter without losing distance.
