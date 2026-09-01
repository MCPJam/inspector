# Local Claude Code (native on the user's machine) — spike results and cloud-agent handoff

**Date:** 2026-09-01 · **Author:** Claude, from spikes run on the maintainer's Mac (Apple Silicon, macOS 24.6, load avg ~20 during runs)
**Supersedes for execution:** `~/.claude/plans/jazzy-hugging-cookie-tl.md` (TL review plan) and `jazzy-hugging-cookie.md` (detailed design). Those remain the design rationale; this file is what the implementer executes.

## Context

MCPJam's Claude Code host runs the real Claude Code agent, but only inside an E2B computer, and only from a server that is a computers data plane. The desktop app and `npx @mcpjam/inspector` are not data planes, so today a local user cannot run Claude Code at all. PR #4532 merged a supervised-native foundation (`mcpjam-inspector/server/utils/harness/local/`) that can run an official vendor harness as a supervised host process, but it is dark (`MCPJAM_LOCAL_HARNESS_ENABLED`, default off), structurally unable to run (placeholder digests, empty conformance version), and not wired into the turn path.

The TL decided (2026-09-01): ship for **both Electron and npx**; target **every platform Electron ships** (Windows stays excluded until whole-tree cleanup exists there); **direct checkout** with Claude Code's own approvals; a **robust** brokered model credential; **as performant as possible**; **Claude Code only**.

I ran the I0 spike end to end on this machine against a mock Anthropic upstream behind a loopback gateway (no real credential was available; the auto-mode classifier correctly refused reading the Convex gateway key). Everything below is measured or observed, not inferred. The spike code, the prototype fixes, and the logs live in a git worktree (see "Where things are"). **Nothing is committed yet** — step 0 is to commit and push that branch so a cloud agent can read it.

## What the spike proved

| Capability | Result |
|---|---|
| Consent → availability → supervised provider → `HarnessAgent` + `createClaudeCode` with the real `@ai-sdk/harness-claude-code@1.0.100` | Works; provider id `mcpjam-local-supervised`; no E2B calls |
| Bridge start under the pack's own Node 24.20.0 binary, loopback-only, verified by the provider's exposure probe | Works; the negative test (bridge left binding 0.0.0.0) is refused and leaves no process behind |
| Real native `claude` 2.1.245 binary spawned by the agent SDK, model calls through the loopback gateway with a per-session capability; upstream key never in any child env or on disk | Verified (canary string absent from all child envs and session files) |
| Read tool (free), Bash tool with approval pause → `suspendTurn` → `createSession({continueFrom})` → `continueStream` | Works; suspend+continue 3 ms |
| `detach()` → `createSession({resumeFrom})` → next turn remembers history (`--resume`) | Works; model saw 3 user turns after resume |
| Clean `stop()`, `destroy()`, abort mid-turn, Inspector crash + fresh-process janitor reclaim | Work **after** the fixes below (two of them were broken in the merged foundation) |
| Checkout hygiene | With the prototyped work-dir layout the user's checkout gains nothing; all bridge/CLI state is in the owner-only session dir |

### Measured timings (mock upstream; excludes model latency)

| Stage | Measured | Note |
|---|---|---|
| Bare bridge spawn → listening | 134–154 ms | `spike/timing-decomp.mts` |
| Full-tree SHA-256 digest of the 515 MB pack (5,462 files) | 620–1,500 ms | warm vs loaded machine |
| Digests per session start **today** | 5 | consent path 2, availability 2, pre-spawn re-verify 1 |
| Exposure probe (`assertBridgeLoopbackOnly`) on this Mac | **11 s** | 10 link-local `fe80::` addresses × sequential 500 ms timeout; 0 ms when only routable addresses exist |
| Session ready (create → bridge verified) | 0.83 s best / 12–14 s loaded | the difference is the two items above |
| First turn on a cold machine (first ever `claude` launch) | 2.8 s | page cache; later cold sessions 0.4–1.0 s |
| Warm turn (Read / Bash+approval / resumed COUNT) | 270–800 ms | CLI is spawned per turn and exits after it |
| Clean stop (after fix) | ~60 ms graceful | |
| Destroy with an orphaned CLI child (after fix) | 2.0 s | SIGTERM grace on the CLI |
| Janitor reclaim of an orphaned tree from a crashed Inspector | 70 ms | |
| Idle footprint of a detached session | bridge node ~60–115 MB RSS, no CLI resident | CLI ~355 MB RSS only while a turn runs |

