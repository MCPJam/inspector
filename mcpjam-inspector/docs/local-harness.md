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

| Route | Does |
|---|---|
| `GET availability` | Status, runtime identity, key fingerprint. Ids only. |
| `GET runtime/status` | Cheap enough to poll during an install. |
| `POST runtime/install` | The explicit install step. Single-flight. |
| `POST workspace-grant` | Registers a directory. Same-origin re-checked in the handler. |
| `POST consent/grant` | Mints the capability; registers the instance key first. |
| `POST consent/revoke` | Forget & re-authorize. |
| `POST stop-all` | The local brake: ends every session this server owns. |

`/api/mcp/local-harness` is in `HOSTED_AUTH_PATH_PREFIXES`. Without that entry
every signed-in user gets a 401 on all of them — the bug PR #4515 shipped once.

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

## Analytics

Registered in `shared/analytics-events.ts` (a ratchet test forbids raw
`posthog.capture`). Enums, booleans and counts **only** — never a workspace path
even tilde-shortened, a machine id, a runtime digest, a lease, or a key.

| Event | Props |
|---|---|
| `local_harness_target_selected` | `location`, `target` |
| `local_harness_consent_gate_shown` | `location`, `runtime_ready`, `hosted_offered` |
| `local_harness_consent_granted` | `location`, `outcome` |
| `local_harness_consent_denied` | `location` |
| `local_harness_consent_reauthorized` | `location` |
| `local_harness_runtime_install_started` | `location` |
| `local_harness_runtime_install_completed` | `location` |
| `local_harness_runtime_install_failed` | `location`, `state` |
| `local_harness_unavailable` | `location`, `reason` |

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

## What blocks Windows

Windows is refused in three places that agree, and the conformance leg is
non-gating. That is a decision, not an oversight — but as of this branch it is
also a *measured* one, because the windows leg now runs far enough to say why.

The pack builds, installs, digest-verifies and resolves. Availability passes.
A session is created. It then fails inside the framework's bootstrap recipe:

```
CommandTranslationError: path operand
"/a/inspector/inspector/mcpjam-inspector/C:\Users\runneradmin\.mcpjam\…\work/.harness-bootstrap/claude-code"
contains a shell metacharacter or glob
```

Read that string carefully: a POSIX-looking prefix, then a Windows absolute
path appended to it rather than replacing it. `@ai-sdk/harness` composes the
bootstrap directory with

```ts
posix.isAbsolute(path) ? path : posix.resolve(defaultWorkingDirectory, path)
```

unconditionally, on every platform. `posix.isAbsolute("C:\Users\…")` is
`false`, so on Windows it resolves a native absolute path against the process
cwd and produces that hybrid. `supervised-provider.ts` mirrors this deliberately
— the translator has to expect the exact string the adapter will emit — so our
side is right and must NOT be "fixed" to use win32 resolution. Doing that would
make the translator stop recognising the adapter's own commands, which is worse
than the refusal.

Two things therefore stand between this and Windows support, in order:

1. **Upstream.** The framework's bootstrap recipe is POSIX-only. Until it
   resolves paths per-platform, no adapter command on Windows carries a path
   the translator can accept.
2. **Then ours.** `assertPlainPathOperand` rejects `\` as a shell
   metacharacter, which is correct on POSIX and wrong on a platform where it is
   the path separator. Making it platform-aware is a change to a security
   boundary and wants its own tests: a backslash that separates must be
   admitted, a backslash that escapes must not.

Neither is a reason to hold the darwin/linux ship. `nativePlatforms` keeps
refusing win32, and the leg keeps reporting — which is the point of running it.

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
- [ ] Conformance green on `ubuntu-latest` and `macos-latest`, and
      `lifecycleConformanceVersion` stamped from that run. Empty ⇒ every
      platform refuses, by design.
- [ ] PostHog flag created, employees-only, verified by evaluation.
- [ ] `MCPJAM_LOCAL_HARNESS_ENABLED` left **off** in every deployed
      environment. It is a local-Inspector capability; a deployed server has no
      business running an agent on its own host.

**Dogfood**

- [ ] Install the pack from a real release asset (not `MCPJAM_LOCAL_HARNESS_PACK_SOURCE`).
- [ ] The scenario list: `pwd`, a read, an edit with approval, an MCP tool
      through the proxy, abort mid-turn, resume, stop.
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
