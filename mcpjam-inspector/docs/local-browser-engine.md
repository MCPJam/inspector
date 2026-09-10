# The agent browser on this machine

Engineering notes for the local browser engine: what it is, what it is _not_,
and the checklist for turning it on and off. Companion to
[`local-computer-engine.md`](./local-computer-engine.md), which covers the
shell; this covers the browser, and the two are deliberately separate
capabilities with separate switches.

## What it is

A third **engine** behind the `browser_*` tools. Where the hosted engine runs
`mcpjam-browserd` as a process inside an E2B desktop and talks to it over
HTTPS, the local engine builds the **same daemon stack in the inspector
process** and drives a Chromium on the user's own machine.

Everything above the client is byte-identical to hosted — the six tools, the
command queue, the handoff lease, the observation budgets, the state tokens.
The engine is one seam: which `ensureSession` function `buildBrowserTools`
calls.

```
model ──► browser_* tools ──► SessionClient ──► browserd stack ──► ChromiumDriver
                 ▲ engine chosen        HTTP (hosted)      queue · lease · budgets
                 │ in the registry      or a function
                 │ independently of bash    call (local)
          hostConfig.builtInToolIds
```

### Pieces

| Concern                                | Where                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Session lifecycle, profiles, idle reap | `server/services/browserd/local/local-browser-session.ts`                                                     |
| The daemon without a socket            | `server/services/browserd/in-process-client.ts`                                                               |
| One decoder for both transports        | `server/services/browserd/browserd-codec.ts`                                                                  |
| Screencast + input over CDP            | `server/services/browserd/daemon/viewport.ts`                                                                 |
| Engine resolution                      | `server/utils/built-in-tools/registry.ts` (browser branch)                                                    |
| Routes                                 | `server/routes/mcp/computers.ts` (`/local-browser/*`)                                                         |
| Frame socket                           | `server/routes/web/local-browser-frames.ts`                                                                   |
| Rail pane                              | `client/src/components/browser/BrowserPaneSurface.tsx`, with `LocalBrowserBody.tsx` / `HostedBrowserBody.tsx` |
| The desktop app's native surface       | `server/services/browserd/electron/agent-surface.ts`, `src/ipc/agent-browser/agent-browser-listeners.ts`      |
| The pane with no picture               | `client/src/components/browser/ElectronNativeBody.tsx`                                                        |

## Trust model

Browser and shell have independent consent scopes. Browser permission covers
control of Chromium and its **signed-in websites**; it never authorizes Bash.

- **This is not a sandbox.** Chromium runs as the OS user, in a profile that
  persists their sessions. The boundaries are device _consent_, _per-action
  chat approval_, and the _actor gates_ — never the profile path.
- **The profile is per project** because a login for one project should not
  silently be a login for another. That is a product decision, not
  confinement. What _is_ validated is the project key, because it becomes a
  path segment under a fixed root.
- **Per-action approval is forced on**, exactly as it is for local `bash`. The
  blast radius of an unreviewed click here is the user's accounts, not a
  disposable box.
- **Project secrets never reach this Chromium.** The env allowlist in
  `local-machine.ts` is the precedent and this path does not widen it.
- **The lease is the privacy boundary**, and it is enforced at the daemon: a
  person holding the browser blocks every model-driven command _and every
  observation_, including one already queued or mid-flight.

## Location and Browser permission

The Browser panel owns **This machine / Cloud**, grant/revoke, and Chromium
installation in both layouts. Node-local and Electron default to This machine;
hosted defaults to Cloud. Browser selection is stored separately from Computer
selection. Local candidacy uses `local-browser-enabled` and
`engines.local.browserAvailable`; neither Bash availability nor
`local-computer-enabled` enables or disables Browser.

A new explicit Browser grant is required after upgrading from the shared-grant
implementation. The server stores only its hash in
`~/.mcpjam/browser/consent.json`. The client sends the capability in
`X-MCPJam-Browser-Consent`. Shell grants retain their existing file and header;
shell, Browser, and harness capabilities are not interchangeable. Revoking
Browser invalidates frame nonces, active streams and Electron input without
revoking shell permission or deleting profiles.