With D7 and D8 fixed, session start is ~150 ms bridge + one digest (≤1 s) — well inside a 1.5 s p95 SLO on supported hardware.

## Facts that change the plan (verified)

1. **Claude Code is a native binary now.** `@anthropic-ai/claude-code@2.1.245` is a wrapper whose postinstall copies a 376 MB Mach-O from `@anthropic-ai/claude-code-darwin-arm64`; `@anthropic-ai/claude-agent-sdk@0.3.245` ships the **same binary** (identical sha256) in `claude-agent-sdk-darwin-arm64` and spawns it directly (`pathToClaudeCodeExecutable` defaults to its own platform package; error "Native CLI binary for <platform> not found" otherwise). The SDK's `manifest.json` lists per-platform checksums (darwin-arm64/x64, linux-x64/arm64, musl). The binary is Anthropic Developer-ID signed with hardened runtime. Only the AI SDK **bridge** (`bridge.mjs`) needs Node.
2. **Electron cannot be the Node launcher.** `forge.config.ts` sets fuse `RunAsNode: false`, so the foundation's `node-launcher.ts` "electron-as-node" branch is dead in packaged builds. The pack must carry a Node binary. nodejs.org `node-v24.20.0-darwin-arm64` is Node.js Foundation Developer-ID signed (hardened runtime) and worked as the launcher in every run.
3. **pnpm output needs post-processing.** `pnpm install --frozen-lockfile --node-linker=hoisted` against the adapter's verbatim `package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml` installs in ~5 s but leaves `.bin` symlinks (the digest refuses symlinks) and 758 MB. Removing `.bin` dirs and the unused `@anthropic-ai/claude-code` wrapper + its platform package gives 515 MB, symlink-free. Nothing in the bridge or SDK references the wrapper.
4. **The bridge binds `0.0.0.0`** (`new WebSocketServer({ port, host: "0.0.0.0" })`). The provider byte-compares the adapter's recipe `bridge.mjs` against the bundle copy, so the bridge file cannot be patched. A launcher wrapper (`launcher.mjs`: patches `net.Server.prototype.listen` to force 127.0.0.1, then imports `./bridge.mjs`) works because `bridge.mjs` runs at import time and parses `process.argv.slice(2)`.
5. **The closed command grammar was incomplete for the stable line.** The framework issues `printf "%s" "$HOME"` before every bridge start (`resolveSandboxHomeDir`), and `writeSkills` runs on **every prompt turn even with zero skills**, issuing `mv -f 'manifest.tmp' 'manifest'`, `test ! -e '<skillDir>'`, `rm -rf -- '<skillDir>'…` under `$HOME/.claude/skills`. None were translated; every local session failed closed at translation.
6. **macOS reports an exiting process's command as `(node)`.** The birth identity is `lstart|argv`; on stop the adapter makes the bridge exit itself, `ps` shows `(node)`, the compare says `not-owned`, the supervisor refuses to signal, and every clean stop was recorded as an escape (`processes.json` state `failed`).
7. **Abort orphans the CLI.** On abort the bridge exits before the supervisor signals; the root is gone at first look, the group is live, and the design deliberately refuses to signal an unanchored group. The 357 MB `claude` child kept running.
8. **The agent framework forbids working in the workspace root.** `sandboxConfig.workDir` must be a relative proper subdirectory of the provider's `defaultWorkingDirectory` ("." and absolute paths are rejected). With the workspace as default dir, Claude ran in `<workspace>/claude-code-<sessionId>` and the bridge wrote `.agent-runs/<id>/bridge/start-config.json` (**mode 0644, containing the session model capability and full env**) plus `event-log.ndjson` (full transcript) into the user's checkout.
9. **Exposure probe cost** (item 9 in the table): `nonLoopbackLocalAddresses()` includes `fe80::` link-local addresses that cannot be connected without a scope id; each waits the full timeout, sequentially.
10. **The CLI probes `HEAD /api/hello`** on `ANTHROPIC_BASE_URL` with no auth before its first request. The gateway must answer that path without a capability (the spike's 401 did not block the run, but it is noise and may affect the CLI's "API reachable" heuristics).
11. The adapter warns "sandbox does not support request transformations … falling back to less secure credential forwarding": with our provider the model auth reaches the CLI as env (`ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`) over the bridge's start message. That is why the child must only ever hold a session capability, never the lease.
12. `CLAUDE_CODE_TMPDIR` passed through the adapter `env` is honored by the CLI (its temp went under the synthetic home). The bridge process itself does not get adapter env; the SDK's `extractFromBunfs` hardcodes `/tmp` on darwin unless `CLAUDE_CODE_TMPDIR` is in the bridge env → also put it in `scopedEnv`.
13. The runtime identity, consent, availability, supervisor, janitor, grants and confinement code all behaved as designed; no security-relevant defect was found in them beyond items 6–8.

