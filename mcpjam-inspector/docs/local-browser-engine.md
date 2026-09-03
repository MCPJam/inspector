# The agent browser on this machine

Engineering notes for the local browser engine: what it is, what it is *not*,
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
                 │ exactly like bash    call (local)
          hostConfig.builtInToolIds
```

### Pieces

| Concern | Where |
| --- | --- |
| Session lifecycle, profiles, idle reap | `server/services/browserd/local/local-browser-session.ts` |
| The daemon without a socket | `server/services/browserd/in-process-client.ts` |
| One decoder for both transports | `server/services/browserd/browserd-codec.ts` |
| Screencast + input over CDP | `server/services/browserd/daemon/viewport.ts` |
| Engine resolution | `server/utils/built-in-tools/registry.ts` (browser branch) |
| Routes | `server/routes/mcp/computers.ts` (`/local-browser/*`) |
| Frame socket | `server/routes/web/local-browser-frames.ts` |
| Rail pane | `client/src/components/browser/LocalBrowserBody.tsx` |

## Trust model

Read this before changing anything here. It extends the shell's, and differs
from it in one direction that matters: a browser holds **logins**.

- **This is not a sandbox.** Chromium runs as the OS user, in a profile that
  persists their sessions. The boundaries are device *consent*, *per-action
  chat approval*, and the *actor gates* — never the profile path.
- **The profile is per project** because a login for one project should not
  silently be a login for another. That is a product decision, not
  confinement. What *is* validated is the project key, because it becomes a
  path segment under a fixed root.
- **Per-action approval is forced on**, exactly as it is for local `bash`. The
  blast radius of an unreviewed click here is the user's accounts, not a
  disposable box.
- **Project secrets never reach this Chromium.** The env allowlist in
  `local-machine.ts` is the precedent and this path does not widen it.
- **The lease is the privacy boundary**, and it is enforced at the daemon: a
  person holding the browser blocks every model-driven command *and every
  observation*, including one already queued or mid-flight.

## Profiles

| Surface | Mode | Why |
| --- | --- | --- |
| Playground chat | persistent, `~/.mcpjam/computer/browser/<project>/profile` | A login must survive the turn that made it. |
| Evals, swarms, journeys | ephemeral, no profile at all | One run must never inherit another's cookies — that is a verdict decided by the previous run. |

Derived from the approval delivery, never configured: a surface that can ask a
person is interactive and keeps its logins; one that cannot starts blank.

## The browser is a full Chromium, headless

`headless: true` alone resolves to `chromium-headless-shell` — the *old*
headless, a different binary with a different compositor path and a
fingerprint public sites recognise and block. The local engine passes
`channel: "chromium"`, so "no window" means the same build a headed launch
would use, merely not shown, with the anti-fingerprint switches from
`daemon/launch-args.ts` (`--disable-blink-features=AutomationControlled`, a
pinned real UA, the hover/pointer media pins).

`MCPJAM_BROWSER_HEADED=1` opens a real window where a display exists. The pane
streams either way.

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
- **A held or parked lease defers the reap.** Taking control *is* using it;
  reaping there closes the window someone is typing a password into.
- Closed by `shutdownLocalBrowserSessions` (latching) on a terminating process
  and `killLocalBrowserSessions` (non-latching) on Electron's
  `window-all-closed`, which on macOS is followed by a server restart.
  Closing the context is also what releases the profile lock, so a skipped
  teardown is a browser the next run cannot start.

## Chromium is installed at consent time

Never inside a chat turn: the download is hundreds of megabytes and a model
sitting in a tool call for minutes has no way to say why.
`POST /api/mcp/computers/local-browser/install` runs it with progress, behind
consent; `ensureLocalBrowserSession` refuses with `chromium_not_installed` and
points at it.

## Routes and their gates

| Entry point | Gates |
| --- | --- |
| Chat `browser_*` (playground) | non-hosted + kill switch + signed-in non-guest + server-verified consent + per-action approval |
| Chat `browser_*` (guest / scenario / journey) | **never local** — coerced to the cloud family at the registry chokepoint |
| `GET /local-browser/status` | session + verified sign-in + non-guest + kill switch. No consent: the consent screen needs it to describe itself. |
| `POST /local-browser/install` | the above **+ consent** |
| `POST /local-browser/{ensure,token,lease,input}` | the above **+ consent** |
| `GET /api/web/computers/local-browser/frames` | allowed `Origin` (**absent Origin rejected**) + single-use, 60 s, kind-bound nonce + the nonce's consent fingerprint must still match + **the daemon's lease** |
| Hosted build | `/api/mcp` unmounted, kill switch forced off, WS route not mounted |

Nonces are typed by what they open, so a terminal nonce cannot start a frame
stream and a frames nonce cannot open a shell.

## Kill switch

```dotenv
MCPJAM_LOCAL_BROWSER_ENABLED=false
```

Turns the engine off on a server: the routes 404, `engines.local.browserAvailable`
reports false, and `ensureLocalBrowserSession` refuses. Forced off in hosted
mode regardless. Separate from `MCPJAM_LOCAL_COMPUTER_ENABLED` on purpose —
driving a browser and running shell commands are different amounts of trust.

The same caveat governs rollback as for the shell: this is a *server* env var,
and users on published npm or Electron builds are on their own machines. UI
exposure needs its own client-evaluated flag before wide release.

## What is not here yet

- **The hosted engine still uses noVNC** for its viewport; the frame socket
  above is local-only. Unifying them is the next step, along with removing the
  stream password from the panel's JSON.
- **Electron** runs the local engine's code path but still launches Playwright,
  which the packaged app does not ship. A `DriverPage` over a hidden
  `BrowserWindow` + `webContents.debugger` is the fix.
- **Unattended runs** cannot reach a hosted browser at all: no ephemeral box
  carries a desktop runtime kind. Locally they get an ephemeral profile, but
  the registry coerces those actors to the cloud family, so in practice
  unattended browsing waits on the backend work.
- **No `browser_*` artifacts** are recorded for evals — no screenshots, no step
  replay.
- The **quality governor and settle-still** from the WebMCP inspector are not
  in the shared viewport yet; local streams at a fixed rung, which is fine over
  loopback and is not fine over a hosted network.

## Running the tests

```bash
# The whole local engine, the daemon, and the routes.
npx vitest run --project server \
  server/services/browserd server/routes/mcp/__tests__/computers-local-browser

# The pane and its coordinate mapping.
npx vitest run --project client \
  client/src/components/browser client/src/lib/local-browser

# Against a REAL Chromium (starts a browser; skipped otherwise).
RUN_BROWSERD_SPIKE=true npx vitest run --project server \
  server/services/browserd/local/__tests__/local-browser.spike
```

The spike accepts `MCPJAM_SPIKE_CHROMIUM_PATH` for images that ship a Chromium
at a path Playwright's resolver does not know. Production never sets it.
