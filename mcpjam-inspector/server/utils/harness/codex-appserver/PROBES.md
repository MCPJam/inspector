# codex app-server 0.149.1 — probe evidence (PR 1)

What the local and hosted Codex adapters are built on, measured against the
real binary. Recorded 2026-10-02. Read this before changing `bridge/`,
`codex-home.ts`, the permission mapping or the sandbox policy.

**Binary:** `@openai/codex@0.149.1` (`node node_modules/@openai/codex/bin/codex.js
app-server`), native binary from `@openai/codex@0.149.1-linux-x64`, sha256
verified against the registry tarball (see (f)).

**Host:** Ubuntu 24.04 container, kernel 6.18, x86_64, Node 22, **as root**.
User namespaces available; codex used its bundled `bwrap`.

**Model:** a scripted fake Responses server (no credential). It logs every
request and can emit namespaced `function_call` items.

**Scripts:** `.spike-codex-appserver/probe/2026-10-02-linux/` (`lib.mjs` is the
rig; one `probe-*.mjs` per question). Raw wire logs were not committed.

## What this evidence does and does not establish

- It is **assembly** evidence on one target (linux-x64, root, a container). It
  does not certify a product launch, another OS, another architecture, or a
  non-root user. Ubuntu 24.04's AppArmor user-namespace restriction, macOS
  Seatbelt and Windows `windowsSandbox/setupStart` were **not** exercised, so
  no target is recorded as passing the unattended sandbox
  (`unattendedSandboxTargets` stays empty) until its conformance leg does.
- No credentialed real-model call was made. Model-callability of a relayed
  MCP tool is shown with a scripted provider emitting the real call form.
- The 2026-09-30 macOS arm64 product-assembly probe cited in the plan
  (`sdk/testing/prototypes/engines/RESULTS.md`) is not in this checkout.

## What changed in the product because of it

| Finding | Change |
|---|---|
| `tool_timeout_sec = 0` fails every relay call in 8 ms; default is 300 s | `codex-home.ts` renders `3600` (verified to hold a 70 s call) |
| Codex gates MCP calls itself: refused under `never`, an `mcp_tool_call` elicitation (auto-declined by the bridge) under `untrusted` | relay server gets `default_tools_approval_mode = "approve"`; MCPJam's host-side gate is the single authority for relayed tools |
| Startup egress to github.com / api.github.com / chatgpt.com and a ~100 MB clone into each fresh `CODEX_HOME` | `[features] plugins = false` |
| `thread/start.config.mcp_servers` **merges**; `{X: {enabled: false}}` disables X; `/etc/codex/{config,managed_config}.toml` servers are loaded | the bridge disables every MCP server a system/managed layer declares, per thread; the project layer is disabled because no project is ever trusted |
| `untrusted` asks about **every** command, `pwd` included; both `apply_patch` forms raise `fileChange` approval | product copy and comments say every command and file change prompts; no claim that reads are free |
| explicit `workspaceWrite` policy: cwd and `$TMPDIR` writable, `/tmp` and `$HOME` not, reads allowed, all network (incl. loopback) blocked, escalation refused, fails closed when the sandbox cannot start | D2 policy as specified; unattended local Codex still refused until per-target conformance |
| under `danger-full-access` a `setsid` child escapes the app-server's process group; under workspace-write nothing survives | local Codex never runs `danger-full-access` (the bridge refuses it under local supervision) |
| bare-origin `base_url` → `POST /responses`; `…/v1` → `POST /v1/responses` | local `OPENAI_BASE_URL` is the gateway's bare origin (it forwards `/responses` under the broker's own `/openai/v1`); hosted stays `…/openai/v1` |
| registry integrity + sha256 for every platform tarball | `scripts/local-harness-pack-recipes/codex-vendor-checksums.json`, the Codex pack recipe's checksum source |

## Summary