## Prototyped fixes (uncommitted, on the spike worktree; all 15 foundation test files run, 14 tests fail because they encode the old behaviour)

| ID | Defect | Prototype location | Status |
|---|---|---|---|
| D1 | `printf "%s" "$HOME"` untranslated | `command-translation.ts`: `HOME_PROBE` → `{kind:"reply", stdout: ctx.syntheticHome}` | validated |
| D2 | `mv -f` / `test ! -e` / `rm -rf --` untranslated | `command-translation.ts`: new arms `rename` / `probe-absent` / `remove`, operands must be under the synthetic home; `supervised-provider.ts` executes them with `node:fs` (`rename`, `stat`, `rm`) | validated on every turn |
| D3 | exiting `(node)` identity → `not-owned` | `process-identity.ts`: `sameBirthIdentity()` accepts an lstart match when the current command is the parenthesised form; used in `terminateOwnedProcessGroup` and `isSameProcess` | clean stop now `graceful`, registry empty |
| D4 | abort orphans the CLI | `process-identity.ts`: `listGroupMembers()`, `terminateOwnedProcess()`; `supervisor.ts`: `LiveProcess.orphanSnapshot` taken on root `exit`, settled member-by-member in `stopSession` when the group outcome is `unknown` | abort test: child settled `graceful`, group empty, state dir removed |
| D5 | work-dir layout / checkout pollution | `supervised-provider.ts`: `defaultWorkingDirectory = <sessionStateDir>/work`, `work/project` symlink → granted workspace, translator context resolved against `work`; agent `sandboxConfig.workDir: "project"` | Claude's `pwd` = real checkout; checkout gains nothing |
| D6 | bridge binds 0.0.0.0 | `spike/bundle-launcher.mjs` (ships in the pack as `launcher.mjs`); `command-translation.ts` `CommandTranslationContext.bridgeLauncherPath` (provider passes `runtime.launcherPath`); manifest `launcherRelativePath: "launcher.mjs"` | validated + negative test |
| D7 | exposure probe 11 s | not fixed; measured in `spike/probe-timing.mts` | design below |
| D8 | 5 digests per session start | not fixed; measured in `spike/timing-decomp.mts` | design below |
| D9 | electron-as-node launcher dead | not fixed | design below |
| D10 | capability persisted 0644 in checkout | fixed by D5 (now under the 0700 session dir) | keep short TTL + revoke |
| D11 | `HEAD /api/hello` | gateway design | |

## Design deltas (what the implementer builds differently from the TL plan)

### Runtime pack (replaces "managed bundle inside the install")
One signed, per-platform **runtime pack** = verbatim adapter recipe files (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `bridge.mjs` byte-identical to the adapter's `dist/bridge/index.mjs`) + `launcher.mjs` + hoisted symlink-free `node_modules` pruned of the wrapper + `bin/node` (official nodejs.org build, v24 LTS). Build script prototype: `spike/build-bundle.sh`. Size ~515 MB on disk, roughly 150–200 MB compressed. It is **downloaded on demand** ("Install local runtime" is an explicit step in the consent flow; digest-verified against the signed pack manifest; atomic activation into a versioned directory; rollback = keep previous version), for **both** distributions: the npm package cannot carry it, Electron notarization should not be coupled to a third-party 376 MB binary, and Claude Code updates decouple from Inspector releases. Location: Electron `app.getPath("userData")/local-harness/runtime/<packVersion>/claude-code`; npx `~/.mcpjam/harness-local/runtime/<packVersion>/claude-code`. `runtimeRoot` for the foundation = that versioned dir. The pack manifest records: adapter version, vendor package versions (from the SDK's own `manifest.json` checksums), tree digest, Node version, build provenance. The compatibility manifest gets the real `bundleDigest`, `launcherRelativePath: "launcher.mjs"`, `bridgeBundleDigest`, and a non-empty `lifecycleConformanceVersion` only after the conformance job passes.