Enable Browser alone, Bash alone, or both. Each retains its own authorization
and destination. Local Browser and local Bash share this machine. Two Cloud
selections do not by themselves guarantee the same box: conversation Browser
uses its watched desktop, while personal Bash uses its configured computer.
A run with an explicit shared desktop binding uses that box for both. Never
assume `localhost` or files are shared across different boxes.

A conversation's existing logical-session `box` determines Browser location;
changing it requires **Start new chat**. Resume looks up that binding, which
never grants execution access. Explicit local requests that cannot run suppress
Browser with a thread notice and panel remedy; unrelated chat remains usable.
Open/control requests instead return `browser_consent_required` (403),
`browser_runtime_unavailable` (503), or `browser_location_mismatch` (409).
A disabled deployment can return 404 with a structured reason.

Org-managed models requesting local Browser use Inspector's local tool loop
with `/stream/org` as the model broker; the org key remains in Convex. Hosted
web chat rejects local Browser selection and Browser consent headers.

## Profiles

| Surface                 | Mode                                                       | Why                                                                                           |
| ----------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Playground chat         | persistent, `~/.mcpjam/computer/browser/<project>/profile` | A login must survive the turn that made it.                                                   |
| Evals, swarms, journeys | ephemeral, no profile at all                               | One run must never inherit another's cookies — that is a verdict decided by the previous run. |

Derived from the approval delivery, never configured: a surface that can ask a
person is interactive and keeps its logins; one that cannot starts blank.

## Durable browser sessions

Hosted Playground conversations use a durable logical session owned by the
conversation, rather than treating a browser daemon boot as the identity. The
first browser command lazily provisions a watched desktop sandbox; reloads and
replica changes resolve the same session and reattach to its current box. An
idle watched box can sleep after its activity window and wakes on the next
explicit panel or browser touch. A cross-replica relaunch claim and the
browserd handoff lease protect a person from a concurrent restart.

Evals and swarm attempts use the same owner contract with an ephemeral,
per-iteration or per-attempt desktop sandbox. They never fall back to the
project computer and never inherit the user's default profile. Local sessions
use the same logical identity when the hosted control plane is configured, and
degrade to the existing local ledger when it is not.

The backend also persists project-scoped browser-profile archives with a
256 MB cap and default-profile selection. The runtime honors an explicit host
or suite profile pin before the user's default. From the browser pane, a
person can save a drained persistent profile; the archive is filtered to omit
Chromium caches and singleton locks, uploaded to Convex storage, and imported
only on the next fresh boot. Computer settings lists the saved profiles and
lets the owner choose the default for new chats or delete one.

## The browser is a full Chromium, headless

`headless: true` alone resolves to `chromium-headless-shell` — the _old_
headless, a different binary with a different compositor path and a
fingerprint public sites recognise and block. The local engine passes
`channel: "chromium"`, so "no window" means the same build a headed launch
would use, merely not shown, with the anti-fingerprint switches from
`daemon/launch-args.ts` (`--disable-blink-features=AutomationControlled`, a
pinned real UA, the hover/pointer media pins).

`MCPJAM_BROWSER_HEADED=1` opens a real window where a display exists. The pane
streams either way.

## Node-local frame presentation

The local Playground pane opts into bounded JPEG decoding: one decode in flight
and one replaceable pending frame. Older queued frames are skipped before
starting another decode, and teardown releases pending work. The decoder's
existing sequence guard still prevents backwards presentation. Electron and
hosted consumers retain their existing policies; H.264 frames are not subjected
to JPEG frame dropping.

## The profile singleton

A Chromium profile directory is a singleton, guarded by `SingletonLock`. The
hosted engine may clear it unconditionally because it `pkill`s the daemon
first. Here the owner might be a second inspector server, or the user's own
Chrome pointed at the same directory, so `probeSingletonOwner` reads the
lock's `host-pid` target and asks whether that process is alive on this host.
A live owner is a typed `profile_in_use`; only a dead lock is cleared.