| Probe | Verdict | One-line result |
|---|---|---|
| (a) URL shape | **PASS** | codex POSTs to `<base_url>/responses` and nothing else. `base_url` **must include `/v1`**: a bare origin produces `POST /responses`. |
| (a2/a3) other egress | **PASS** (finding) | At startup codex contacts `github.com`, `api.github.com` and `chatgpt.com`, and clones about 100 MB into `CODEX_HOME/.tmp`. `[features] plugins = false` removes all of it. |
| (b1) project layer | **PASS** | An untrusted project's `.codex/config.toml` is **disabled**: the planted server is not spawned. **AGENTS.md and `.agents/skills` from the repo still reach the model.** |
| (b2) `thread/start.config.mcp_servers` | **PASS** | **Merges** with the CODEX_HOME and project layers. It does not replace them. |
| (b3) removal | **PASS** | `config: {mcp_servers: {X: {enabled: false}}}` and the dotted form `{"mcp_servers.X.enabled": false}` both disable X. `{X: null}` is a thread/start error. `{mcp_servers: {}}` is a no-op. |
| (b4) system/managed layers | **PASS** | `/etc/codex/config.toml`, `/etc/codex/managed_config.toml` and `/etc/codex/requirements.toml` are all read and applied. requirements.toml **silently downgrades** `approvalPolicy: "never"` to `untrusted`, with a warning only. |
| (c) sandbox, workspaceWrite + never | **PASS** | Writes in cwd and $TMPDIR succeed. Writes elsewhere in /tmp and in $HOME fail (read-only). Reading /etc works. All network fails, loopback included. `require_escalated` is refused. |
| (c) symlinked cwd | **PASS** | Works. Writes land in the real directory. |
| (c) sandbox cannot initialize | **PASS (fails closed)** | With user namespaces blocked, every command fails with `bwrap: Creating new namespace failed ... (ENOSPC)` and nothing runs unsandboxed. |
| (c) attended (`untrusted` + `workspace-write`) | **PASS** | A file-writing command raises `item/commandExecution/requestApproval`. Both apply_patch paths raise `item/fileChange/requestApproval`. **So does every read-only command, even `pwd`.** |
| (d) relay timeout | **PASS** | 5 s cuts a 15 s call at 5.01 s. 3600 completes a 70 s call. The **default is 300 s**. **`tool_timeout_sec = 0` fails every call instantly**, and 0 is what `codex-home.ts` renders today. |
| (d) MCP approval gating (found along the way) | **PASS** (finding) | Under `never`, an MCP call is **refused** unless `default_tools_approval_mode = "approve"` (or the tool has `readOnlyHint`). Under `untrusted` or `on-request` it raises `mcpServer/elicitation/request`, which the bridge auto-declines. |
| (e) processes | **PASS** | Under danger-full-access codex reaps `&`, `nohup` and `( &)` jobs, but **`setsid` escapes** (own session, ppid=1) and survives SIGTERM then SIGKILL of the app-server process group. Under workspace-write nothing survives. |
| (f) checksums | **PASS** | All 6 platform tarballs match the registry sha512 `integrity` and sha1 `shasum`. The output is `codex-vendor-checksums.json`, and `npm audit signatures` passes. |

Not run: a **non-root** sandbox run. The session scratch tree is `drwx------ root`, and the instructions confine work to it, so `setpriv --reuid=65534` could not read the binary (`Permission denied`). E2B's unprivileged user is therefore untested here.

---

## (a) URL shape: `probe-a-url-shape.mjs`

Each run uses a fresh CODEX_HOME whose `[model_providers.probe]` has `base_url = <X>` and `wire_api = "responses"`, plus one text turn and a `model/list` call. The fake server logs every request.

| `base_url` | Requests seen (method + raw URL), complete list |
|---|---|
| `http://127.0.0.1:33649` (bare origin) | `POST /responses` |
| `http://127.0.0.1:42625/v1` | `POST /v1/responses` |
| `http://127.0.0.1:40701/v1/` (trailing slash) | `POST /v1/responses` (normalised, no `//`) |

- codex sends no `GET /models` and no websocket upgrade. `model/list` answered with 5 models without touching the provider.
- **Conclusion:** codex appends `/responses` to `base_url` verbatim. Pointed at the hosted MCPJam proxy (which allowlists `POST /v1/responses`), `base_url` must end in `/v1` — the hosted broker's `…/openai/v1`. Pointed at the LOCAL gateway, it must be the bare origin: the gateway allowlists `POST /responses` and forwards it under the broker's own `/openai/v1` path, and a `/v1` suffix would produce `POST /v1/responses`, which the gateway refuses.

### (a2/a3) Egress beyond the model provider: `probe-a2-egress.mjs`, `probe-a3-plugin-sync.mjs`

