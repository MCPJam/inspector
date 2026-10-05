# Local Claude Code

On Node/npx and Electron, an authorized Claude Code client executes locally when
a verified pack and platform conformance are pinned, the account rollout is on,
and the operator kill switch permits it. Otherwise existing clients retain cloud
execution. Hosted Inspector continues to use cloud execution. Set
`MCPJAM_LOCAL_HARNESS_ENABLED=false` to disable selection of local execution.

## Setup and normal use

Add client → Claude Code → Create starts installation and records authorization
for the signed-in member, machine and project. The dialog explains that the
client runs with the operator’s OS-user permissions, and evals and swarms run
commands without approval prompts. Installation is a
background operation with status polling; failed downloads have an explicit
retry. A verified installation is reused across clients and projects.

The default is a private per-project workspace; the npx launch directory is never
silently authorized. An explicitly selected workspace can be used instead. The
protected authorization record survives restarts. Browser storage caches setup
status, without a live execution credential; the server issues credentials. Reopening Inspector, switching surfaces, and credential expiry do not
require another consent action. Membership, rollout, policy and verified runtime
identity are rechecked before issuing fresh credentials. Explicit Forget revokes
the durable authorization and project grants, and stops its running sessions.

Playground uses normal Send, streaming, approval and Stop controls. Stop ends the
turn and retains the saved conversation. The next turn resumes the disk session
without reconnecting to a stopped bridge. Missing state follows the existing
new-session recovery path. A local execution failure never silently selects a
cloud target.

Evals and swarms use the same harness turn executor, adapter, model broker,
MCP bridge, cancellation and result contracts. Each unattended session receives a
private scratch folder and a server-issued unattended grant. Local schedulers
share two execution slots. Git 2.31 or newer is required for unattended execution;
system Git configuration, hooks and credential helpers are disabled in those
sessions. Cleanup proves the process stopped before deleting its workspace.
Startup reclaims provably abandoned process trees, expires grants, and removes
recorded scratch workspaces only after both their owner and child tree are gone.

Local Claude Code does not support cloud computer images, seeded eval attachments,
or injected browser/desktop/bash tools. Such configurations fail explicitly.
Claude's own file and command tools remain available. A scratch folder is an
organizational boundary, not OS containment: the process runs as the operator's
OS user. Interactive chats keep the runtime's approval mode. Tool Approval on
asks before commands and changes; Off pre-approves native requests after a
separate confirmation for this user, machine, project and harness. Unattended evals and
swarms use the approved unattended command profile. Session homes and scratch
folders are outside the control store, which Claude settings deny for file tools.
This is defense in depth: OS-user commands can still access the user’s files.

## MCP servers, skills and secrets

Only the MCP servers selected by MCPJam are passed to the SDK. The patched
bootstrap sets `strictMcpConfig: true`, so project and user MCP configuration do
not add servers. The working folder's `.mcp.json` remains untouched.

Local MCP requests go through a turn-scoped loopback listener with a random
capability, selected-server restrictions, browser-origin rejection and the same
tool-policy enforcement used by hosted execution. Closing the turn closes the
listener. Eval capture uses the existing evidence start/settle protocol and the
run's frozen grading decision: failure to record a start prevents the tool side
effect. A signed-in member can submit evidence only for their own authorized run.

Skills are materialized in the session's synthetic home. Materialized secrets
are delivered through the validated local environment; brokered secrets and
runtime-conflicting variables are refused. Model access remains brokered through
a registered machine key. Local eval and swarm leases bind to the live owned
run and pinned harness/model, and are rechecked for new generations.

## Local Codex

Codex runs locally on the same terms as Claude Code: a verified pack and
platform conformance, its own account rollout, and the operator kill switch.
Each harness is installed, rolled out and authorized separately. Add client →
Codex → Create installs Codex's pack and records authorization for Codex only;
authorizing one harness never authorizes the other. Forget revokes every local
harness for the project.

Codex runs as the pinned `@openai/codex` CLI behind MCPJam's app-server bridge,
under a private per-session `CODEX_HOME`. It never reads the operator's
`~/.codex`, ChatGPT login or OpenAI key. Inference goes through the MCPJam model
broker on the registered machine key, exactly as hosted Codex does. MCP servers
selected by MCPJam reach Codex through the turn-scoped host-tool relay; Codex's
own MCP configuration, plugins and web search stay off. Because the host runs
those tool calls, eval grading for local Codex reads the run's transcript
rather than the local evidence protocol.

Interactive chats are attended. With Tool Approval on, Codex's command and file-change approvals show
as the normal approval cards, and the answer goes back to the same live Codex
process, so a turn waiting on an approval keeps its process until it is
answered, stopped or expired. Stop interrupts the turn; the next turn resumes
the saved thread. Off requires separate confirmation and pre-approves new native
requests while preserving the thread. Flipping the toggle does not answer an
approval already waiting; the user's explicit decision still controls it.

Unattended evals and swarms run Codex commands without approval prompts only
inside Codex's command sandbox: writes are limited to the run's scratch folder
and its temporary folder, `/tmp` is excluded, and commands get no network. A
platform is eligible for unattended local Codex only once that sandbox has
conformance evidence on it; until then, evals and swarms with a Codex host run
in the cloud.

When it launches a local eval, quick run or swarm, the Inspector declares
`local-harness:<id>` for each harness this machine can run unattended for the
project, and the backend runs exactly those harnesses locally and the rest in
the cloud. An older Inspector declares none and keeps its Claude Code-only
behavior. Pinned computer images, seeded eval attachments and injected
browser/desktop/bash tools are refused for local Codex, as for Claude Code.

## Runtime distribution

