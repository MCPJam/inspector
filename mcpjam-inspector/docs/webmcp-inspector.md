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
client/src/stores/webmcp-inspector-store  session state, SSE stream
client/src/lib/webmcp-inspector/          aliases, chat dispatch, export
shared/webmcp-inspector-protocol.ts       the wire contract
server/routes/mcp/webmcp-inspector.ts     /api/mcp/webmcp/*
server/services/webmcp-inspector/         provider, runtime, registry, hub
```

`provider.ts` is the browser boundary. Everything above it — runtime, registry,
routes — is written against that interface and never imports Playwright, so the
hosted stage can run the browser elsewhere without reaching into tool identity,
queueing, activity or lifecycle. `playwright-provider.ts` is the only module in
the repo that speaks CDP.

`viewportTransport` on the session is the same seam for the viewer. A local
session reports `native-window` (the browser opens on the developer's machine
and they drive it) or `headless`; the hosted provider reports an interactive
URL; and a session whose picture comes from the CDP screencast reports
`frame-stream`. The client renders whichever it is handed.

## Watching the page inside the product

The inspector's left pane shows the page as it paints, over the same session
that carries tools and invocations:

```
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

## Running the tests

```bash
npx vitest run --project server server/services/webmcp-inspector/
npx vitest run --project client client/src/lib/webmcp-inspector/
```

The CDP and provider suites need Chromium. They skip locally when it is missing
and **fail** under `CI`, where the pinned Playwright image ships it — a silent
skip there would mean the one test guarding an experimental protocol quietly
stopped running.