Method for (a2): `HTTPS_PROXY`, `HTTP_PROXY` and `ALL_PROXY` point at a local proxy that logs each CONNECT and refuses it. `NO_PROXY=127.0.0.1`. The run is init, thread/start, one turn, then 15 s idle.

- **Default:** CONNECT to `github.com:443` (+185 ms), `chatgpt.com:443` (twice) and `api.github.com:443`. In stderr:
  - `failed to warm featured plugin ids cache ... https://chatgpt.com/backend-api/plugins/featured?platform=codex`
  - `git ls-remote curated plugins repo ... https://github.com/openai/plugins.git/`
  - `... https://api.github.com/repos/openai/plugins`
- **With `[features] plugins = false`:** zero proxied egress. The only request is `POST /v1/responses`.

Method for (a3): the same comparison, but with the container's real proxy available.

- **Default:** the fresh CODEX_HOME grew to **101 MB**, with `.tmp/plugins` holding a clone of `openai/plugins`.
- **With `plugins = false`:** **3.5 MB**, and no `.tmp`.

With a real proxy (not the refusing one), codex also reached chatgpt.com and got a 401 back. For E2B this is about 100 MB of download and disk per fresh CODEX_HOME, plus egress the proxy allowlist does not expect.

## (b) Config layers: `probe-b-config-layers.mjs`, `probe-b4-system-layers.mjs`

**Setup.**
- CODEX_HOME declares `[mcp_servers.home_server]`.
- The project dir (= thread cwd) holds `.codex/config.toml` with `[mcp_servers.project_planted]` and an `AGENTS.md` containing `MARKER-AGENTSMD-7f3a9c2e`.
- Every server is `mcp-server.mjs`, which writes `{event:"spawned"}` to a log on start.
- Each run reads `config/read {cwd, includeLayers:true}` and `mcpServerStatus/list`.

**(b1) Project layer**

| Scenario | Project layer | Spawned | Tools sent to model | AGENTS.md marker in request |
|---|---|---|---|---|
| untrusted, non-git | `disabledReason: "To load project-local config, hooks, and exec policies, add <dir> as a trusted project in <CODEX_HOME>/config.toml."` | `home_server` only | `mcp__home_server` | **yes** |
| untrusted, `git init` | disabled (same) | `home_server` only | `mcp__home_server` | **yes** |
| trusted (`[projects."<dir>"] trust_level="trusted"`) | active | `home_server`, `project_planted` | both | yes |

- In the untrusted case codex emits `configWarning`: *"Project-local config, hooks, and exec policies are disabled in the following folders until the project is trusted, but skills still load."*
- AGENTS.md arrives as a `user`-role message beginning `# AGENTS.md instructions for <cwd>`.
- codex never rewrote CODEX_HOME/config.toml. thread/start does not auto-trust the cwd.
- **(b5)** `thread/start config: {project_doc_max_bytes: 0}` → marker **absent**. This suppresses AGENTS.md.
- **(b6)** In an untrusted project, a planted `.agents/skills/planted-skill/SKILL.md` puts its name and description (`MARKER-SKILL-91be44d0`) into the request's skills list. Skills load even when the project is untrusted.

**(b2) `thread/start` `config.mcp_servers`.** The request was `{"cwd":…, "approvalPolicy":"never", "sandbox":"read-only", "config":{"mcp_servers":{"mcpjam":{"command":…,"args":[…],"env":{…}}}}}`.
- Untrusted: spawned `home_server` and `mcpjam`.
- Trusted: spawned `project_planted`, `home_server` and `mcpjam`. The model got all three namespaces.
- **It merges; it does not replace.** A planted server that the project layer is allowed to load stays live next to the relay.

**(b3) Removal shapes** (trusted project, so `project_planted` would otherwise load):

| `config` passed to thread/start | Result |
|---|---|
| `{"mcp_servers":{"project_planted":{"enabled":false},"home_server":{"enabled":false},"mcpjam":{…}}}` | **only `mcpjam` spawned**. The disabled servers still appear in `mcpServerStatus/list` with `tools: []`. |
| `{"mcp_servers.project_planted.enabled":false,"mcp_servers.home_server.enabled":false,"mcp_servers.mcpjam":{…}}` (dotted keys) | **same**: only `mcpjam` spawned |
| `{"mcp_servers":{}}` | no effect; both servers spawned (deep merge) |
| `{"mcp_servers":{"project_planted":null}}` | thread/start **error** `{"code":-32600,"message":"failed to load configuration: invalid type: string \"\", expected struct RawMcpServerConfig\nin `mcp_servers.project_planted`\n"}` |
| `{"mcp_servers":{"project_planted":{"command":"/bin/false","args":[]}}}` | field-level override: `project_planted=failed` (handshake failed); the original command never ran |