### Node launcher
Always the pack's `bin/node` (covered by the digest), for npx too; delete or deprecate the `electron-as-node` branch of `node-launcher.ts` (D9). `resolveNodeLauncher({ execPath: <pack>/bin/node })` is what the spike used.

### Verification cost (D8)
Full digest once per **process** per pack version (at availability), cached in memory keyed by canonical root + pack version; before every spawn re-verify with a stat snapshot (path, size, mtime, ino, mode of every entry, captured during the full digest) and full-hash only `launcher.mjs`, `bridge.mjs`, `bin/node`, and the native `claude` binary is optional (0.3 s) — behind a config knob defaulting to the stat snapshot. Also stop computing the digest twice inside `resolveLocalHarnessAvailability` (`resolveManagedBundle` then `revalidateRuntime` re-hash the same tree back to back).

### Exposure probe (D7)
Probe all non-loopback addresses **in parallel**, skip `fe80::/10` link-local addresses that carry no scope id (or append `%<ifname>` from `os.networkInterfaces()`), keep the 500 ms timeout, and additionally read the bound address from the OS (`lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN` on darwin, `/proc/net/tcp*` on linux) and fail if anything other than a loopback address is listed. Keep the connect probe as the enforcing check.

### Brokered model access (B1)
Backend (mcpjam-backend, Convex): new lease `delivery: 'inspector-loopback-gateway'`. The Inspector server process (never the renderer) registers an instance key once at consent (`POST /web/harness/local-instance/register` with `machineId`; key held in the OS keystore on Electron via `safeStorage`, owner-only file for npx). `POST /web/harness/model-broker/start` with that delivery returns the lease **to the inspector** plus `proxyBaseUrl`; all existing bindings (user, org, project, harness, protocol, model allowlist, budgets, expiry, max active leases) stay; add `machineId` and `sessionGeneration`. Every upstream request from the inspector's loopback gateway carries `Authorization: Bearer <lease>` and `x-mcpjam-pop: <ts>.<nonce>.<hmac-sha256(instanceKey, method\npath\nts\nnonce)>`; the proxy verifies the PoP against the registered key before reading the body, rejects skew > 60 s and replayed nonces (TTL store keyed by jti+nonce), and revokes on stop/abort/timeout/consent revoke/generation change. Spike prototype of both halves: `spike/local-gateway.mjs` (client) and `spike/mock-anthropic.mjs` (verifier). Gateway rules: bind 127.0.0.1 only, random port, validate `Host`, reject any `Origin`, allow only `POST /v1/messages*` (+ `count_tokens`) and answer `HEAD /api/hello` with 200 without a capability, constant-time compare of the per-session capability (`ANTHROPIC_API_KEY` in the child), byte limits, never log bodies or headers, revoke = refuse further requests. The child's `ANTHROPIC_BASE_URL` is the gateway.

### Work-dir layout (D5) and MCP delivery
Adopt the session-owned `work/` + `project` symlink layout from the spike. Deliver the host's MCP servers through `createClaudeCode({ mcpServers })` (the bridge passes them to the SDK) instead of `deliverMcpServers` writing `.mcp.json` into the session work dir, which would land in the user's checkout under this layout.

### Session policy (decision 4, recommended)
Attended only. After a clean turn `detach()` keeps the bridge warm (60–115 MB, no CLI) for **15 minutes** idle, then `stop()` persists the resume state (continuity survives via `--resume` from the synthetic home); `destroy()` at consent expiry (12 h grant TTL) or explicit stop. On Inspector restart the janitor **terminates** orphaned trees (never adopts) in v1. Abort = `destroy()`.

### Windows
Stays refused by `supportsOwnershipProof('win32')` with the existing `ownership-unprovable` message. Follow-up PR: Job Object helper (create-suspended → assign kill-on-close job → resume) plus per-member identity via `wmic`/PowerShell `CreationDate`, conformance on a `windows-latest` runner. Not in the first release.

### What a cloud agent can verify without a Mac
The whole spike (mock upstream, gateway, bridge, native CLI) is platform-portable: the SDK ships linux-x64/arm64 binaries and nodejs.org ships linux tarballs. Add a CI job on `ubuntu-latest` that builds the linux pack and runs the spike scenarios (full, no-launcher, abort, orphan-a/b) — that is the conformance suite's seed. macOS-only facts (`(node)` identity, `ps -g`, Seatbelt) get a `macos-latest` job. The maintainer reruns the macOS scripts locally when asked.

