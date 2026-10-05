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

A local runtime has two halves, and they come from the only two trusted sources
(invariant 1 in `server/utils/harness/local/README.md`):

- **The vendor pack**: `bin/node`, the vendor CLI/SDK and its platform binary,
  and on Windows the Job Object launcher. It is versioned independently of
  Inspector, each harness's pack independently of every other harness's, and
  each supported OS/architecture gets its own archive, manifest, signature and
  digest under an immutable release tag: `local-harness-pack-v<version>` for
  Claude Code (the names its first pack shipped under) and
  `local-harness-pack-<harness>-v<version>` for every other harness.
- **The Inspector layer**: MCPJam's bridge, its loopback launcher and (for Codex)
  the host-tools MCP entrypoint. It ships inside the Inspector, is written at run
  time to a content-addressed, read-only directory
  (`<runtime root>/inspector-layer/<digest>/`), sits outside every session root
  and in every session's denied roots, and is re-hashed against the digest
  compiled into the Inspector before every exec. A bridge change is therefore an
  ordinary Inspector change: it needs no new pack.

Both harnesses are split this way. Claude Code's layer bridge is the adapter's
bridge as the application patches it, bundled with the MCP SDK, `zod` and `ws`
compiled in; its one external import, `@anthropic-ai/claude-agent-sdk` (which
shares a version with its native CLI), stays in the pack, and the layer's
launcher resolves it there with a `module.registerHooks` hook. An adapter bump
therefore ships as an Inspector change unless it moves the agent SDK version.

Each harness's pack installs under its own root (Claude Code keeps
`<runtime>/<target>/<version>`; other harnesses use
`<runtime>/<harness>/<target>/<version>`), so packs with the same version number
never replace each other.

Which packs a build may run is the generated record
`server/utils/harness/local/runtime-compat.generated.json`: per harness and pack
target, the **desired** pack and at most one **permitted** previous pack the
build was tested against, plus the conformance stamp the pin rests on (it
replaces the `lifecycleConformanceVersion` that used to be typed into
`compatibility.ts`). `pack-digests.generated.ts` and `compatibility.ts` read it.
Inspector never builds or installs a vendor runtime from a mutable dependency
range on the user's machine. Electron reads the bootstrap from the verified pack
Electron builds a local session's bootstrap recipe from constants compiled into
the Inspector layer, and does not require an unpackaged `node_modules` tree.

Toolchain versions are pinned in `scripts/local-harness-toolchain.json`.
`scripts/check-local-harness-inputs.mjs` fingerprints each harness's pack
separately. A harness's fingerprint covers its recipe module
(`scripts/local-harness-pack-recipes/<harness>.mjs`), the sources the recipe
declares, the locked dependency closure of its declared roots (not unrelated
lockfile entries) and the recipe bytes it emits — plus the shared build
machinery every pack uses (the build script, the recipe loader, the workflow,
toolchain pins, the tree-digest module and the Job Object launcher). A change
only one harness reads moves only that harness's fingerprint; a change to
shared machinery moves every harness's, and each affected pack must then be
re-published. After intentionally changing those inputs, regenerate and review
the snapshot:

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
`pack_version`, then pin it for that harness only:

```sh
node scripts/write-pack-digests.mjs --harness <harness> --version <version> \
  --digests '<flat digest map printed by the workflow>' \
  [--permit-previous] [--conformance <stamp> --evidence <run url>]
```

`--permit-previous` keeps the pack being replaced selectable as the one
permitted previous pack; pass it only once conformance has passed for this
build's layer against both packs. Without it the previous pack is no longer
selectable.

Publish a new pack rather than replacing an existing tag. The pack workflow
requires main, a new independent semver and the signing secret from the
`local-harness-pack-release` GitHub Environment. Before first publication, an
administrator must restrict that environment to main with reviewer approval, set
`PROTECTED_LOCAL_HARNESS_PACK_SIGNING_KEY` there, and remove the old repository
signing secret. Apply the tag ruleset and enable immutable releases as well. It refuses any
existing tag or release. The repository ruleset template in
`.github/rulesets/local-harness-pack-tags.json` additionally protects tags from
update/deletion when applied by repository administration.

