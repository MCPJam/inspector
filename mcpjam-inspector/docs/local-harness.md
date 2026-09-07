# Local harness ("Native on this machine")

Running the real Claude Code agent as a supervised process on the user's own
machine, instead of inside an E2B computer.

Modelled on `local-computer-engine.md`, which documents the *other* local
capability — that one lets the user's machine run bash commands the model asks
for; this one lets it run a whole vendor agent with its own tool loop. They are
separate flags, separate kill switches, and separate consent, because they are
separate decisions with different blast radii.

For the mechanics of the supervisor, the command grammar, confinement and the
runtime identity, read `server/utils/harness/local/README.md`. This file is the
operational picture: what the pieces are, who can reach them, how to turn it
off, and what to check before and after launch.

## What it is

The desktop app and `npx @mcpjam/inspector` are not computers data planes, so
before this they could not run Claude Code at all — the Claude Code host
required a cloud computer and said so. A user with the flag on now picks
**Native on this machine** and the same host runs locally, with MCPJam-brokered
and metered model access and no E2B round trip.

What actually runs is the vendor's own binary, launched by a bridge, launched by
a supervised Node process this Inspector owns:

```
Inspector server
 └─ supervisor  (process registry, janitor, whole-tree cleanup)
     └─ bin/node  (from the verified pack)
         └─ launcher.mjs  (forces the listener onto loopback)
             └─ bridge.mjs  (the adapter's, byte-identical)
                 └─ claude  (Anthropic's binary, from the pack)
```

alongside two things that are not processes and have to die with it:

- the **loopback model gateway**, which holds the lease and hands the child a
  per-session capability instead;
- the **lease** itself, revoked server-side.

## Pieces

| Piece | Where | What it is |
|---|---|---|
| Runtime pack | `~/.mcpjam/harness-local/runtime/<version>/claude-code`, or `userData/local-harness/runtime/...` on Electron | ~515 MB: the adapter's frozen dependency graph, the vendor binary, an official Node, and the loopback launcher. One per `<os>-<arch>` — it contains machine code — downloaded once, signature- and digest-verified. |
| `runtime-install.ts` | server | Downloads, verifies (signature → archive hash → tree digest), extracts atomically, activates. Never runs during a session start. |
| `availability.ts` | server | The single chokepoint. Kill switch, hosted mode, actor, compatibility, workspace grant, runtime identity, consent — in that order, each re-derived. |
| `supervisor.ts` | server | Owns the process tree: durable registry, ownership proof, whole-tree termination, janitor reclaim. |
| `model-gateway.ts` | server | Loopback listener the child's `ANTHROPIC_BASE_URL` points at. Holds the lease; the child gets a capability. |
| `instance-key.ts` | server | Per-machine Ed25519 key. OS keychain on Electron, owner-only file on npx. Signs every proxied request. |
| `grants.ts` | server | Workspace grants and consent capabilities, hash-only, owner-only. |
| Backend lease | Convex | `delivery: 'inspector-loopback-gateway'` — the one delivery whose lease is returned to a caller, and the reason proof-of-possession exists. |

## Trust model

**This is not a sandbox, and the product says so in those words.**
`targetHasHostContainment()` answers `false` for `local-native` — always, no
matter how narrow the permission profile, how confined the Inspector file API,
or how tidy the synthetic home. Those reduce accidents. None of them contains a
process running as the OS user, and a consent sheet that implied otherwise would
be the most damaging thing in this whole design.

What the design *does* guarantee:

- **Nothing runs without an explicit, bound consent.** The capability binds to
  the user, the machine, the project, the workspace grant, the runtime digest,
  the permission profile and the policy version. Changing any of them
  invalidates it.
- **What runs is what consent named.** The pack's tree digest is verified before
  every spawn; a changed tree refuses rather than launching.
- **Stopping a session stops everything it started.** Whole-tree termination
  with per-process ownership proof, and a snapshot taken at the root's exit so
  an aborted turn cannot strand the vendor CLI.
- **The bridge is not reachable off this machine.** A launcher forces the
  listener onto loopback, a connect probe tries every non-loopback local address
  and refuses the session if any answers, and the binding is read back out of
  the kernel.