## Reuse map (verified paths; copy these patterns rather than inventing new ones)

Client (`mcpjam-inspector/client/src/`):
- `hooks/useComputerEngine.ts` — the candidate race (`storedPref → server defaultEngine → local → cloud`) producing **two** answers: `engine` (consent-gated, drives execution) and `selectedEngine` (consent-blind, drives which face renders). The harness target selector needs the same split so picking "Native" before consenting shows the consent sheet instead of bouncing to Hosted.
- `hooks/useComputersEnabled.ts` — `useLocalComputerEnabled()` fail-closed flag gate (`=== true`); add `useLocalHarnessEnabled()` for the `local-harness-enabled` flag the same way.
- `hooks/useLocalComputerConsent.ts` + `lib/local-computer-consent.ts` — pure `useSyncExternalStore` projection of localStorage, **no client verify loop** (earlier verify-on-mount versions grew five race guards for zero safety); mint/persist split; token-scoped revoke. Copy wholesale for the harness grant token (`x-mcpjam-local-harness-grant`, `grants.ts`).
- `lib/computer-engine-storage.ts` — per-project storage keys (not a shared map) for the target choice.
- `components/computer/LocalComputerConsentGate.tsx` and `LocalComputerView.tsx` — the blunt "not a sandbox" copy, the `shown → granted | denied` content-free funnel, and the "Forget & re-authorize" recovery path. The harness consent sheet adds runtime version + digest, workspace display root, permission profile, and expiry.
- `components/chat-v2/thread/parts/tool-part.tsx` `readToolRunLocation()` (line ~1164) — provenance read from the frozen raw output; the run-location pill is itself flag-gated. Reuse for "ran natively on this machine" attribution.
- `hooks/use-chat-session.ts` lines ~2761-2785 and ~2939 — where the local-consent header and `computerEngine` body are attached, scoped to `/api/mcp/chat-v2` only (`!shouldUseOrgAwareChatApi`). The harness target ids travel the same way; the grant token as a header, never in the body.
- `lib/session-token.ts` `HOSTED_AUTH_PATH_PREFIXES` (line ~296) — **every new `/api/mcp/...` route must be added here** or `authFetch` attaches no bearer and the route 401s for every WorkOS-signed-in user (this exact bug shipped once as PR #4515). Never set `Authorization` manually.

Server (`mcpjam-inspector/server/`):
- `routes/mcp/computers.ts` — the middleware stack template for loopback routes: `/api/mcp` mount (inspector session token) + `bearerAuthMiddleware` + `requireVerifiedAuth()` + explicit guest 403 + kill-switch 404; note the terminal-mint route needed its own identical stack because the wildcard did not cover it.
- `utils/computers/local-consent.ts` — hash-only persistence, `timingSafeEqual`, mutation lock with lock-free verify; the harness twin already exists in `utils/harness/local/grants.ts`.
- `routes/web/computers.ts` `GET /api/web/computers/config` — open endpoint returning `engines` + `capabilities` + tri-state `defaultEngine`; extend with `harnessTargets: { localNative: { available, status, runtime: { packVersion, adapterVersion, vendorVersions, digest } | null, workspaceDisplayRoot } }` (tilde display roots only, never absolute home paths).
- `utils/computers/engine.ts` — `resolvePersonalComputerEngine` / `coercePersonalEngineForActor`: an explicit `local` that cannot be honoured resolves `unavailable`, never silently cloud; `utils/harness/local/availability.ts` is already its harness twin.
- `middleware/origin-validation.ts` `isAllowedRequestOrigin()` (line ~106) — re-check inside handlers; absent `Origin` is rejected there.
- `utils/computers/local-terminal-auth.ts` — single-use 60 s nonces bound to project + consent fingerprint; the pattern for any WebSocket/stream the local target opens.
- `utils/mcpjam-stream-handler.ts` `MCPJamHandlerOptions` (line ~562) — has `harness`, `harnessSandboxBinding`, `computerWorkdir`, `builtInTools` but **no field for a local harness target**: PR 5 adds `harnessExecutionTarget?: { kind: "local-native"; workspaceGrantId; runtimeId; permissionProfile; policyVersion; grantToken }` (opaque ids only) and threads it from both `routes/mcp/chat-v2.ts` (body parsed ~1143-1174 for `computerEngine`; harness dispatch ~1363 and ~1609-1620 never reads it today) and `routes/web/chat-v2.ts`.
- `utils/harness/run-harness-turn.ts` `runHarnessTurn(options: MCPJamHandlerOptions, streamSink)` (line ~549); the single provider construction point is `createE2BHarnessSandboxProvider` at ~1698 with the workdir resolution just above it — the branch point.

Electron (`mcpjam-inspector/src/`):
- `preload.ts` exposes `electronAPI.files.openDialog(options)`; `ipc/files/file-listeners.ts` spreads caller options last, so `{ properties: ["openDirectory"] }` already works with **no preload change**. `window.isElectron` / `window.isElectronPackaged` tell the renderer where it runs. The picker result must go main-process → `registerWorkspaceGrant` → opaque id; add a sender-identity check like `ipc/app/app-listeners.ts` for the new privileged channel. No directory picker exists anywhere today.

Docs: `docs/local-computer-engine.md` headings (What it is / Pieces / Trust model / Actor and route enumeration / Kill switch / Cloud-only surfaces / Terminal degrade / Analytics / Flag targeting / Launch-rollback checklist) are the template; analytics events must be registered in `shared/analytics-events.ts` (a ratchet test forbids raw `posthog.capture`) with enum/boolean/count props only. Cite `server/utils/harness/local/README.md` rather than restating it.

## Review notes (self-review; the critique agent hit a session rate limit)

- Ordering holds: PR 1 and PR 2 depend on nothing; PR 3 (backend) must deploy before PR 4's gateway can obtain a lease; PR 5 needs PR 1, 2 and 4; PR 6 needs everything. Merged ≠ deployed for the backend (prod deploys on inspector release promote) — sequence the deploys explicitly.
- Symlink work-dir layout: the link lives in the 0700 session dir and resolves into the workspace root, one of the two confinement roots, so no path outside the grant becomes reachable through the Inspector file API; the vendor process already has the OS user's authority, so the layout adds no new exposure. Keep the hop cap in `confine.ts`.
- Loopback gateway threat: the per-session capability reaches the CLI as env and is persisted in the bridge's `start-config.json` (0644 inside the 0700 session dir); any same-user process could present it to the gateway during the session. Mitigations already in the design: short session TTL, revoke on every terminal path, lease budgets, per-user rate limit. Recommended hardening in PR 4: the gateway resolves the connecting socket's peer pid (`lsof -nP -iTCP:<srcport>` on darwin, `/proc/net/tcp` + `/proc/<pid>/fd` on linux) and only serves pids in the supervised tree.
- Windows must be its own PR (Job Object helper + per-member identity + `windows-latest` conformance); do not let it block the macOS/Linux release.
- A cloud agent cannot run the macOS-only checks; the Linux CI job in PR 6 is how it gets evidence, and the maintainer reruns the macOS scripts on request. The `(node)` identity fix and the `ps -g` group probe are darwin-specific and need the `macos-latest` job.

## Implementation sequence (one PR per step, each fail-closed until the next lands)

**Step 0 (maintainer, after approving this plan):** commit the worktree `spike/local-harness-native` and push to `mcpjam` (MCPJam/inspector) so the agent can read the prototypes and logs.

**PR 1 — Foundation fixes from the spike** (inspector, `server/utils/harness/local/`)
- Land D1–D6 as reviewed code (the prototypes are annotated `SPIKE`; rewrite comments, keep behaviour), plus D7 and D8 designs above, plus `CLAUDE_CODE_TMPDIR` in `scopedEnv` (item 12).
- Update `ADAPTER_COMMAND_SHAPES.framework`; add the new arms to `TranslatedCommand`; keep `bridgeLauncherPath` optional (tests that pin the `bridge.mjs` remap stay meaningful for a pack without a launcher).
- Tests: fix the 14 failing tests (list in `spike` log `run vitest server/utils/harness/local`): `command-translation.test.ts` (grammar list, "rejects the retired $HOME probe" is now wrong), `supervised-provider.test.ts` (work-dir layout + launcher path expectations), `supervisor.test.ts` ("retains ownership when the root exits naturally before stop" now expects the tree to be settled from the snapshot). Add tests for `sameBirthIdentity`, `listGroupMembers`, `terminateOwnedProcess`, the skills shapes (in and outside the synthetic home), the symlinked work dir (confinement still holds), and the parallel probe.
- Acceptance: `npx vitest run server/utils/harness/local` green; the spike scripts still pass on macOS (maintainer) and on the Linux CI job.

**PR 2 — Runtime pack + installer + manifest** (inspector + CI)
- `scripts/build-local-harness-pack.mjs` from `spike/build-bundle.sh` (per platform: darwin-arm64, darwin-x64, linux-x64, linux-arm64); verify the native binary against the SDK `manifest.json` checksum; SBOM + license report for the pack; sign the pack manifest; upload as a release artifact.
- Installer: `server/utils/harness/local/runtime-install.ts` — download → verify digest → extract into `<runtimeRoot>/<packVersion>` → activate atomically; never during a session start; exposes status (`absent | downloading | verifying | ready | corrupt`) to the availability route.
- Manifest: real digests, `launcherRelativePath: "launcher.mjs"`, conformance version set by the CI job's output.
- Acceptance: a fresh machine can install the pack and `resolveLocalHarnessAvailability` returns a plan; digest cache makes a second session start do zero full digests.

**PR 3 — Backend broker delivery mode** (mcpjam-backend)
- `harnessModelLease.ts`: delivery union `'e2b-network-transform' | 'inspector-loopback-gateway'`; instance-key registration table; PoP verification in the model proxy; replay store with TTL; revoke path; audit events; per-user/per-instance rate limits; tests for replay, cross-session, route confusion, skew, revoke.
- Deploy order: backend before PR 4 (the inspector's gateway is dead code until this exists).

**PR 4 — Inspector gateway, routes, IPC, UI, flag**
- `server/utils/harness/local/model-gateway.ts` from `spike/local-gateway.mjs`; instance key storage; lease fetch via the new delivery mode.
- Loopback-only, session-authenticated, Origin-checked routes mirroring `computers/local-consent` (availability, workspace grant, consent grant/revoke, runtime install/status, stop-all); Electron: main-process `dialog.showOpenDialog` → IPC → `registerWorkspaceGrant`; renderer never sees a path.
- UI: target selector "Hosted / Native on this machine" (labels from `executionTargetLabel`), consent sheet showing runtime version + digest, workspace display root, permission profile, target guarantees (`targetHasHostContainment() === false` copy), consent expiry; PostHog flag `local-harness-enabled` (client, fail-closed, dark).
- Acceptance: renderer cannot submit paths/argv/env; audit records carry ids only.

**PR 5 — Turn integration**
- `run-harness-turn.ts`: resolve the target before continuity claim / broker start / any E2B work; branch once (`cloud` → existing E2B path unchanged; `local-native` → availability plan → supervisor + provider + gateway); include `runtimeId`, `workspaceGrantId`, `policyVersion`, target kind in the continuity fingerprint; thread through create/turn/approval continuation/resume/detach/stop/abort; permission mode always explicit (`workspace-edits` → `allow-edits`; hosts with `requireToolApproval` → `allow-reads`, the only mode under which MCP tools pause); MCP servers via adapter `mcpServers`; lease revoke on every terminal path; timing fields renamed so E2B-only labels are not reused.
- Both chat routes (`web/chat-v2`, `mcp/chat-v2`) must thread identically (memory: the desktop hits the mcp route).
- Acceptance: the TL validation scenario (plan §9) passes with a real credential on the maintainer's Mac; logs show zero E2B calls for a local turn.

**PR 6 — Conformance, telemetry, docs, rollout**
- CI: `ubuntu-latest` + `macos-latest` jobs running the spike scenarios against the built pack (`full`, `no-launcher`, `abort`, `orphan-a/b`, probe timing budget); record `lifecycleConformanceVersion` from the job.
- Telemetry (ids and outcomes only): target resolve, runtime verify, consent, gateway ready, spawn, bridge ready, first model byte, completion; SLOs: session start ≤ 1.5 s p95, warm resume overhead ≤ 300 ms p95.
- Docs: rewrite `docs/inspector/claude-code-host.mdx` ("no local fallback" is no longer true), add `mcpjam-inspector/docs/local-harness.md` modelled on `local-computer-engine.md` (launch/rollback checklist, flags, kill switch).
- Rollout: flag off at ship → `@mcpjam.com` dogfood → `deployment = self_hosted` cohort; kill switch `MCPJAM_LOCAL_HARNESS_ENABLED`; gateway revocation as the remote brake.

## Verification (how to rerun the spikes)

All paths below assume the worktree `/Users/marcelojimenezrocabado/mcpjam-inspector/worktrees/local-harness-spike` (symlinked `node_modules`) and the scratch root `S=/private/tmp/claude-501/-Users-marcelojimenezrocabado-mcpjam-inspector/0ea5eb59-a323-46b4-957d-fd3774eac40d/scratchpad/local-harness-spike` (pack at `$S/runtime/claude-code`, isolated `HOME=$S/home`, workspace `$S/workspace`, logs `$S/logs/`).

```bash
cd worktrees/local-harness-spike/mcpjam-inspector
# rebuild the pack from the installed adapter + a nodejs.org node binary
server/utils/harness/local/spike/build-bundle.sh node_modules/@ai-sdk/harness-claude-code/dist/bridge "$S/runtime" "$S/node-runtime/node-v24.20.0-darwin-arm64/bin/node"
# end-to-end: read tool, bash+approval, detach+resume continuity, stop, hygiene checks (JSON report at the end)
HOME="$S/home" SPIKE_ROOT="$S" npx tsx server/utils/harness/local/spike/run-native-turn.ts full
# negative: bridge without the loopback launcher must be refused
HOME="$S/home" SPIKE_ROOT="$S" npx tsx server/utils/harness/local/spike/run-native-turn.ts no-launcher
# abort mid-turn (CLI child must die), crash + janitor reclaim
HOME="$S/home" SPIKE_ROOT="$S" npx tsx server/utils/harness/local/spike/run-lifecycle.ts abort
HOME="$S/home" SPIKE_ROOT="$S" npx tsx server/utils/harness/local/spike/run-lifecycle.ts orphan-a && HOME="$S/home" SPIKE_ROOT="$S" npx tsx server/utils/harness/local/spike/run-lifecycle.ts orphan-b
# cost decomposition
SPIKE_ROOT="$S" npx tsx server/utils/harness/local/spike/timing-decomp.mts
npx tsx server/utils/harness/local/spike/probe-timing.mts
npx vitest run server/utils/harness/local
```

Expected: `full` ends with findings `after stop: surviving pids=[]`, `registry records after stop: 0`, `new entries in workspace after session: []`, `continuity: model saw 3 user turns`; `no-launcher` fails with "accepted a connection on a non-loopback address" and `pgrep -f launcher.mjs` is empty; `abort` prints `surviving pids: []`, `state dir exists after destroy: false`. A real-model run needs an Anthropic-protocol upstream: point `GW_UPSTREAM` at an HTTPS upstream (the spike gateway is http-only; switch to `https.request`) and set `GW_UPSTREAM_KEY` from the maintainer's environment, never from the repo.

## Assumptions and open items

- Default local permission profile `workspace-edits` (`allow-edits`): edits inside the workspace run free, Bash pauses; hosts with `requireToolApproval` map to `allow-reads` so MCP tools pause too (per `registry.ts`).
- `.mcp.json` is not written into the checkout; if the adapter `mcpServers` path proves insufficient for the proxy-token headers, write it under `work/project/.mcp.json` only with the user's explicit opt-in.
- Pack delivery is download-on-demand for both distributions (recommendation; the alternative of shipping it inside the DMG adds ~150 MB per release and couples notarization to Anthropic's binary).
- Windows deferred; Linux native supported from the first release if the Linux CI conformance job passes.
- The 12 h grant TTL and 15 min idle keep-warm are recommendations; tune from telemetry.
- Timings above were measured under load average ~20; treat them as upper bounds.

## Where things are

- Worktree: `/Users/marcelojimenezrocabado/mcpjam-inspector/worktrees/local-harness-spike` on branch `spike/local-harness-native` (from `main` @ 8058434cc2), **uncommitted**: 4 modified foundation files (`command-translation.ts`, `process-identity.ts`, `supervised-provider.ts`, `supervisor.ts`, +305/−10, `[spike-trace]` console logs included) and `server/utils/harness/local/spike/` (9 files: `build-bundle.sh`, `bundle-launcher.mjs`, `local-gateway.mjs`, `mock-anthropic.mjs`, `run-native-turn.ts`, `run-lifecycle.ts`, `group-settle.mts`, `timing-decomp.mts`, `probe-timing.mts`).
- Scratch (session-local, not committed): pack, Node runtime tarball, isolated HOME with grants/registry/session state, logs `run-full-1..11.log`, `run-no-launcher.log`, `lifecycle-*.log`.
- Related memory: `project_local_harness_program.md`; TL plan `~/.claude/plans/jazzy-hugging-cookie-tl.md`; foundation README `mcpjam-inspector/server/utils/harness/local/README.md`.
