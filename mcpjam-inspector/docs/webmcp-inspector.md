# WebMCP Inspector

A managed browser pointed at a page, so the WebMCP tools that page registers can
be listed, invoked, watched across navigations, and handed to a model.

Local only, behind `webmcp-inspector-enabled`.

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
  └ ElectronWebviewPane.tsx                the ONLY <webview> in the app
client/src/stores/webmcp-inspector-store  session state, SSE stream
client/src/lib/webmcp-inspector/          aliases, chat dispatch, export
shared/webmcp-inspector-protocol.ts       the wire contract
server/routes/mcp/webmcp-inspector.ts     /api/mcp/webmcp/*
server/services/webmcp-inspector/         providers, runtime, registry, hub
src/main.ts                               the switch, webviewTag, the guest guard
```

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

The inspector's left pane shows the page as it paints, over the same session
that carries tools and invocations:

```text
Page.screencastFrame → ack FIRST → oversize drop → 10fps throttle (with a
mandatory trailing frame) → runtime publishFrame → hub's coalesced slot → SSE
→ store liveFrame → the pane
```

Four properties hold this together, and each one is a bug if it is dropped:

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
  nobody is using. Asking for the stream *does* tick it — that is a person
  opening the pane.

Streaming is demand-driven through the `set_screencast` command, sent when the
pane is visible and withdrawn when it is not. A server that predates the command
answers 400, and the client silently falls back to a 1s screenshot poll — which
is also the path for a hosted session, whose viewport lives in the Browser
panel.

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

```
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
`will-attach-webview` guard that refuses any guest off the partition and strips
`preload`/`nodeIntegration`/`contextIsolation:false` from the ones it allows,
and deny-all permission handlers on the partition's session. The renderer learns
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
`client/src/lib/webmcp-inspector/input-forwarder.ts`:

- **Scaling** happens on the client, against the dimensions of the frame
  currently on screen — only the client knows its rendered rectangle and how
  `object-contain` letterboxes the picture inside it. A click on a letterbox bar
  is dropped rather than mapped to the nearest edge.
- **Batching** coalesces moves to the latest and flushes on a ~50ms timer, but
  button and key transitions flush IMMEDIATELY: a click that waits out a batch
  window reads as a click that did not register.
- **Held keys are released on blur.** The page never learns that focus left the
  pane, so a modifier held at that moment would stay held for the rest of the
  session and turn every later click into a ctrl-click.

Server-side, `dispatchInput` goes through Playwright's `page.mouse` /
`page.keyboard` rather than raw `Input.dispatchMouseEvent`: those primitives
want a modifier bitmask, a `text`/`unmodifiedText` pair and a virtual key code
per key and per layout, and Playwright already carries that table. Text uses
`keyboard.insertText`, because paste and IME composition have no keystrokes to
replay. Each event is applied under its own catch — one exotic key must not
swallow the click behind it — and coordinates are clamped to the viewport.

Input ticks the idle clock (a human driving the pane must not be reaped) and
writes NO timeline entry, mirroring `capture_screenshot`. Its consequences
already produce entries: a click that navigates writes `navigated`, one that
fires a page tool writes `external_invocation`.

SECURITY: forwarded input runs with whatever session the browser profile holds.
That is identical to the native window it replaces — the human could always
click — and no approval semantics change. The MODEL's path to the page remains
the gated tool calls; this is the person's own hands, on their own page.

## Three gates

1. `/api/mcp/*` mounts only when `!HOSTED_MODE` — a hosted replica has no
   machine to open a browser on.
2. `MCPJAM_WEBMCP_INSPECTOR_ENABLED` — server-side emergency stop, forced off
   hosted. Off means 404, not 403: a disabled capability should not be
   discoverable.
3. `webmcp-inspector-enabled` (PostHog) — client visibility. The nav item's key
   must stay in `SIDEBAR_RESOLVED_FLAG_KEYS` or the item is invisible forever.

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
  frame is absent from `Page.getFrameTree` — it is a separate target. V1 scope
  is therefore main frame plus same-process frames.
- **Annotation values are not plumbed through** for imperative registrations: a
  tool registered `readOnly: true` is reported as `false`. Annotations are
  displayed as claims and never decide policy.
- `invokeTool` takes `{frameId, toolName, input}` and returns `{invocationId}`
  before the tool settles — and before its own `toolInvoked` event. Statuses are
  `Completed | Canceled | Error`; on `Error` the message is on
  `exception.description`, not `errorText`.
- Oversized output passes through untruncated, so the 256 KiB cap is ours.

## Identity

Providers report `{frameId, name}` — the browser's identity, and useless as
ours, because frame ids churn across navigations. The runtime assigns
`origin::name` (plus a short frame-derived suffix when one origin registers the
same name twice), stable across reloads and readable in a URL or a transcript.
The live frame id is resolved at the moment of invocation.

For chat, tools additionally get an opaque `page_<8hex>` alias: page-authored
names are arbitrary while a model-facing name must satisfy
`^[a-zA-Z0-9_-]{1,64}$`.

## Approval

Manual invocation from the tab is **not** gated. A person clicking Invoke on a
tool they can see, on a page they opened, has already made the decision.

Every model-driven page call **is** gated, unconditionally — not via
`requireToolApproval`. A page tool runs code on a third-party site, the only
claims about what it does come from that site, and Chromium does not carry those
claims through anyway. The sanctioned way to relax this later is an explicit,
per-session "trust this page's read-only claims" choice, never a flag that
quietly turns every page tool into an auto-run.

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
  using `window.opener`. Their tools belong to a separate target.
- **Cross-origin subframe tools are invisible**, per the finding above.
  Supporting them means `Target.setAutoAttach`.
- **Chat sees a per-turn snapshot** of the page's tools; a registration that
  happens mid-turn surfaces on the next one.
- **Headed needs a display.** Over SSH, in a container, or on a bare WSL
  install, set `MCPJAM_WEBMCP_HEADLESS=true`: discovery, invocation and
  screenshots all still work, only driving the page by hand does not.
- **Page output is untrusted.** It renders as text, never as markup, and is
  capped. The hosted stage will need more than this.
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

A bare `electron:start` leaves `NODE_ENV` unset, and the embedded server then
307s documents to a hardcoded `localhost:8080`. With it set, the window loads
forge's Vite renderer and `/api` proxies to `:6274` (the log says which port).
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
