# Local harness conformance suite

Scenario scripts that exercise the real thing — a real runtime pack, the real
supervisor, the real bridge, the real vendor CLI — against a mock Anthropic
upstream behind a loopback gateway. They are the evidence behind
`lifecycleConformanceVersion` in `compatibility.ts`: a manifest with an empty
conformance version resolves as expired, so a platform is not native until
these have actually passed on it.

They are deliberately NOT vitest specs. Each one spawns process trees, aborts
them mid-turn, crashes a supervisor and reclaims its orphans, and asserts on
what survived — work that wants a process of its own, a scratch root, and an
isolated `HOME`, not a test runner's shared one.

## Scenarios

| Script | Argument | Asserts |
|---|---|---|
| `run-native-turn.ts` | `full` | a turn end to end: read tool, bash with approval, detach + resume continuity, stop; nothing left in the workspace, no surviving pids, empty registry |
| `run-native-turn.ts` | `no-launcher` | a pack without the loopback launcher is REFUSED — the exposure probe, not the launcher, is what enforces the guarantee |
| `run-lifecycle.ts` | `abort` | aborting mid-turn takes the vendor CLI down with the bridge, and removes the session state |
| `run-lifecycle.ts` | `orphan-a` / `orphan-b` | a tree orphaned by a crashed Inspector is reclaimed by the janitor on the next start |
| `timing-decomp.mts` | — | cost decomposition: bare bridge spawn, digest, session ready |
| `probe-timing.mts` | — | the exposure probe stays inside its budget on a machine with link-local addresses |
| `group-settle.mts` | — | the group-member snapshot settles a tree whose root exited first (takes an optional node path; defaults to the running one) |

## Running them

```bash
# from mcpjam-inspector/ — the worktree root breaks the @/shared alias
S=/tmp/local-harness-conformance
mkdir -p "$S/home" "$S/workspace" "$S/runtime"

# A real pack, not a fixture: these scenarios exist to prove the thing a user
# would install actually runs. `--node-tarball` takes an official nodejs.org
# archive, or a bare node binary for a local run.
node scripts/build-local-harness-pack.mjs \
  --platform "$(node -p 'process.platform + "-" + process.arch')" \
  --pack-version conformance \
  --node-tarball "$(command -v node)" \
  --out "$S/runtime-src" --skip-archive
# `rm -rf` first: `cp -R` of a directory ONTO an existing directory of the
# same name nests it (`runtime/claude-code/claude-code`), so re-running this
# block after a first run silently produces a layout no scenario can resolve.
rm -rf "$S/runtime/claude-code"
cp -R "$S/runtime-src/claude-code" "$S/runtime/claude-code"

for scenario in \
  "run-native-turn.ts full" \
  "run-native-turn.ts no-launcher" \
  "run-lifecycle.ts abort" \
  "run-lifecycle.ts orphan-a" \
  "run-lifecycle.ts orphan-b" \
  "probe-timing.mts" \
  "timing-decomp.mts" \
  "group-settle.mts"
do
  # UNQUOTED on purpose: the entries carry a script AND its argument, and
  # quoting makes `run-native-turn.ts full` one filename.
  HOME="$S/home" CONFORMANCE_ROOT="$S" MOCK_LATENCY_MS=50 npx tsx \
    server/utils/harness/local/conformance/$scenario \
    || { echo "FAILED: $scenario"; failed=1; }
done
# The loop swallowed every non-zero exit and returned success after printing
# `FAILED`, so the documented way to run this suite could not be used as its
# result.
exit "${failed:-0}"
```

Every scenario ASSERTS and exits non-zero on failure. That is the whole
contract: a run that prints a leaked credential, a surviving process or a
dirtied workspace and exits 0 would make a green conformance job evidence of
nothing. `orphan-a` is the one deliberate exception — it exits successfully
WITHOUT stopping its session, because the crash it simulates is the input to
`orphan-b`.

`MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION` stamps the manifest these scripts
build; CI sets it to the job's own identifier so a recorded conformance version
always names the run that produced it. In a non-hosted Inspector with
`ENVIRONMENT=dev`, the same variable also supplies missing Claude Code
conformance evidence to the normal local-turn availability check. Production
and hosted builds ignore that override; it never replaces recorded evidence.