**(b4) System / managed layers.**
- The probe planted these files and **removed `/etc/codex` afterwards; it did not exist before**:
  - `/etc/codex/config.toml` with `[mcp_servers.etc_system]`
  - `/etc/codex/managed_config.toml` with `[mcp_servers.etc_managed]`
  - `/etc/codex/requirements.toml` with `allowed_approval_policies = ["untrusted","on-request"]`
- Under strace (`openat/stat/statx/...`), codex opened all three files. It also probed `/etc/codex/{agents,rules,skills,hooks.json}`, `$CODEX_HOME/AGENTS{,.override}.md`, `<cwd>/AGENTS{,.override}.md`, `<cwd>/.codex`, `<cwd>/.agents/skills` and `$HOME/.agents{,/skills}`. No `/root/.codex` was touched.
- `config/read` layers, in precedence order: `legacyManagedConfigTomlFromFile (/etc/codex/managed_config.toml)` > `user` > `system (/etc/codex/config.toml)`.
- Both `etc_system` and `etc_managed` spawned and were declared to the model.
- `configRequirements/read` returned `allowedApprovalPolicies: ["untrusted","on-request"]`.
- `thread/start {approvalPolicy:"never"}` **succeeded** but returned `approvalPolicy: "untrusted"` plus a `warning` notification: *"Configured value for `approval_policy` is disallowed by requirements; falling back to required value UnlessTrusted. ... (set by /etc/codex/requirements.toml)"*. This is a silent semantic change, not an error.
- `config: {mcp_servers: {etc_system: {enabled:false}, etc_managed: {enabled:false}}}` disabled both. The session layer overrides even the legacy managed file.
- No managed-config environment variable exists in 0.149.1. The binary strings contain only `CODEX_MANAGED_BY_{NPM,PNPM,BUN}` and `CODEX_MANAGED_PACKAGE_ROOT`, which are install hints. Managed config is file-based: `/etc/codex/managed_config.toml` and `/etc/codex/requirements.toml`, plus MDM on macOS.

## (c) Sandbox: `probe-c-sandbox.mjs`, `probe-c0-toollist.mjs`

### Unattended workspaceWrite

- Thread: `{approvalPolicy:"never"}`. The thread result shows `readOnly`, then the turn overrides it.
- `turn/start` as sent, matching the 0.149.1 schema exactly: `{"threadId":…,"approvalPolicy":"never","sandboxPolicy":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeSlashTmp":true,"excludeTmpdirEnvVar":false}}`.
- `TMPDIR` is a private dir, `HOME` is synthetic, and every command is one `exec_command`.

| Action | control (danger-full-access) | **workspaceWrite** | symlinked cwd |
|---|---|---|---|
| write `./cwd-write.txt` | OK | **OK** | **OK**: file is in the real dir; `pwd -P` = real path |
| write `$TMPDIR/…` | OK | **OK** | OK |
| write `/tmp/codex-probe-elsewhere-*.txt` | OK | **FAIL** `Read-only file system` | FAIL |
| write `$HOME/home-write.txt` | OK | **FAIL** `Read-only file system` | FAIL |
| `cat /etc/hostname` | OK | **OK** | OK |
| `curl https://example.com` (via `HTTPS_PROXY=127.0.0.1:39281`) | 200 | **FAIL** `curl: (7) Failed to connect to 127.0.0.1 port 39281` | FAIL |
| `curl --noproxy '*' https://example.com` | 200 | **FAIL** `curl: (6) Could not resolve host` | FAIL |
| `node fetch('https://example.com')` | 200 | **FAIL** `EPERM` (seccomp) | FAIL |
| `curl http://127.0.0.1:<fake>/v1/models` | 200 | **FAIL** (7), loopback isolated | FAIL |
| env / status | `NoNewPrivs 0, Seccomp 0` | `CODEX_SANDBOX_NETWORK_DISABLED=1`, `NoNewPrivs 1`, `Seccomp 2`, `pid1=codex` (own PID namespace) | same |
| `exec_command {sandbox_permissions:"require_escalated"}` writing `/tmp/…` | n/a | **refused**. The model sees: *"approval policy is Never; reject command — you cannot ask for escalated permissions if the approval policy is Never"*. The file was not created. | n/a |