- **The child never holds a spendable credential.** It gets a per-session
  capability that means nothing off one loopback listener. The lease stays in
  the server process, and every request it forwards carries a signature from the
  machine's registered key — so a leaked lease is not enough, and a captured
  signature is bound to one method, path, timestamp and nonce.
- **The gateway forwards to one place, and only downwards.** A path that passes
  the allowlist is checked AGAIN after the upstream URL is resolved: the
  allowlist compares strings and `new URL` normalizes, so `/v1/messages/../../…`
  would otherwise pass as text and land in the backend's own route namespace
  with the real lease attached. The resolved URL must still sit under the
  proxy's own path or the request is a 404. Redirects are refused rather than
  followed (the fetch spec strips `Authorization` across origins and strips
  neither of our two lease headers), and the upstream must be https unless it is
  on loopback, because the lease travels as a bearer token on every request.
  A self-hosted backend reached over plain http on a LAN address is refused by
  that last rule — deliberately; put it behind TLS or on loopback.
- **An abandoned turn stops costing money.** The gateway streams the upstream
  response with backpressure and cancels the upstream read when the client goes
  away, so a cancelled generation stops being metered instead of running to
  completion into a socket nobody is holding.
- **No renderer names a path.** The Electron picker runs in the main process; the
  npx route accepts a path only same-origin, and canonicalizes it.

What it does **not** guarantee: that the agent stays inside the workspace. It
runs as the user. The workspace is where it starts.

## Actor and route enumeration

| Actor | Can select the target | Can consent | Can run |
|---|---|---|---|
| Signed-in member, own turn, local Inspector | yes (flag on) | yes | yes |
| Guest | no | no | no — refused at the route, the parser, and the availability gate |
| Shared scenario / journey session | no | no | no |
| Swarm-scoped run | no | no | no |
| Any actor on a hosted replica | no | no | no — `HOSTED_MODE` forces the kill switch off |

Routes, all under `/api/mcp/local-harness/*`, all behind the inspector session
token + `bearerAuthMiddleware` + `requireVerifiedAuth()` + an explicit guest
refusal + the kill switch (which answers **404**, not 403 — an operator who
turned it off should not have the surface advertise itself):

| Route | Does | Answers |
|---|---|---|
| `GET availability` | Status, runtime identity, key fingerprint, whether a cloud target exists at all (`hostedAvailable`), the pack this build expects (`expectedPack`), and the folder the user launched from (`suggestedWorkspace`). Ids and display strings only. | 200 |
| `GET runtime/status` | Reads. Cheap enough to poll during an install; `?verify=1` asks the expensive question (is the installed tree still the one that was verified?) and is not what the polling client uses. | 200 |
| `POST runtime/install` | Starts or JOINS an install. Body may carry `{ expectedPack }` — what the user approved. | **202** with `Location: …/runtime/status` and `Retry-After` for work in flight; **200** when a verified runtime is already installed and nothing was downloaded; **409** `expected-pack-changed`; **400** when this machine has no pack |
| `POST workspace-grant` | Registers a directory, from `{ path }` or `{ useSuggested: true }`. Same-origin re-checked in the handler; both re-validated server-side; naming both is a 400. | 200 / 400 |
| `POST consent/grant` | Mints the capability; registers the instance key first. Body may carry `{ expect }` — the machine, pack version and digest, permission profile and policy the user was SHOWN. | 200; **409** `consent-context-changed` with `changed` and the `current` terms; 401/403/503 for the actor |
| `POST consent/revoke` | Forget & re-authorize, or revoke one `grantId`. | 200 |
| `POST stop-all` | The local brake: ends every session this server owns. | 200 |

`/api/mcp/local-harness` is in `HOSTED_AUTH_PATH_PREFIXES`. Without that entry
every signed-in user gets a 401 on all of them — the bug PR #4515 shipped once.

### Why install acknowledges instead of finishing

A pack is a ~200 MB download and several minutes of verification. A request
held open for that is a request a proxy timeout, a sleeping laptop or a reload
ends — and the client then cannot tell "still downloading" from "the request
was lost". So the route answers **202** and the client polls, which is the
ordinary asynchronous request-reply shape. The client AWAITS the
acknowledgement: a POST whose response nobody reads is a POST whose refusal
nobody sees, and two of the refusals here are ones a user must not miss (a
session that cannot authorize this, and an approved pack that is no longer the
pack this build expects).