`MOCK_LATENCY_MS` holds every mock upstream response for that many
milliseconds. CI sets it to 50 and a local run should too. An upstream that
answers instantly is not a neutral simplification: it hid a gateway defect
through four CI runs. The gateway destroyed its upstream request on the server
request's `close` event, which since node 16 fires when the request BODY
finishes uploading rather than when the client disconnects — so on this machine
the mock always answered first and the suite went green, while on a loaded
runner every call came back 502, the vendor CLI burned ten retries, and all
three turns finished empty after ~180s each. A conformance upstream faster than
everything it exercises can only ever agree with the code under test.

## Platform coverage

Two facts are darwin-specific and need a `macos-latest` job: the `(node)`
command an exiting process reports, and the `ps -g` group probe. Everything
else is portable — the SDK ships linux binaries and nodejs.org ships linux
tarballs — so `ubuntu-latest` covers the rest.

### Workspace delivery smoke check

After building the pack and preparing the isolated conformance home/runtime as
above, run `run-native-turn.ts delivery`. This uses the product Claude Code
adapter with session-config MCP delivery. It verifies a real MCP tool call,
a write in the granted workspace, a materialized test secret in Bash, a skill
under the synthetic home, and that an existing workspace `.mcp.json` remains
unchanged. That file names a live workspace-only MCP server, which must receive
zero TCP connections while the MCPJam-selected server executes its tool. The
bridge enforces `strictMcpConfig: true` for local and cloud sessions. It also runs the usual approval, resume, and teardown checks.
The upstream model and model gateway are deterministic local test servers;
this is not the signed-in Playground/broker billing check.

## Codex

`run-codex-turn.ts` drives local Codex the same way, against its own pack
(`build-local-harness-pack.mjs --harness codex`: MCPJam's app-server bridge,
the host-tool MCP relay, and the pinned `@openai/codex` platform package, every
file of which the build checks against `codex-vendor-checksums.json`). The
upstream is `mock-responses.mjs`, a deterministic OpenAI Responses server
behind the same `local-gateway.mjs`; it answers `SHELL <cmd>` with Codex's
`exec_command`, `MCPPROBE` with a call to the relay's `probe__echo`, and
`COUNT` with the user turns it can see.

| Argument | Asserts |
|---|---|
| `attended` | the Playground profile (`workspace-edits` → Codex `untrusted`): a command pauses for approval and runs only once approved, through the LIVE process; a host-executed MCP tool runs through MCPJam's relay with no second Codex prompt; the thread survives detach + resume; Stop leaves no process or registry record; no supervised listener off loopback; the upstream key never reaches a child's environment |
| `unattended` | the eval/swarm profile (`unrestricted` → `allow-all` inside the explicit D2 sandbox policy): no approval is asked; a command writes the run's folder and its private `$TMPDIR`; a write elsewhere under `/tmp` fails; the command has no network (loopback included); the MCP tool, which is not a command, still runs; plus every attended check that applies |

```bash
# from mcpjam-inspector/, with a pack built as above but with --harness codex
rm -rf "$CONFORMANCE_ROOT/runtime/codex"
cp -R "$CONFORMANCE_ROOT/runtime-src/codex" "$CONFORMANCE_ROOT/runtime/codex"
HOME="$CONFORMANCE_ROOT/home" CONFORMANCE_ROOT="$CONFORMANCE_ROOT" \
  npx tsx server/utils/harness/local/conformance/run-codex-turn.ts attended
HOME="$CONFORMANCE_ROOT/home" CONFORMANCE_ROOT="$CONFORMANCE_ROOT" \
  npx tsx server/utils/harness/local/conformance/run-codex-turn.ts unattended
```

In CI these are the `codex-scenarios` legs of `local-harness-conformance.yml`,
stamped separately (`codex_conformance_version`) so a Codex failure never
withholds Claude Code's version or the reverse. The certified targets
(`nativeTargets`: darwin-arm64, linux-x64) block; linux-arm64 and darwin-x64
run without blocking. The unattended leg is evidence, not yet a gate: a target
is added to `unattendedSandboxTargets` only after it passes there, and until
then unattended local Codex is refused on it. Ubuntu 24.04's AppArmor
user-namespace restriction can stop bubblewrap from starting at all — the
sandbox then fails closed, and this leg is how that shows up.

Both scenarios passed on a linux-x64 development container (root, kernel
6.18, the pinned 0.149.1 binary) against a pack built from this tree. That is
development evidence only; it is not a CI leg, not a non-root run, and says
nothing about macOS.
