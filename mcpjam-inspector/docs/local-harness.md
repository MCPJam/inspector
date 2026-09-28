# Local Claude Code

On Node/npx and Electron, a Claude Code client executes on the machine running
Inspector. Hosted Inspector continues to use the cloud execution path. Local
availability is controlled by the `local-harness-enabled` account rollout and
`MCPJAM_LOCAL_HARNESS_ENABLED=false` operator kill switch.

## Setup and normal use

Add client → Claude Code → Create starts installation and records authorization
for the signed-in member, machine and project. The dialog explains that the
client can run local commands in chats, evals and swarms. Installation is a
background operation with status polling; failed downloads have an explicit
retry. A verified installation is reused across clients and projects.

The server chooses the launch folder when available, otherwise a managed
project folder. Its protected authorization record survives restarts. Browser
storage caches a short-lived execution credential; it is not the authorization
source. Reopening Inspector, switching surfaces, and credential expiry do not
require another consent action. Membership, rollout, policy and verified runtime
identity are rechecked before issuing fresh credentials. Explicit Forget revokes
the durable authorization.

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

Local Claude Code does not support cloud computer images, seeded eval attachments,
or injected browser/desktop/bash tools. Such configurations fail explicitly.
Claude's own file and command tools remain available. A scratch folder is an
organizational boundary, not OS containment: the process runs as the operator's
OS user. Interactive chats use workspace-edit permissions; unattended evals and
swarms use the approved unattended command profile.

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

## Runtime distribution

The runtime is versioned independently of Inspector. Each supported OS/architecture
gets its own archive, manifest, signature and digest under the immutable release
tag `local-harness-pack-v<version>`. Inspector downloads and verifies the expected
pack; it never builds or installs the vendor runtime from a mutable dependency
range on the user's machine. Electron reads the bootstrap from the verified pack
and does not require an unpackaged `node_modules` tree.

Toolchain versions are pinned in `scripts/local-harness-toolchain.json`.
`scripts/check-local-harness-inputs.mjs` fingerprints the dependency lock, patched
bootstrap recipe, launcher and build inputs. After intentionally changing those
inputs, regenerate and review the snapshot:

```sh
node scripts/check-local-harness-inputs.mjs --write
```

Publish a new pack rather than replacing an existing tag. The pack workflow
requires main, a new independent semver and the signing secret. It refuses any
existing tag or release. The repository ruleset template in
`.github/rulesets/local-harness-pack-tags.json` additionally protects tags from
update/deletion when applied by repository administration.

Inspector release preflight checks the already-published signed assets against
its committed expected digests and fingerprint. It does not rebuild the runtime.
An Inspector version bump alone does not require a new runtime version.

## Validation and activation

The conformance workflow builds and runs the native runtime on macOS arm64/x64,
Linux arm64/x64, and Windows x64. It exercises process lifecycle, cancellation,
workspace access, skills, secrets, selected MCP delivery, exclusion of a real
planted project MCP server, and resume after Stop. The upstream model is mocked;
the vendor CLI, bridge and supervisor are real.

Passing unit tests or a local macOS smoke test does not establish support for all
platforms. The expected pack digest table and lifecycle conformance record remain
the release gate. An empty table deliberately keeps public installation dark.
Activation requires published signed assets, matching committed digests, passing
platform evidence, the matching backend deployment, and enabling the account
rollout. Never synthesize conformance evidence or enable the flag to bypass a
missing pack.