## Lifecycle

- One browser per (project, context mode). It outlives a chat turn.
- Idle 10 min, hard lifetime 60 min, swept every 30 s.
- **A held or parked lease defers the reap.** Taking control _is_ using it;
  reaping there closes the window someone is typing a password into.
- Closed by `shutdownLocalBrowserSessions` (latching) on a terminating process
  and `killLocalBrowserSessions` (non-latching) on Electron's
  `window-all-closed`, which on macOS is followed by a server restart.
  Closing the context is also what releases the profile lock, so a skipped
  teardown is a browser the next run cannot start.

## Install Chromium from the Browser panel

Never inside a chat turn: the download is hundreds of megabytes and a model
sitting in a tool call for minutes has no way to say why.
`POST /api/mcp/computers/local-browser/install` runs it with progress, behind
consent; `ensureLocalBrowserSession` refuses with `chromium_not_installed` and
points at it.

## Routes and their gates

| Entry point                                                                | Gates                                                                                                                                                          |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat `browser_*` (playground)                                              | non-hosted + kill switch + signed-in non-guest + server-verified consent + per-action approval                                                                 |
| Chat `browser_*` (guest / scenario / journey)                              | **never local** — an explicit local request is refused, never moved to Cloud                                                                                   |
| `GET /local-browser/status`                                                | session + verified sign-in + non-guest + kill switch. No consent: the consent screen needs it to describe itself.                                              |
| `POST /local-browser/install`                                              | the above **+ consent**                                                                                                                                        |
| `POST /local-browser/{ensure,token,lease,input}`                           | the above **+ consent**                                                                                                                                        |
| `POST /local-browser/{session,command,note,trace,artifact,close,sessions}` | the above **+ consent**. The agent surface; see below.                                                                                                         |
| `GET /api/web/computers/local-browser/frames`                              | allowed `Origin` (**absent Origin rejected**) + single-use, 60 s, kind-bound nonce + the nonce's consent fingerprint must still match + **the daemon's lease** |
| Hosted build                                                               | `/api/mcp` unmounted, kill switch forced off, WS route not mounted                                                                                             |

Nonces are typed by what they open, so a terminal nonce cannot start a frame
stream and a frames nonce cannot open a shell.

## The agent surface

An outside coding agent — Claude Code, Cursor, any MCP client — drives this
browser through the same routes, over the transport `mcpjam inspector open`
already uses. It is not a second way in: every command goes through the
in-process client, so the auth check, the handoff lease, the bootId check and
the idempotent queue apply exactly as they do to a model's tool call.

| Concern                           | Where                                                   |
| --------------------------------- | ------------------------------------------------------- |
| The public contract (v1)          | `shared/browser-agent-contract.ts`                      |
| Contract ⇄ daemon, exhaustive     | `server/services/browserd/agent-contract-mapper.ts`     |
| The door: policy, actor, outcomes | `server/services/browserd/local/agent-door.ts`          |
| Logical session + durable ledger  | `server/services/browserd/local/agent-session-store.ts` |
| The ledger itself                 | `server/services/browserd/daemon/command-ledger.ts`     |
| CLI                               | `../cli/src/commands/browser.ts`                        |
| The rail's Activity list          | `client/src/components/browser/BrowserActivityList.tsx` |

Four things about it are load-bearing.

**`source` and `actor` are stamped server-side, never read from a body.**
`manual` is the one source the handoff lease does not block, so a caller able
to choose its own source could drive — and observe — a browser somebody is
signing into. The actor's `kind` is fixed by the route and the authenticated
identity rides in its `label` (`anonymous` where a self-hosted install has
nobody to name, shown rather than smoothed over).

**Three outcomes, never conflated.** `executed` ran (and `ok` separately says
whether it succeeded — a click that found no button ran fine and failed);
`refused` means nothing ran, so a retry is safe; `unknown` means we cannot say,
and the caller is told to read the ledger by `commandId` rather than retry.
Collapsing `unknown` into `refused` is the tempting simplification and the
dangerous one: it tells a caller a payment is safe to re-submit.