Inside the sandbox, `ls -la` of cwd shows read-only `.agents`, `.codex` and `.git` mounts (`dr-xr-xr-x`). Those mounts exist only inside the sandbox and are absent from the host directory. The agent cannot plant project config or hooks.

### Sandbox cannot initialize

- `/proc/sys/user/max_user_namespaces` is read-only even to root in this container (`EACCES`). To block user namespaces anyway, codex ran inside `unshare -Urmpf --kill-child --mount-proc sh -c 'echo 0 > /proc/sys/user/max_user_namespaces && exec "$@"'`. Inside that wrapper, `unshare -U true` fails with `No space left on device`.
- Every sandboxed command ended with `status: "failed"`, `exitCode: 1`, output `bwrap: Creating new namespace failed: nesting depth or /proc/sys/user/max_*_namespaces exceeded (ENOSPC)`. No target file was created. **This is fail-closed.**
- The same happened under `approvalPolicy: "on-request"` + `workspace-write`. No escalation or approval request was raised; the commands simply failed.
- A *failing `bwrap` placed first on PATH* is **not** a failure: codex emitted `configWarning: "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces."` and still ran commands sandboxed (RO filesystem, `pid1=codex`).

### Attended (`approvalPolicy:"untrusted"`, `approvalsReviewer:"user"`, `sandbox:"workspace-write"`, model `gpt-5.5`)

`probe-c0` showed that `apply_patch` is declared, as a `custom` tool with a grammar format, only for models the CLI knows (`gpt-5.5`, `gpt-5.2-codex`). It is not declared for `gpt-5-nano`, `gpt-5.3-codex` or `gpt-5.1-codex-max`.

All decisions were answered `accept`:

| Model action | Server request |
|---|---|
| `exec_command "echo hi > attended.txt"` | `item/commandExecution/requestApproval` (`command: "/bin/bash -lc 'echo hi > attended.txt'"`, `availableDecisions: ["accept",{acceptWithExecpolicyAmendment},"cancel"]`) |
| `exec_command "cat /etc/hostname"` | `item/commandExecution/requestApproval` |
| `exec_command "ls -la"` | `item/commandExecution/requestApproval` |
| `exec_command "apply_patch <<'EOF' … EOF"` | `item/fileChange/requestApproval` (`reason:null, grantRoot:null`), then a `fileChange` item that creates the file |
| `custom_tool_call apply_patch` (`*** Begin Patch / *** Add File`) | `item/fileChange/requestApproval`, then a `fileChange` item that creates the file |

Follow-up with `login:false`: `ls -la`, `cat /etc/hostname`, `pwd` and a write each raised `commandExecution/requestApproval`. So in 0.149.1, `untrusted` asked about every command in this setup. This contradicts the `toCodexPermissions` comment that read-only commands are auto-approved. Note that this ran as root.

## (d) Relay timeout and MCP approval gating: `probe-d-relay-timeout.mjs`

**Call form, which resolves the old spike's P1 gap.** The fake model emits a Responses `function_call` with `"namespace":"mcp__relay","name":"echo"`. codex dispatches it as an `mcpToolCall` item `{server:"relay", tool:"echo"}`, and the call reaches the stdio server. Namespaced MCP tools **are** model-callable through a fake provider.

**Gating** (tool `echo`, no annotations unless stated):

| approvalPolicy | relay server config | Outcome |
|---|---|---|
| never | none (what `codex-home.ts` renders) | **failed**: model sees *"MCP tool call requires approval, but approval policy is never"*. The server never saw `tools/call`. |
| never | tool `annotations.readOnlyHint: true` | completed |
| never | `default_tools_approval_mode = "approve"` | **completed** |
| never | `= "auto"` / `= "writes"` | failed (same message) |
| never | `= "prompt"` + readOnlyHint | failed |
| untrusted / on-request | none | `mcpServer/elicitation/request` with `serverName:"relay"`, `mode:"form"`, `_meta.codex_approval_kind:"mcp_tool_call"`, `message:"Allow the relay MCP server to run tool \"echo\"?"`. On `{action:"accept"}` the call completes. |
| untrusted | none, answered `{action:"decline"}` | failed: *"user rejected MCP tool call"*. The server never saw the call. |
| untrusted | `default_tools_approval_mode = "approve"` | completed, **no** server request |

