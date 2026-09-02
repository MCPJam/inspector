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
| `group-settle.mts` | — | the group-member snapshot settles a tree whose root exited first |

## Running them

```bash
# from mcpjam-inspector/ — the worktree root breaks the @/shared alias
S=/tmp/local-harness-conformance
node scripts/build-local-harness-pack.mjs \
  --adapter-bridge node_modules/@ai-sdk/harness-claude-code/dist/bridge \
  --out "$S/runtime" --node-binary "$S/node/bin/node"

HOME="$S/home" CONFORMANCE_ROOT="$S" npx tsx \
  server/utils/harness/local/conformance/run-native-turn.ts full
HOME="$S/home" CONFORMANCE_ROOT="$S" npx tsx \
  server/utils/harness/local/conformance/run-native-turn.ts no-launcher
HOME="$S/home" CONFORMANCE_ROOT="$S" npx tsx \
  server/utils/harness/local/conformance/run-lifecycle.ts abort
```

`MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION` stamps the manifest these scripts
build; CI sets it to the job's own identifier so a recorded conformance version
always names the run that produced it.

## Platform coverage

Two facts are darwin-specific and need a `macos-latest` job: the `(node)`
command an exiting process reports, and the `ps -g` group probe. Everything
else is portable — the SDK ships linux binaries and nodejs.org ships linux
tarballs — so `ubuntu-latest` covers the rest.