**The ledger is written at the daemon's command entry**, because that is the
only place that sees every disposition — the lease gate, the bootId check and
the queue's `busy`/`expired`/`at_capacity` all answer before an executor is
reached. Refusals the inspector itself makes (an origin outside the allowlist,
an op the policy excludes) are posted back through `POST /v1/trace` so the ring
stays the single ordered ledger with one `seq` minter. When policy enforcement
moves into the daemon (I-11a) that path goes away.

**The capture policy runs at write.** `type` values are stored as
`{redacted: true, chars: N}` unless a session explicitly opts in (ephemeral
profiles only — a persistent profile is somebody's real logged-in browser);
URLs lose their query and fragment; `data:` URLs are dropped; a page tool's
input is never recorded; and nothing page-derived is written at all for a
command the lease refused.

The logical session is a new entity because `browserSessions` is a **boot**
record — it is deleted and re-inserted on every relaunch — so an agent's
history and a permalink cannot hang off it. Locally it is a JSON file beside
the profile, written only by the inspector server; the CLI reaches it through
these routes, so there is no two-process locking story to invent.

It records **which browser** it drives (`browserKey`), not just which project.
A project can have a person's persistent Chromium and several ephemeral run
browsers at once, so resolving a session by project alone would send an
unattended run's commands to the logged-in browser. The key survives a
relaunch, which a boot id does not. Artifact payloads are stored **per project**
rather than per session, because two sessions sharing one browser both mirror
the same unclaimed command and the daemon holds one copy of its screenshot;
what a session may fetch is still decided by its own ledger.

```bash
mcpjam browser consent --token <browser-capability>  # granted in Browser panel
mcpjam browser open --mode allow_all --profile persistent
mcpjam browser navigate https://example.test  # returns the a11y tree
mcpjam browser act --verb click --ref e7      # …and the tree after the click
mcpjam browser trace                          # who did what, in order
mcpjam browser close                          # detaches; --terminate closes it
```

The CLI requires `capabilities.browserConsent: true` from Inspector; an older
server produces an update-required error. Token precedence is `--consent`,
`MCPJAM_BROWSER_CONSENT`, then Browser-scoped CLI state. `MCPJAM_LOCAL_CONSENT`
and the legacy unscoped state field are ignored. `browser consent` verifies the
supplied token before storing it; cloud commands use cloud credentials only.

The CLI never grants its own consent: the Inspector's consent screen is where
a person authorizes the agent browser, and a CLI able to mint the capability
would be that screen's own bypass.

## Kill switch

```dotenv
MCPJAM_LOCAL_BROWSER_ENABLED=false
```

Turns the engine off on a server: the routes 404, `engines.local.browserAvailable`
reports false, and `ensureLocalBrowserSession` refuses. Forced off in hosted
mode regardless. Separate from `MCPJAM_LOCAL_COMPUTER_ENABLED` on purpose —
driving a browser and running shell commands are different amounts of trust.

The same caveat governs rollback as for the shell: this is a _server_ env var,
and users on published npm or Electron builds are on their own machines. UI
exposure needs its own client-evaluated flag before wide release.

## Recording an unattended run

An unattended run on a per-run hosted browser leaves an MP4 behind, and the run
page plays it next to the trace. The box is disposable and nobody is watching
it, so the file is the only account of what the agent saw.

```
POST /v1/record  {"action":"start","id":"<session>","fps":15}
POST /v1/record  {"action":"stop"}   → {path, bytes, durationMs, distinctFrames, truncated}
GET  /v1/record                      → the current take, if any
```

A daemon **route**, not a `BrowserAction`, and never lease-gated: a recording
outlives handoffs, a person taking control mid-run must not end the recording
of the run they took it during, and a retried `stop` in the at-most-once
command queue would be answered from a cache instead of stopping anything.
Announced through `status.features` as `"record"` — the inspector never calls a
route the daemon did not advertise, so an older daemon simply records nothing.

Its own ffmpeg process, never a sink on the live encoder: that one starts on
the first watcher, stops on the last, and restarts whole on a tier change,
each of which would truncate a file the run is still filling. On a per-run box
there is no watcher at all, so it is the only encoder running.

Fragmented MP4, H.264 baseline, `mpdecimate` with variable frame rate. A killed
box still leaves a playable file — the case where the evidence matters most.
An idle page emits nothing while timestamps stay on the wall clock, so the
player holds the last frame across a gap and the duration still matches the
run. `-fs` stops ffmpeg at the size cap and the take is reported `truncated`,
never dropped: what lands is a complete, playable _beginning_ of the run.

The inspector starts a take when the browser tools first ensure a hosted
session (so a run that never calls `browser_*` never records) and collects it
in the release path, before the box goes away. Collection is bounded at 45 s
and totally fail-soft — a daemon that has gone away, a read that hangs, an SDK
that throws all yield no video and release the box on exactly the same
schedule.

```dotenv
MCPJAM_BROWSERD_RECORD=0                 # daemon: `features` omits "record"
MCPJAM_BROWSERD_RECORD_DIR=…             # default ${userDataDir}/recordings
MCPJAM_BROWSERD_RECORD_MAX_BYTES=…       # default and ceiling 60 MiB
MCPJAM_HOSTED_BROWSER_RECORDING=0        # inspector: never start a take
MCPJAM_BROWSER_VIDEO=false               # live h264 stream only — recording is unaffected
```

The live-video switch and the recording switch are independent. Turning off
`MCPJAM_BROWSER_VIDEO` (to exercise the JPEG fallback, say) leaves every
unattended run recording; only `MCPJAM_BROWSERD_RECORD=0` or
`MCPJAM_HOSTED_BROWSER_RECORDING=0` stops that.

Only `MCPJAM_HOSTED_BROWSER_RECORDING` is read at call time — flip it and the
next run stops recording, no deploy. The three daemon-side ones are read ONCE,
by `readBrowserdConfig()` at boot, and `features` is computed from that
snapshot: changing them needs the daemon relaunched before they take effect.

Local engines do not record yet. They have no display and no encoder, so the
design there is a second `Page.startScreencast` on a **dedicated flattened CDP
session** — Chrome keeps one screencast per session, and the pane's handler
would otherwise ack a recorder's frames on the wrong session. Both engines need
one interface addition first: an uncached `DriverPage.cdpSession()` on the
Playwright page (its `cdp()` memoises a single session shared by the
screencast, a11y and WebMCP), and a `sessionId` threaded through
`electron/debugger-cdp.ts`.

## The desktop app shows the page, not a picture of it

In the packaged app the agent's browser is a `WebContentsView` running in this
very process. Encoding it to JPEG, base64-ing it into a socket, decoding it in
the renderer and painting it to a canvas is a round trip through three format
changes to show somebody a page their own machine already has — so the app does
not do that. The main process parents the active view into the app's own window
at the rail's bounds, and the person is looking at Chromium.

|                     | Native surface                                   | Frames                 |
| ------------------- | ------------------------------------------------ | ---------------------- |
| Who can have it     | the desktop app, Electron with `WebContentsView` | every engine           |
| What the pane draws | an empty measured slot                           | a `<canvas>`           |
| Input               | the OS, straight into the page                   | events over the socket |
| Frame socket        | never opened                                     | opened per session     |

**Three answers have to agree** before the pane branches, and each rules out a
different way it can be wrong:

- `GET /local-browser/status` → `runtime: "electron"` — this engine is the
  desktop app's own Chromium;
- the same response's `surface: "native"` — the server built the context with
  views (see the kill switch below);
- `electronAPI.agentBrowser.capability()` → `{ available: true }` — this app has
  the channel and this Electron has the constructor. A shipped app older than
  this wave reports `runtime: "electron"` exactly as a new one does and has no
  channel at all, so the server's answer alone is not enough.

Anything short of all three falls back to frames, which is the path that has
always worked.

**The lease still decides.** `setViewport({visible: true})` is a _request_: the
surface answers to the daemon's `HandoffLease` — the same authority that
refuses the model's commands — and a view held by somebody else is **hidden**,
not merely deafened. A visible native view of a page another person is typing
their password into is an observation, which is the one thing the lease exists
to prevent. A renderer-side gate would be a suggestion.

**A native view is a sibling of the renderer, not a node in it.** It paints
_over_ whatever the app draws in that rectangle and does not scroll, clip or
z-index with the page. So `ElectronNativeBody` measures its slot continuously
(`ResizeObserver`, window resize, capturing scroll) and takes the view back out
of the window the moment the pane stops being the visible tab, loses consent, or
unmounts — otherwise a live browser sits over somebody's logs.

```dotenv
MCPJAM_BROWSER_NATIVE_SURFACE=false
```

Restores the pre-wave shape exactly: one hidden `BrowserWindow` per tab, frames
over a socket. Read at call time, so a deployment flips it without a rebuild.

## The same pane for the hosted engine

The rail's Browser tab serves both engines from one component. The picture,
the pointer arithmetic, the keyboard and the take-control bar are
`BrowserPaneSurface`; `LocalBrowserBody` and `HostedBrowserBody` each own only
what their engine genuinely does differently.

The hosted path has one more hop than the local one, because the browser is in
somebody else's sandbox:

```
daemon GET /v1/frames  ──packed binary──▶  replica  ──JSON frame──▶  pane
pane   ──POST /api/web/computers/browser/input──▶  replica  ──▶  daemon POST /v1/input
```

Three things about it are load-bearing:

- **The holder is the verified user, on both routes.** The daemon admits a
  watcher, and input, when `holder === lease.holder`. A holder the client could
  name would let anyone who echoed the right id watch — or type into — somebody
  else's HELD session, which is a password field mid-login.
- **`yours` comes from the server.** The holder is a user id the pane never
  sees, so the panel routes answer whether the lease is the caller's. A pane
  that tracked "I acquired it" itself would forget across a reload and lock
  itself out of a PARKED lease it still holds, since only the holder may hand
  one back.
- **An open socket is not somebody watching.** The pane stays mounted behind
  the rail's other tabs, so it pings only while it is the visible tab in a
  visible document, and the frame socket defers the idle sweep only on a ping.
  Without that a pane behind the Logs tab holds a metered box awake.

`BrowserPanel` and its RFB stream are unchanged and remain the right thing for
"open the full desktop" — window manager, dialogs, popups. The rail pane is the
PAGE, at the daemon's own observation viewport.

## What is not here yet

- **Electron is unproven in a PACKAGED build.** It runs its own driver over a
  hidden `BrowserWindow` + `webContents.debugger` rather than launching
  Playwright, so it no longer needs a browser the app does not ship — but that
  path has only been exercised in development.
- **Save / use profile archives** are implemented for persistent browser panes
  and project settings. The archive path still needs staging validation with
  real Chromium logins and the hosted storage deployment before broad release.
- **One upstream stream per pane.** Two panes on one hosted session open two
  daemon streams. Fine at the daemon's cap of four, but `viewport.ts`'s
  byte-identical dedupe keys off a `lastData` shared across subscribers, so a
  congested watcher can miss a repaint the other received. Fanning out from one
  upstream fixes that and halves the box's egress.
- **No `browser_*` artifacts** are recorded for evals — no screenshots, no step
  replay. (The AGENT surface records its own: screenshots and trees land beside
  the session's ledger. A hosted unattended run also leaves a video; see
  _Recording an unattended run_ — per-step offsets into it still need the
  hosted tool path to emit `browserInteractionSteps` through the artifact
  outbox, which only the local widget harness does today. The eval trace
  is separate from both and still has none.)
- **The agent surface is local only.** `/v1/browser-sessions`, the SDK ops, the
  MCP worker tools and the CLI's cloud bindings are M2, and the backend tables
  (`browserLogicalSessions`, `browserCommands`) land before any of them.
- **One shared tab, and the lease is the only exclusive control.** Two agents
  on one session share the daemon's per-tab FIFO and are told apart only by the
  ledger's `actor`. A tab per participant, `holderKind: "agent"`, and revoking
  an agent's access from the rail are M1.5 — to be built when two drivers
  actually collide in dogfood, not before.
- **No network, HAR or diff.** Video has left this list — a hosted
  unattended run records one, per _Recording an unattended run_. The console
  ring is the only page telemetry, and it is ephemeral.
  `consoleSeqAfter`/`errorsSeqAfter` on a ledger row already bracket a
  command's console output; nothing reads them yet.
- **`evaluate` is not implemented.** It is in neither the contract nor the
  daemon; running page script stays local-only via the CDP escape hatch.
- The **quality governor and settle-still** from the WebMCP inspector are not
  in the shared viewport yet; local streams at a fixed rung, which is fine over
  loopback and is not fine over a hosted network.

## Running the tests

```bash
# The whole local engine, the daemon, and the routes.
npx vitest run --project server \
  server/services/browserd server/routes/mcp/__tests__/computers-local-browser

# The hosted routes, both hops.
npx vitest run --project server \
  server/routes/web/__tests__/computer-browser-frames.test.ts \
  server/routes/web/__tests__/computer-browser-panel.test.ts

# Both panes, the shared surface, and its coordinate mapping.
npx vitest run --project client \
  client/src/components/browser client/src/lib/browser-pane \
  client/src/lib/local-browser client/src/lib/hosted-browser

# Against a REAL Chromium (starts a browser; skipped otherwise).
RUN_BROWSERD_SPIKE=true npx vitest run --project server \
  server/services/browserd/local/__tests__/local-browser.spike
```

The spike accepts `MCPJAM_SPIKE_CHROMIUM_PATH` for images that ship a Chromium
at a path Playwright's resolver does not know. Production never sets it.

```bash
# The six Electron behaviours the native surface is built on, against a REAL
# Electron. Opens a window for a moment; prints one JSON verdict and exits
# non-zero if any check failed.
RUN_BROWSERD_SPIKE=true npx electron scripts/electron-surface-spike.mjs
```

The checks are (a) the constructors exist, (b) a view in a hidden holder still
loads and runs, (c) reparenting into a visible window keeps the page, (d)
`setBounds` is honoured, (e) a detached view keeps its page alive, and (f) a
`BaseWindow` is not counted by `BrowserWindow.getAllWindows()` — which is what
lets `window-all-closed` still fire with agent tabs open. Each is a claim about
Electron's own implementation, which is exactly the class of thing a fake in a
unit test cannot answer.

## Browser workspace integration

`browser-workspace-enabled` gates the shared browser shell, automatic takeover,
and responsive pane measurements, including Electron's native surface. With the
flag off, the pane keeps explicit Take control / Hand back controls and requests
a fixed 1024 × 768 viewport.

Sessions begin fixed. An enabled pane sends `policy: "followPane"` with its
measurement; persistent local sessions and hosted sessions with a TigerVNC
`VNC-0` output can opt in without a restart. Evals and older display images
remain fixed. Browser tool commands declare `responsiveViewport: true`; callers
without that capability receive `responsive_viewport_required` before acting on
a responsive session. Pane-first and agent-first launches use the same path.

Resize requests coalesce and wait for active commands and pointer drags to end.
Hosted resizing switches both the active output mode and framebuffer, verifies
the output geometry, and uses the same operation for rollback. A newer pane
measurement supersedes a pending fixed-mode reset.

The initiating streamed takeover gesture carries the daemon boot, active tab,
URL, navigation counter, and viewport revision. The input boundary rechecks them
after acquisition and before each event. If they changed, or an older daemon
cannot supply an anchor, control is acquired but the gesture is discarded and
the pane asks the user to try again.

Profile export reserves an exclusive lease, closes Chromium to flush its
persistent storage, and holds the reservation until archiving finishes. Local
export also holds the session's creation lock, so reopening cannot race the
archive. Export closes the live browser; the next ensure call relaunches it.