The runtime is versioned independently of Inspector, and each harness's pack is
versioned independently of every other harness's. Each supported OS/architecture
gets its own archive, manifest, signature and digest under an immutable release
tag: `local-harness-pack-v<version>` for Claude Code (the names its first pack
shipped under) and `local-harness-pack-<harness>-v<version>` for every other
harness, whose asset names also carry the harness id. Inspector downloads and
verifies the expected pack for each harness (`EXPECTED_PACK_VERSIONS` in
`pack-digests.generated.ts`); it never builds or installs a vendor runtime from
a mutable dependency range on the user's machine. Electron reads the bootstrap
from the verified pack and does not require an unpackaged `node_modules` tree.

Each harness's pack installs under its own root (Claude Code keeps
`<runtime>/<target>/<version>`; other harnesses use
`<runtime>/<harness>/<target>/<version>`), so packs with the same version number
never replace each other.

Toolchain versions are pinned in `scripts/local-harness-toolchain.json`.
`scripts/check-local-harness-inputs.mjs` fingerprints each harness's pack
separately. A harness's fingerprint covers its recipe module
(`scripts/local-harness-pack-recipes/<harness>.mjs`), the sources the recipe
declares, the locked dependency closure of its declared roots (not unrelated
lockfile entries) and the recipe bytes it emits — plus the shared build
machinery every pack uses (the build script, the recipe loader, the workflow,
toolchain pins, the loopback launcher, the tree-digest module and the Job Object
launcher). A change only one harness reads moves only that harness's
fingerprint; a change to shared machinery moves every harness's, and each
affected pack must then be re-published. After intentionally changing those
inputs, regenerate and review the snapshot:

```sh
node scripts/check-local-harness-inputs.mjs --write
```

`--write` refuses to record a snapshot from a tree that is not the locked one:
a package in any harness's dependency closure installed at a version other than
`package-lock.json` names (or missing, unless the lock marks it optional), or
any `@ai-sdk/harness*` package or closure package that is a symlink. Those are
the two ways a wrong snapshot has been written; run `npm ci --legacy-peer-deps`
from the repo root and unlink any linked adapter first.

PR builds verify the snapshot but not the published packs: packs publish only
from main, so `check-local-harness-release.mjs --assets` runs before a release
is versioned (`prepare-release.yml`) and before it publishes (`release.yml`).

To publish, dispatch `local-harness-pack.yml` with `harness` and a new
`pack_version`, then record the digests for that harness only:

```sh
node scripts/write-pack-digests.mjs --harness <harness> --version <version> \
  --digests '<flat digest map printed by the workflow>'
```

Publish a new pack rather than replacing an existing tag. The pack workflow
requires main, a new independent semver and the signing secret from the
`local-harness-pack-release` GitHub Environment. Before first publication, an
administrator must restrict that environment to main with reviewer approval, set
`PROTECTED_LOCAL_HARNESS_PACK_SIGNING_KEY` there, and remove the old repository
signing secret. Apply the tag ruleset and enable immutable releases as well. It refuses any
existing tag or release. The repository ruleset template in
`.github/rulesets/local-harness-pack-tags.json` additionally protects tags from
update/deletion when applied by repository administration.

Inspector release preflight checks the already-published signed assets against
its committed expected digests and fingerprint, for exactly the targets each
harness advertises (`nativeTargets`, when a harness certifies per architecture),
and checks that each published pack carries the bridge this checkout builds. It
does not rebuild the runtime. An Inspector version bump alone does not require a
new runtime version.

To install a pack from the command line, `mcpjam-inspector harness install`
(or `status`) takes `--harness <id>`; without it, it means Claude Code.

### Codex pack

Codex's pack (`--harness codex`) carries MCPJam's app-server bridge and
host-tool MCP relay — rebuilt from source by the recipe, never taken from a
generated file on disk — and the pinned `@openai/codex` wrapper plus exactly
one platform package, every file of which is checked against
`scripts/local-harness-pack-recipes/codex-vendor-checksums.json` (recorded
from the published tarballs). A pack is built on the target it is for.

**Any change under `server/utils/harness/codex-appserver/` that reaches the
bridge bundle needs a Codex pack bump, and the data PR recording its digests,
before it ships to local users.** A local session byte-compares the pack's
`bridge.mjs` with the bridge the Inspector carries and refuses to start on a
mismatch, so an unbumped bridge change would fail every local Codex session.
The fingerprint makes such a change visible (the bridge sources, the bundler,
the bootstrap package and lockfile, and the `@ai-sdk/harness` and `esbuild`
closures are all inputs), and release preflight blocks on a published
`bridgeDigest` that differs from this checkout's.

## Validation and activation

The conformance workflow builds and runs the native runtime on macOS arm64/x64,
Linux arm64/x64, and Windows x64, and Codex's own legs on the four POSIX
targets (the certified ones block; see the conformance README). It exercises process lifecycle, cancellation,
workspace access, skills, secrets, selected MCP delivery, exclusion of a real
planted project MCP server, and resume after Stop. The upstream model is mocked;
the vendor CLI, bridge and supervisor are real. For release evidence, dispatch
with `published_pack_version` after committing the reviewed digest records. This
mode downloads and verifies the signed published archive and runs those exact
bytes instead of a separately built pack.

Passing unit tests or a local macOS smoke test does not establish support for all
platforms. The expected pack digest table and lifecycle conformance record remain
the release gate. An empty table deliberately keeps public installation dark.
Activation requires published signed assets, matching committed digests, passing
platform evidence, the matching backend deployment, and enabling the account
rollout. Never synthesize conformance evidence or enable the flag to bypass a
missing pack.