Polling never starts work. Neither does opening the dialog, remounting a
component, or booting the server. A download happens on **Install & allow** and
nowhere else.

### The approved-expectations contract

Consent binds to a runtime identity, a machine, a permission profile and a
policy version. The dialog shows all four and the user clicks against THAT —
but the grant is minted later: after a download on a cold install, after a
round trip on a warm one. Any of them can have changed in between.

So the client sends back what it was shown, in `expect`, and the server
compares it against the values it re-derives. `expect` is a QUESTION ("is this
still true?"), never an authority — every bound value comes from the server's
own resolution. A mismatch is a typed **409** `consent-context-changed`
carrying `changed` and the `current` terms, and nothing is minted: binding a
click to terms the user never saw is exactly the substitution the binding
exists to prevent. An omitted `expect` is not a mismatch — a caller that never
captured one is asking for the terms rather than confirming them.

`POST /runtime/install` runs the same comparison for the pack alone, before a
byte moves, so a server that updated between the dialog opening and the click
does not fetch a different runtime under the same approval.

### The launch-directory handoff

`suggestedWorkspace` is the folder the user ran `npx @mcpjam/inspector` in. The
server cannot work that out for itself: `bin/start.js` spawns it with
`cwd: projectRoot`, the installed package's own directory, so `process.cwd()`
on the server side is `.../node_modules/@mcpjam/inspector`. Offering that as
"the folder Claude Code will work in" would be worse than offering nothing — a
real directory, plausible in a dialog, and never what the user meant.

So `bin/launch-workspace.mjs` reads the invocation folder while the launcher
still has it and passes it explicitly as `MCPJAM_LAUNCH_WORKSPACE`. The server
reads only that variable. A deployment that does not deliberately pass it gets
`null` and the dialog asks — which covers the dev server, a programmatic embed,
and anything else nobody thought about. Electron is explicitly `null`: it has a
native picker running in its main process, and an ambient suggestion beside it
would be a second, worse answer to a question already being asked properly.

The client never sees the absolute path, so `{ useSuggested: true }` is how it
asks for that folder — and the server re-resolves and re-validates it rather
than trusting a display string it handed out a moment earlier.

## The one dialog

A dev previews a Claude Code host, types a prompt, and presses Send. One dialog:

```
Run Claude Code in ~/code/your-project?

Claude Code will run on this computer as your user account. The folder is
where it starts, not a sandbox — anything you can read or change, it can.
Edits inside the folder run freely; commands ask for approval in chat.

Folder   ~/code/your-project                [Change]
▸ Details    runtime 3.4.0 · sha256:ab12…   · edits in folder, commands ask
             · policy 2026-09-01 · expires in 12 h
                              [Cancel]  [Install & allow]
```

What each state does:

| State | Button | What the click does |
|---|---|---|
| Runtime absent | **Install & allow** | Records the approval, starts setup, closes. The composer shows progress. The draft stays; **press Send again** when it is ready. |
| Runtime verified | **Allow** | Records the approval, awaits the grant, and continues the ORIGINAL send once — after re-checking that the context still matches. |
| Cancel | — | Starts nothing, mints nothing, keeps the draft. Send is still the way back in. |

**Approve a named runtime, then fetch it.** The order is the whole design.
Downloading first and asking afterwards makes the download unaskable-for;
asking first and fetching something else makes the approval meaningless.

**No queued send after a cold install.** A prompt that fires itself minutes
later, after a download, is not what anybody pressed. This is a deliberate
product choice, not a missing feature.

**Cancelling authorization during setup** invalidates the pending approval. The
already-authorized download may finish into the cache — including for another
Inspector waiting on it — but it can no longer mint consent or run a turn for
the cancelled flow. Cancelling the transfer itself is not in this pass.

**Send is disabled** while setup or authorization is running, and for a machine
that cannot run this at all — each with the reason on screen. It is deliberately
NOT disabled for missing consent or a missing folder: both Enter and the button
are refused by `submitDisabled` before `onSubmit` runs, so disabling for those
would make first-send setup unreachable.

## What can go wrong, and what it says

| State | Copy | Recovery |
|---|---|---|
| `failed` / `verification` | "The downloaded runtime didn't match what MCPJam expected, so it wasn't installed." | Explicit Retry |
| `failed` / `network` | "Couldn't download the runtime." | Explicit Retry |
| `failed` / `disk` | Describes space/permission failure in the configured runtime location | Free space, or fix permissions on `MCPJAM_RUNTIME_ROOT` |
| `interrupted` | "Setup was interrupted. Retry to continue." | Explicit Retry |
| `corrupt` | An installed pack that stops verifying | Reinstall the same version — a repair, not a re-download of something that never landed |
| 409 `consent-context-changed` | "What you approved is not what this machine would run now" | The dialog re-asks with the current terms |
| 503 `auth-unconfigured` | This deployment has no AuthKit, so there is no member identity to bind a filesystem grant to | Configure AuthKit, or run hosted |

Retry is always **explicit**. Nothing re-downloads on a poll, a boot, or a
component remount, and there is no unattended retry loop and no resumable
download. A retry may reuse a still-matching in-memory approval; a reload or a
changed context needs a fresh one, which is why Retry opens the dialog rather
than silently re-POSTing.

`failed` and `interrupted` are RETAINED until the next explicit attempt. A
failed download that decayed back to `absent` on the next poll is the reading
that loses the only thing the user needed to see.

## Two Inspectors, one runtime root

Three things write to the same runtime root — an Inspector window, another
Inspector window, and `mcpjam-inspector harness install` — and
`runtime-lifecycle.ts` is the one coordination domain they share. Filesystem
locking and owner-recorded state; deliberately no daemon, no queue service, no
job framework.

- An install **attempt** is claimed per `(runtime root, harness, OS/arch
  target, pack identity)`. Not version alone: two builds expecting different
  packs are two operations, and letting the newer one "join" the older one's
  install would verify bytes against a digest it was never meant to satisfy.
  A second caller JOINS and observes rather than starting a second extraction.
- A runtime **use** is reserved before verification and held through
  process-tree teardown. The window that matters is not "while a turn streams"
  but "from before the digest is read until after the last child is dead".
  Activation and repair refuse to replace a directory that has one, and
  re-check ownership immediately before the rename — a download takes minutes,
  and a reservation taken at the start of one says nothing about the end.
- **Only ESRCH proves an owner gone.** A holder that cannot be proven gone is a
  busy state, never permission to reclaim its files. The old staging sweep
  matched on the `.mcpjam-tmp-` prefix, which cannot distinguish another
  Inspector's live extraction from a dead one's leftovers.
- A killed installer leaves an `interrupted` record the next reader reconciles,
  so the UI has something to offer Retry from rather than a `downloading` that
  never moves.
- Activation moves the previous version ASIDE rather than deleting it, so a
  crash between the two renames leaves something to put back. The next status
  read recovers it instead of re-downloading 500 MB to reach the same bytes.

### Old versions are kept, on purpose

`sweepOtherVersions` is gone. It deleted every other version after activating,
which is how a running session in another process lost the tree it had already
verified and was executing from. Verified versions now sit side by side.

**The tradeoff is disk**: each pack is ~515 MB, and nothing reclaims an old one
today. Reclaiming safely needs an ownership answer that spans more than one
install and more than one process, and that is deliberately not in this pass.
An operator who needs the space can delete an unused version directory under
`MCPJAM_RUNTIME_ROOT` while no session is running.

## Kill switch

`MCPJAM_LOCAL_HARNESS_ENABLED` (server, default **off**, forced off when
`HOSTED_MODE`). It gates:

- every route above (404);
- the turn path's target parse (an explicit ask is **refused**, not degraded);
- `resolveLocalHarnessAvailability`, which is what the turn actually asks.

The PostHog flag `local-harness-enabled` gates every UI surface, fail-closed
(`=== true`), so a user who is not flagged in sees exactly what they saw before
this shipped. Both have to be on. Neither is sufficient alone: the flag with no
kill switch shows a selector whose turns 400, and the kill switch with no flag
is a capability nothing offers.

Three more things must line up before a turn runs: an installed and
digest-verified pack, a workspace grant, and an unexpired consent capability.

## The other environment knobs

None of these turn the feature on; the kill switch above is the only one that
does. They are here so an operator reading a machine's environment knows what
each one changes.

| Variable | Default | What it does |
|---|---|---|
| `MCPJAM_RUNTIME_ROOT` | app data | Where packs install. Set by Electron's main process; on npx it falls back to `~/.mcpjam/harness-local/runtime`. |
| `MCPJAM_LOCAL_HARNESS_PACK_SOURCE` | unset | Install from a local archive instead of the release asset. Development only — a pack from here has no signed manifest, and the installer says so. |
| `MCPJAM_LOCAL_HARNESS_EXPECTED_PACK` | unset | `<version>:sha256:<hex>`, the digest to accept. **Only honoured when `PACK_SOURCE` is also set**, so it cannot widen what a shipped Inspector will install. Exists because the pack build has to verify the pack it just produced, which by definition is not in the generated table yet. |
| `MCPJAM_LOCAL_HARNESS_STRICT_REVERIFY` | `false` | Re-hash `bin/node` and the vendor binary on **every** pre-spawn re-verify, rather than relying on their stat fields. See below. |

### What the pre-spawn re-verify costs

The full tree digest runs once per process per pack and is the authority. Every
spawn after that compares the stat snapshot it left behind, and re-hashes the
files that execute. Measured against a real 494 MB pack:

| | |
|---|---|
| stat walk, 5,462 files | 350 ms |
| `launcher.mjs` + `bridge.mjs` | 2 ms |
| `bin/node` | 334 ms |
| the vendor `claude` binary | 1,263 ms |
| **all of it** | **1,949 ms**, against a 1.5 s session-start SLO |

End to end against that pack, the split costs **415 ms** by default and
**2,144 ms** with `STRICT_REVERIFY=true`. (The first resolve, which takes the
full digest, is ~3.3 s and happens once per process; every resolve after it is
a cache hit at 0–1 ms.)

So the two small scripts are re-hashed every time — they are what forces the
bridge's listener onto loopback, and they cost nothing — and the two large
binaries are left to the stat compare unless `STRICT_REVERIFY` is on.

The stat compare is not the weak half. It covers path, size, mode, inode and
**`ctime`**, and `ctime` is the field a tamper cannot put back: the kernel
stamps it on every write and no syscall sets it, so an in-place rewrite that
restores size, mtime and mode still gives itself away — for all 5,462 files,
without reading one. Re-hashing on top of that defends the narrower case where
the stat fields themselves cannot be trusted: a doctored filesystem image, a
restore that rebuilt the metadata, root on the same machine. Turn the knob on
where that matters more than 1.6 s per session start.

## Brakes, from fastest to slowest

1. **`POST stop-all`** — ends every live session in this process now: gateway
   revoked, lease revoked, tree stopped.
2. **Consent revoke** — no new session starts. In-flight ones keep running until
   stopped; consent is a start gate, not a stop gate.
3. **Backend lease revoke** — the remote brake. Kills model access for a run
   from the control plane, without touching the user's machine.
4. **Instance-key rotation** — kills every lease naming the old key. What
   "Forget & re-authorize" does.
5. **Kill switch** — no new turn, on this server, at all.
6. **PostHog flag off** — the UI disappears for the cohort.

## Remote MCP servers still work

Local execution is about where the AGENT runs, not where its MCP servers live.
A remote server — Excalidraw, a hosted HTTP server, anything the Inspector can
already reach — participates through the Inspector's own MCP proxy
(`harnessMcpProxy: { plane: "local-mcp" }`): the supervised child talks to a
loopback endpoint this server owns, and the Inspector makes the outbound call
with the credentials it already holds.

What that does NOT mean is that every server and every configuration works. The
existing gates still decide: the host/model eligibility preflight
(`checkHarnessRuntimeAvailable`), the tool-approval rules, and the
enterprise-managed authorization refusal — a harness turn on an
enterprise-policy host is refused outright, because the proxy token carries no
host and cannot enforce that policy. A remote-server smoke test is on the
dogfood list for exactly this reason: the mechanism is sound, and the
per-configuration answer is still the gates'.

## Analytics

Registered in `shared/analytics-events.ts` (a ratchet test forbids raw
`posthog.capture`). Enums, booleans and counts **only** — never a workspace path
even tilde-shortened, a machine id, a runtime digest, a lease, or a key.

| Event | Props |
|---|---|
| `local_harness_target_selected` | `target` |
| `local_harness_consent_gate_shown` | `trigger` — `first_send` \| `chip` |
| `local_harness_consent_granted` | `trigger`, `cold` |
| `local_harness_consent_denied` | `trigger` |
| `local_harness_consent_reauthorized` | `location` |
| `local_harness_runtime_install_started` | `trigger` — emitted on **Install & allow**, never when the dialog opens |
| `local_harness_runtime_install_completed` | `location` |
| `local_harness_runtime_install_failed` | `reason` — the classified enum, never the installer message, which can carry a path |
| `local_harness_unavailable` | `reason` |

`trigger` distinguishes the two ways into the dialog, which answer different
questions: `first_send` is a user who typed something and hit a gate,
`chip` is a user who went looking. `runtime_install_started` fires on the
button and not on the dialog opening, because opening it downloads nothing —
counting opens as starts would report a funnel that does not exist.

Server-side, the turn logs `[harness][timing][local]` with
`runtimeVerify`, `gatewayReady` and the resolved permission mode. Deliberately a
separate line from the cloud timing one, with different field names: a local
turn reporting `boxWake` would be a metric that reads as a box wake and is not
one.

**SLOs** (from the spike's measurements, which were taken under load average
~20 and should be read as upper bounds): session start ≤ 1.5 s p95; warm resume
overhead ≤ 300 ms p95.

## Flag targeting

`local-harness-enabled` — boolean, client evaluation, tag `computers`.

At ship, one release condition: person property `email` ends with
`@mcpjam.com` AND `email` is not `pentest@mcpjam.com`, 100 %. Nobody else.
Mirrors `local-computer-enabled` (id 810300).

Widening order: employees → `deployment = self_hosted` → general availability.
Verify with `feature-flags-test-evaluation-create` against a real distinct id
before each widening; a flag that evaluates `undefined` is off, which is the
correct failure but an invisible one.

## What Windows needed

Windows is a native platform. It was refused until 2026-09-04, and the
reasons it was refused were real; each has a specific answer, and the
`windows-latest` conformance leg — gating, like the POSIX legs — is what
proves the answers hold against the real pack, the real bridge and the real
vendor CLI.

**The path problem was ours, not upstream's.** `@ai-sdk/harness` composes
every path with POSIX string operations on every platform, and an earlier
version of this section read that as a blocker to be fixed in Vercel's code.
It is not: the provider supplies `defaultWorkingDirectory` itself, and the
framework never hands that value to a native OS call — it only resolves and
concatenates onto it. So the provider presents the session's roots to the
adapter in the MSYS spelling (`/c/Users/…`, `adapter-path.ts`), every path the
framework derives stays forward-slashed, the translator's metacharacter check
is untouched, and `confine` — the one place every operand already crosses into
a real OS call, the bridge's own argv included — maps back to native. The
child's environment (`HOME`, `PWD`, cwd) stays native; the OS reads that, not
the adapter.

**Whole-tree cleanup is a Job Object.** There is no process group. The
supervisor spawns the pack's `mcpjam-job-launcher.exe` — digest-verified, so
`supportsOwnershipProof('win32')` answers false on a pack without it — in
front of the bridge; the launcher creates a job with `KILL_ON_JOB_CLOSE`,
starts the bridge suspended, assigns it, and only then resumes it. The
launcher's exit, by any route, closes the last job handle and the kernel
terminates every member. That makes the root's liveness the group's liveness,
which is what `probeProcessGroup` reads on win32, and it is why the
supervisor's stdin to the launcher is a LIFELINE: a pipe held open and never
written, whose EOF means the Inspector is gone. The launcher gives the bridge
`NUL` instead — two readers on one silent pipe hung the bridge before it
could listen. It also passes its environment through explicitly, because the
low-level `syscall.StartProcess` treats a nil environment as empty, and a
Node binary with no `SYSTEMROOT` dies inside OpenSSL before it runs a line
of JavaScript.

**Birth identity is a FILETIME.** No `/proc`, no `ps`; `kill(pid, 0)`
answers liveness without a subprocess (libuv reports an exited process as
gone even while a handle is held), and only a live pid pays for PowerShell's
`Get-Process`, whose `StartTime` is the kernel's creation time at 100 ns —
a stronger discriminator than darwin's second-granular `lstart`. PowerShell
is started with the parent's environment and stdin closed; a stripped
environment stalls it past the probe's timeout.

**The vendor CLI's shell is named, not searched for.** Claude Code on
Windows runs its Bash tool through Git for Windows, found on PATH — which the
child does not have, by design — or in `CLAUDE_CODE_GIT_BASH_PATH`. The
provider resolves a real `bash.exe` (the parent's own setting, else the
default install) and names it in the child's environment only if it exists;
the name is denylisted for scoped values.

**Known gaps, none of them a cleanup or exposure hole:**

- The OS-level loopback corroboration (`lsof`) and the model gateway's
  peer-pid check return null on win32 and are skipped. The enforcing TCP
  connect probe runs everywhere.
- The conformance runner's env-leak check reads `ps -E`; it passes vacuously
  on win32.
- The child's PATH is System32 only. `pwd` and the built-ins work; a Bash
  tool call that needs `git` or a language runtime will not find one until
  PATH policy is decided for Windows.
- The first identity probe pays PowerShell's cold start (seconds on CI).
- The Job Object launcher is built by the runner image's Go toolchain; a
  toolchain bump changes the binary and therefore the pack digest.

## Launch / rollback checklist

**Before enabling for anyone**

- [ ] Backend PR deployed to **prod** (not just dev). Merged ≠ deployed: prod
      deploys on the inspector release promote, and a local turn cannot obtain a
      lease before it lands.
- [ ] The pack signing key generated, its public half committed in
      `pack-signing-key.ts`, its private half in the CI secret
      `LOCAL_HARNESS_PACK_SIGNING_KEY`. Until then `PACK_SIGNING_KEYS` is empty,
      which **refuses** every network-sourced pack — the correct default, and a
      hard blocker for release.
- [ ] Packs built and attached to the release for every **target** the manifest
      calls native — `<os>-<arch>`, so both Mac architectures, not "darwin" —
      and `pack-digests.generated.ts` regenerated from that build and
      **committed**:

      ```
      # 1. build the packs (workflow_dispatch on "Local harness runtime pack")
      # 2. take the FLAT map the collect job prints — `{target: digest}`, the
      #    step's `flat` output, not the nested `digests` one — and pass EVERY
      #    target it built. A missing target is a platform the release then
      #    cannot serve, and the release gate fails on the difference.
      node scripts/write-pack-digests.mjs --version <release> \
        --digests '{"darwin-arm64":"sha256:…","darwin-x64":"sha256:…","linux-x64":"sha256:…","linux-arm64":"sha256:…","win32-x64":"sha256:…"}'
      # 3. commit it, then release
      ```

      The release re-runs the same build and fails if the packs it produces do
      not match what is committed. The table is committed rather than injected
      at build time so the digest a release trusts is reviewed in a diff —
      which is the property the whole verification chain rests on.

      Committing that table is also what **turns the pack build on**:
      `release.yml` reads `EXPECTED_PACK_VERSION` out of it and skips
      `build-local-harness-pack` entirely while it is `""`. That is not a
      convenience — a build carrying no digests refuses every network-sourced
      pack anyway, so publishing packs alongside it would attach assets nothing
      can ask for, and the enforcement step above would fail by construction.
      There is deliberately no separate switch: a release cannot ship digests
      without building the packs they name, and cannot build packs the shipped
      build would not accept.
- [ ] Conformance green on **every advertised platform** — `ubuntu-latest`,
      `macos-latest`, and `windows-latest` if Windows is offered — and
      `lifecycleConformanceVersion` stamped from that run. Empty ⇒ every
      platform refuses, by design. A green run on one platform is not evidence
      for the others, and a target that has not passed stays unavailable rather
      than being advertised on somebody else's evidence. Do not fill in Codex
      evidence as a side effect of a Claude Code rollout — it is a different
      harness with a different adapter.
- [ ] `node scripts/check-local-harness-release.mjs --version <release>` passes.
      It runs in `release.yml` twice: on the plan, and again over the assets the
      release just published (signature against the key the shipped Inspector
      carries, tree digest against the committed table, archive against its own
      signed manifest). The pack workflow's own verification installs from a
      LOCAL FILE through `MCPJAM_LOCAL_HARNESS_PACK_SOURCE` — a development
      override no shipped Inspector takes — so only the published-asset pass
      exercises the path a user is actually on.

      The gate distinguishes an **inconsistent** release from an **unshipped**
      one. A build with no conformance evidence offers local execution
      nowhere, so it is dark rather than broken and does not fail the release.
      What fails is a build whose derived OFFER names a platform it has no pack
      for, or a digest table stamped at a version whose assets this release will
      not publish. `--require-ready` turns "not shipped yet" into a failure, for
      the release that intends to ship the feature.
- [ ] PostHog flag created, employees-only, verified by evaluation.
- [ ] `MCPJAM_LOCAL_HARNESS_ENABLED` left **off** in every deployed
      environment. It is a local-Inspector capability; a deployed server has no
      business running an agent on its own host.

**Dogfood**

- [ ] Install the pack from a real release asset (not `MCPJAM_LOCAL_HARNESS_PACK_SOURCE`).
- [ ] Launch the built `npx` entry from a temporary project OUTSIDE the
      Inspector checkout. The suggested folder is that project — never the
      package or npx-cache directory. Electron uses its picker; an invalid
      launch context (home, root, a deleted cwd) offers nothing.
- [ ] The chip reads **This machine** with no cloud picker on a normal local
      install. A deliberately dual-target deployment offers both; an unknown
      status resolves to neither.
- [ ] Type `pwd` and press Send: ONE dialog, no install request. Cancel: the
      draft survives, nothing downloaded, nothing minted, and the next Send
      reopens it.
- [ ] Cold **Install & allow**: the POST acknowledges 202; the notice and
      `/runtime/status` agree through downloading and verifying; the grant is
      minted once at ready and no chat request fires. Press Send after: `pwd`
      returns the approved folder.
- [ ] Warm runtime, no consent: **Allow** awaits the grant and continues the
      original send once, carrying a matching fresh body and header. Restart
      with a still-valid stored grant and unchanged context: no dialog.
- [ ] During download or grant: cancel authorization, sign out, switch
      user/project/folder/host/target, revoke in another tab, or bump the
      runtime/policy expectations. No stale consent is persisted and no pending
      turn executes. A reload may observe the install but needs fresh approval
      to grant.
- [ ] Two Inspector processes sharing a runtime root, plus an install CLI
      caller: one install per identity, shared status, no competing activation.
      Race session startup with a repair — no in-use runtime is removed and no
      live staging directory is swept. Kill the installer: the state is
      `interrupted` and recoverable.
- [ ] Corrupt a file while leaving the install marker intact: readiness fails
      verification (`?verify=1`) and an explicit repair works.
- [ ] The scenario list: `pwd`, a read, an edit with approval, an MCP tool
      through the proxy, abort mid-turn, resume, stop.
- [ ] A REMOTE MCP server (Excalidraw, say) participates through the
      Inspector's MCP proxy. Local execution does not require local servers.
- [ ] Harness log shows `provider=mcpjam-local-supervised` and **no** E2B calls.
- [ ] Nothing new in the workspace after the session.
- [ ] No surviving pids and an empty process registry after stop.

**Rollback**

- Fastest and cohort-wide: turn the PostHog flag off. The UI disappears; running
  sessions are unaffected, which is usually right.
- To stop work now: `POST /api/mcp/local-harness/stop-all` on the affected
  machine, or revoke the leases from the control plane.
- To stop it starting: `MCPJAM_LOCAL_HARNESS_ENABLED=false`, or revoke the
  instance keys for the affected machines (which also kills in-flight leases).
- A bad pack: publish a new pack version and regenerate the digests. The old
  digest stops matching and every install of it refuses.