Inspector release preflight checks the already-published signed assets of
every pack the build may select — desired and permitted — against the committed
record, for exactly the targets each harness advertises (`nativeTargets`, when
a harness certifies per architecture), and checks that the desired pack was
built from this checkout's reviewed inputs. It does not rebuild the runtime, and
it no longer compares a bridge inside the pack: the bridge is the Inspector
layer. An Inspector version bump alone does not require a new runtime version.

To install a pack from the command line, `mcpjam-inspector harness install`
(or `status`) takes `--harness <id>`; without it, it means Claude Code.

### Claude Code pack

Claude Code's pack (`--harness claude-code`) carries vendor bytes only:
`@anthropic-ai/claude-agent-sdk` and this target's platform package (its native
CLI is checked against the SDK's own `manifest.json` checksums), the SDK's
declared peers, `bin/node`, and on Windows the Job Object launcher. It is
installed from `scripts/local-harness-pack-recipes/claude-code-vendor/`, which is
the pack's only recipe input; the layer bundler refuses to build a bridge whose
adapter expects a different agent SDK than that directory pins.

### Codex pack

Codex's pack (`--harness codex`) carries vendor bytes only: the pinned
`@openai/codex` wrapper plus exactly one platform package, every file of which
is checked against `scripts/local-harness-pack-recipes/codex-vendor-checksums.json`
(recorded from the published tarballs), `bin/node`, and on Windows the Job
Object launcher. A pack is built on the target it is for.

MCPJam's app-server bridge and host-tool MCP relay are Codex's Inspector layer:
bundled from `server/utils/harness/codex-appserver/` with every dependency
(including `ws`) inlined, written next to the pack at run time, and launched by
the layer's launcher with the pack's Node. **A change under
`server/utils/harness/codex-appserver/` needs no Codex pack.** The bridge reads
Codex from the pack (`--vendor-dir`) and its own MCP entrypoint from the layer
(`--layer-dir`); a sandbox still passes one `--bootstrap-dir`. Only the vendor
graph — the bootstrap `package.json` and lockfile that pin `@openai/codex`, and
the recorded checksums — is a Codex pack input.

## Validation and activation

The conformance workflow builds and runs the native runtime on macOS arm64/x64,
Linux arm64/x64, and Windows x64, and Codex's own legs on the four POSIX
targets (the certified ones block; see the conformance README). It exercises process lifecycle, cancellation,
workspace access, skills, secrets, selected MCP delivery, exclusion of a real
planted project MCP server, and resume after Stop. The upstream model is mocked;
the vendor CLI, bridge and supervisor are real. With `published_pack_version`
(and `codex_published_pack_version`) it downloads and verifies the signed
published archive and runs this checkout's Inspector layer against those exact
bytes instead of a separately built pack.

On a pull request the workflow runs Linux x64 only, against the **pinned**
published packs: a bridge change is tested with the pack users already have, and
nothing has to be published for the PR to pass.

Every passing leg writes a conformance evidence record — this commit's layer
digest × the pack it ran × the target — and uploads it. A release runs the legs
against every pack it may select (desired, then permitted), and
`check-local-harness-release.mjs --evidence` refuses the release unless every
(harness × selected pack × advertised target) is covered at this commit's layer
digest. It then writes `runtime-contract.json` (the layer digests, the selected
packs and the run behind each), which the release attests with
`actions/attest-build-provenance` and attaches to the Inspector release.

Passing unit tests or a local macOS smoke test does not establish support for all
platforms. The compatibility record and the release contract remain the release
gate. An empty record deliberately keeps public installation dark.
Activation requires published signed assets, matching committed digests, passing
platform evidence, the matching backend deployment, and enabling the account
rollout. Never synthesize conformance evidence or enable the flag to bypass a
missing pack.