`AppToolApproval` enum (generated schema): `auto | prompt | writes | approve`.

**Timeouts** (`slow_echo` sleeps N s; `default_tools_approval_mode="approve"` so the call is not gated):

| `tool_timeout_sec` | Tool | Outcome |
|---|---|---|
| 5 | sleeps 15 s | `mcpToolCall status:"failed"`, `durationMs:5010`. Model sees *"tool call error: tool call failed for `relay/slow_echo`\n\nCaused by:\n    timed out awaiting tools/call after 5s\n\nStack backtrace: 0: <unknown> …"*. codex sends **no `notifications/cancelled`**; the server keeps running the call until teardown. |
| 3600 | sleeps 70 s | `completed`, `durationMs:70059`. Model sees `slow_echo: hi (after 70058 ms)`. |
| omitted (default) | sleeps 70 s | completed (70 072 ms) |
| omitted (default) | sleeps 900 s | **failed at 300 010 ms**: *"timed out awaiting tools/call after 300s"*. **The default is 300 s.** |
| **0** | `echo` (instant) | **failed in 8 ms**: *"timed out awaiting tools/call after 0ns"*. The server never logged the call. |
| **0** | sleeps 2 s | failed in 8 ms, `after 0ns` |

In 0.149.1, `0` means "time out immediately", not "no timeout".

## (e) Processes: `probe-e-processes.mjs`

**Method.**
- The app-server runs `detached`, so the node wrapper is the leader of its own process group and session (pgid = sid = wrapper pid). The native `codex` is in the same group.
- Approval policy is `never`. The model runs five commands, one `exec_command` each:
  - `sleep N1 &`
  - `sleep N2 >/dev/null 2>&1 &`
  - `setsid sleep N3 >/dev/null 2>&1 &`
  - `nohup sleep N4 >/dev/null 2>&1 &`
  - `(sleep N5 >/dev/null 2>&1 &)`
- A sixth command runs `ps` mid-turn.
- After `turn/completed`, the supervisor kill is either `kill(-pgid, SIGTERM)`, 3 s wait, `kill(-pgid, SIGKILL)`, or an immediate `kill(-pgid, SIGKILL)`. `ps -eo pid,ppid,pgid,sid,stat,cmd` runs 2 s later.

| Sandbox / kill | Alive mid-turn and before kill | After kill | App-server exit |
|---|---|---|---|
| danger-full-access, TERM→KILL | only `sleep 3103` (setsid): `pid=22077 ppid=1 pgid=22077 sid=22077` | **`sleep 3103` survives** (own session, reparented to init) | `code 0`; exited gracefully, SIGKILL not needed (`ESRCH`) |
| danger-full-access, KILL | only setsid `sleep 3203` (`ppid=1 pgid=sid=22487`) | **survives** | `signal SIGKILL` |
| workspace-write, TERM→KILL | none | none | code 0 |
| workspace-write, KILL | none | none | SIGKILL |

- Plain `&`, `nohup` and the double-fork were already gone when the next command ran. codex kills each command's process group when the command ends.
- Under bwrap the PID namespace takes everything, `setsid` included.
- No probe process is left. Every `sleep 3xxx` was killed and verified (`cleanupRemaining: 0`).

## (f) Checksum source: `probe-f-checksums.mjs` → `codex-vendor-checksums.json`

For each `@openai/codex@0.149.1-<platform>`, the probe:
1. ran `npm view … dist --json` and `npm pack`;
2. compared the tarball's sha512 SRI against `dist.integrity`, and its sha1 against `dist.shasum`. **All 6 match** (the 5 requested plus `win32-arm64`);
3. extracted it, recorded sha256 of the specified files, and deleted the tarball.

The registry also publishes two ECDSA `signatures` (keyid `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U`) and an SLSA v1 provenance attestation. `npm audit signatures` on the install reports *"2 packages have verified registry signatures, 2 packages have verified attestations"*. The installed linux-x64 `codex` sha256 `73dc5888…23ba` equals the tarball's.

| target | triple | integrity | `bin/codex[.exe]` sha256 |
|---|---|---|---|
| darwin-arm64 | aarch64-apple-darwin | `sha512-6X84kTCb…kmA1qw==` | `f0d87622…d250fb6c` |
| darwin-x64 | x86_64-apple-darwin | `sha512-MfLBQLfc…Vs6g4A==` | `19ad0791…2f5d7a06` |
| linux-x64 | x86_64-unknown-linux-musl | `sha512-Of5fGYgr…KZggQ==` | `73dc5888…61e823ba` |
| linux-arm64 | aarch64-unknown-linux-musl | `sha512-OqxUfZ1T…pBW/mQ==` | `2447e3fe…f9c20d8` |
| win32-x64 | x86_64-pc-windows-msvc | `sha512-G3QXGAg7…ADBQUQ==` | `a395030b…cf490ebe6` |

Full hashes, including `codex-code-mode-host`, `codex-path/rg` and linux `codex-resources/bwrap`, are in `codex-vendor-checksums.json`.

**Files outside the specified set:**
- Every platform ships `vendor/<triple>/codex-resources/zsh/bin/zsh`.
- win32 also ships `codex-resources/codex-command-runner.exe` and `codex-windows-sandbox-setup.exe`.
- None of these is in the specified `files` set. `codex-vendor-all-files.json` hashes every file in every tarball, in case the pack build vendors the whole `vendor/<triple>/` tree.

---

## What this means for the product (read-only observations; nothing was changed)

1. **`codex-home.ts` renders `tool_timeout_sec = 0` for the relay, not 3600.** In 0.149.1, 0 makes every relay call fail instantly (*"timed out awaiting tools/call after 0ns"*). The default is 300 s, which is too short for a human approval. 3600 is verified to hold a 70 s call.
2. **Relay calls are also gated by codex's own MCP approval.**
   - Allow-all (`never`): every call is refused.
   - Allow-reads/edits (`untrusted`): codex sends `mcpServer/elicitation/request` (`codex_approval_kind: "mcp_tool_call"`), which `approval-controller.ts` `handleElicitation()` always declines, so every call is rejected.
   - Setting `default_tools_approval_mode = "approve"` on the relay's `[mcp_servers.*]` makes calls run with no codex-side prompt under both policies (verified). That leaves the host-side gate as the single authority.
   - The old spike's claims are wrong for 0.149.1: "no server request exists for an MCP tools/call", and "call form not reproducible locally".
3. `OPENAI_BASE_URL` / `base_url` must include `/v1` against the hosted proxy, and must be the bare origin against the local gateway (see (a)).
4. Repo content reaches the model even in an untrusted project: AGENTS.md always, and skills from `.agents/skills`. `project_doc_max_bytes: 0` suppresses AGENTS.md. Project MCP servers load only if the project is trusted. If one is trusted, `{enabled:false}` per server works, because thread config merges rather than replaces.
5. A box image with `/etc/codex/*` changes codex silently: extra MCP servers, and an approval policy downgraded with only a warning.
6. Set `[features] plugins = false` to stop startup egress to github.com, api.github.com and chatgpt.com, and the 100 MB clone into CODEX_HOME.
7. Under allow-all (`danger-full-access`), the agent can leave `setsid` daemons that outlive app-server teardown. Only killing the sandbox, or running under workspace-write, contains them.

## Reproduce

```sh
cd .spike-codex-appserver/probe/2026-10-02-linux
npm install --ignore-scripts @openai/codex@0.149.1
node probe-a-url-shape.mjs
node probe-a2-egress.mjs
node probe-a3-plugin-sync.mjs
node probe-b-config-layers.mjs [scenario…]
sudo node probe-b4-system-layers.mjs   # plants and removes /etc/codex; refuses if it already exists
node probe-c0-toollist.mjs
node probe-c-sandbox.mjs [control ws ws-symlink fail-pathbwrap fail-userns fail-userns-attended attended attended-login-false]
node probe-d-relay-timeout.mjs [callform gate-* t5-sleep15 t3600-sleep70 t0-instant t0-sleep2 default-sleep70 default-find]
node probe-e-processes.mjs [danger-termkill danger-kill ws-termkill ws-kill]
node probe-f-checksums.mjs
```

`lib.mjs` holds the shared rig: the fake server, the app-server client with `detached` support, and fresh-dir helpers. `mcp-server.mjs` is the spawn-logging stdio MCP server, with `echo` and `slow_echo` and optional `MCP_ANNOTATE`. `schema-gen/` is `codex app-server generate-json-schema` output from this binary.
