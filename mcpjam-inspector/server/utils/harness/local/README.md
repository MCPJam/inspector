# Local AI SDK harness execution

Running an official vendor harness (Claude Code, Codex) as a **supervised
process on the user's own machine**, without Docker, and without claiming a
containment boundary that does not exist.

This directory is the foundation: target types, the reviewed compatibility
manifest, runtime identity, consent, the supervisor, and the AI SDK provider
that sits on top of them. It is gated off by default and is not yet wired into
the turn path — see [What is not here yet](#what-is-not-here-yet).

## The one thing to keep straight

`local-native` is **not a sandbox**. A supervised vendor process runs with the
operating-system user's authority. What bounds it is:

- the vendor harness's own permission and approval controls,
- an explicit consent grant the user saw the terms of,
- process supervision (what Inspector starts, and what it can stop),
- the workspace the user selected.

An allowlisted environment, a synthetic `$HOME`, owner-only state directories,
and a confined Inspector file API all reduce accidents. **None of them contains
a process running as the same OS user.** Product copy, telemetry, audit records,
and code comments must all say so; `targetHasHostContainment()` is the single
predicate everything agrees on, and `executionTargetLabel()` is the only place
a mode gets a user-facing name.

## Guarantee matrix

| Property                      | Hosted (E2B)      | Local native                     | Local isolated                         |
| ----------------------------- | ----------------- | -------------------------------- | -------------------------------------- |
| Runs on the user's machine    | No                | Yes                              | Yes                                    |
| Outer host containment        | Cloud sandbox     | **No**                           | Backend-dependent, verified            |
| Vendor permission controls    | Adapter-dependent | Required                         | Required where compatible              |
| Inspector process supervision | Cloud provider    | Required                         | Required                               |
| Workspace path restriction    | Cloud mount       | Inspector file API + policy only | OS/backend enforced                    |
| Network restriction           | Cloud policy      | **No Inspector guarantee**       | Backend policy + gateway allowlist     |
| Hard CPU/memory quota         | Cloud policy      | Best effort                      | Required where advertised              |
| Suitable for unattended work  | Yes               | **No**                           | Only after a separate product decision |

Per platform, for `local-native`:

| Platform | Native offered | Why                                                                                                                                                                                          |
| -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| linux    | Yes            | POSIX process groups; `/proc/<pid>/stat` gives an exact process birth identity                                                                                                               |
| darwin   | Yes            | POSIX process groups; `ps -o lstart=` gives a second-granular birth identity                                                                                                                 |
| win32    | **No**         | No process-group primitive here, and no Job Object implementation yet, so whole-tree cleanup cannot be guaranteed — and Job Objects would not be filesystem or network isolation in any case |

Per harness:

| Harness     | Native                   | Why                                                                                                                                                                                                                                               |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude-code | Eligible (darwin, linux) | `@ai-sdk/harness-claude-code@1.0.100` declares `supportsBuiltinToolApprovals: true` and maps `allow-reads`/`allow-edits` onto real approval callbacks                                                                                             |
| codex       | **Never**                | `@ai-sdk/harness-codex@1.0.98` declares `supportsBuiltinToolApprovals: false` and rejects every mode but `allow-all`, starting Codex unrestricted. That is safe only when the sandbox provider IS the boundary. Hosted or verified-isolated only. |
| cursor      | Not supported            | No AI SDK adapter to pin or audit                                                                                                                                                                                                                 |

`isolatedBackends` is empty for every harness: no backend has passed escape
probes yet, so isolated mode cannot be selected. **Isolated never falls back to
native.**

## Module map

| Module                   | Responsibility                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `targets.ts`             | The three execution targets, permission profiles, policy versions, and the honesty predicates                                |
| `compatibility.ts`       | The Inspector-owned manifest. An adapter cannot self-assert local compatibility                                              |
| `argv-policy.ts`         | Structural + capability checks on every argument the supervisor passes                                                       |
| `command-translation.ts` | The closed adapter command grammar → structured operations. **No shell, ever**                                               |
| `runtime-identity.ts`    | Managed-bundle tree digests, system-install discovery, and re-verification before spawn                                      |
| `grants.ts`              | Workspace grants (opaque ids → canonical paths) and the local harness consent capability                                     |
| `confine.ts`             | Symlink-aware confinement for the Inspector file API                                                                         |
| `session-env.ts`         | Allowlisted child environment and synthetic `$HOME`                                                                          |
| `node-launcher.ts`       | Which absolute Node binary launches the bridge                                                                               |
| `process-identity.ts`    | Process birth identity and whole-tree termination                                                                            |
| `process-registry.ts`    | The durable owned-process record and the crash-recovery janitor                                                              |
| `supervisor.ts`          | The only process owner                                                                                                       |
| `bridge-endpoint.ts`     | Loopback URLs, and the probe that proves the bridge is loopback-only                                                         |
| `supervised-provider.ts` | `HarnessV1SandboxProvider` over the supervisor (stable contract: required `getPortEndpoint` and `destroy`, no `bridgePorts`) |
| `availability.ts`        | The single chokepoint: kill switch → actor → compatibility → workspace → runtime → consent                                   |

## Two findings this code exists to handle

**The framework and adapters emit shell command strings.**
`Experimental_SandboxSession.run/spawn` takes `{ command: string }`, and the
pinned code fills it with `mkdir -p …`, `pnpm install …`, and
`node '<bootstrapDir>/bridge.mjs' …`. In a cloud sandbox that string goes to a
shell inside the box. On a host it must not. `command-translation.ts` takes the
reviewed option: recognize only the exact pinned shapes, translate them to
structured operations, and **reject everything else** — there is no general
shell parser and no `shell: true`. An adapter upgrade that changes a shape
fails the session closed, which is the signal to re-review the manifest.

That is not hypothetical. This module was first written against
`@ai-sdk/harness-claude-code@1.0.0-canary.9`; the repo then moved to the stable
`1.0` line, and almost every shape changed — the bootstrap directory went from
an absolute `/tmp` path to one relative to the working directory, operands
became shell-quoted, Codex swapped `--bootstrap-dir` for `--cli-shim-dir`, and
the framework moved two of its own `mkdir`s onto environment-variable
indirection. The manifest's exact-version pin is what surfaced it.

It also **remaps** the adapters' `.harness-bootstrap/<id>` directory — which
the framework resolves against the session's working directory, i.e. inside the
user's granted workspace — onto the digest-verified managed bundle. A vendor
CLI's whole dependency graph does not belong in somebody's checkout, and the
`pnpm install` that would put it there is exactly the runtime bootstrapping the
design forbids. Both become no-ops against a bundle built in CI.

### The bootstrap recipe is not only commands

`run` is not the only way the recipe reaches the machine: the framework applies
the recipe's FILES by calling `writeTextFile` on the session. Translating the
commands but letting those writes through would still put the adapter's
`package.json`, `pnpm-lock.yaml` and `bridge.mjs` into the user's checkout —
files that then sit in their VCS status and are never even read, because every
reference to them is remapped onto the bundle.

So the same closed grammar applies to paths. `classifyBootstrapPath` sorts a
path under the bootstrap directory into exactly three outcomes:

| Path                                                 | Outcome                                                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| a file the manifest lists in `adapterBootstrapFiles` | served from the verified bundle; a write is **compared** against the bundle's bytes and fails closed on any difference |
| the framework's `.bootstrap-<identity>.ok` marker    | written to session-owned state, so nothing is left behind in the workspace                                             |
| anything else                                        | rejected — the recipe changed and the manifest needs re-review                                                         |

Comparing rather than writing is the point: if the adapter's `bridge.mjs`
differs from the bundle's, the session would be running bytes the adapter did
not bootstrap. That is a bundle rebuild, not something to paper over.

**The pinned bridges bind `0.0.0.0`.**
Harmless inside a sandbox; on a laptop it publishes an agent control channel to
the local network. `bridge-endpoint.ts` returns loopback authorities only, and
`assertBridgeIsLoopbackOnly()` actually attempts a connection through this
machine's non-loopback addresses and fails the session if one is accepted. The
bundle build is expected to bind loopback; the probe is what makes that
enforceable rather than aspirational.

### The bridge probe is mandatory, and waits for the bridge

An exposure probe that runs before the listener exists proves nothing: every
connection is refused, the probe passes, and a bridge that binds `0.0.0.0` a
moment later is admitted with a clean bill of health. So the provider waits for
the port to accept a loopback connection, and only then tests whether it is
_also_ reachable through this machine's non-loopback addresses. Either failure
stops the session, and the root process is killed rather than left running
behind the refusal.

It also has to be _our_ bridge. A TCP probe answers "something is listening",
not "the process we started is". Two checks close the gap from both sides: the
leased port must be unclaimed on both loopback families immediately **before**
the spawn, and the supervised process must still be alive **after** the binding
is verified. What is left is the window between the pre-launch check and the
bridge's own `bind`, which only a process already running as this user could
win, and closing even that needs a handshake nonce the vendor bridges do not
speak.

### A trusted file under an untrusted directory is not trusted

`unlink` and `rename` are authorized by the containing **directory's**
permissions, not the file's. A root-owned, mode-0755 vendor binary sitting in a
user-writable directory can therefore be moved aside and replaced wholesale by
the very agent about to be launched — its uid and mode are unchanged, because a
new file simply takes its name. System-install discovery walks the whole
ancestor chain and refuses any directory that is not system-owned, or that is
group- or world-writable without the sticky bit. Sticky is not a loophole: on a
sticky directory only a file's owner may unlink or rename it, which is exactly
the property being checked, and it is why `/tmp` is mode 1777.

Mode bits are not blind to POSIX ACLs, which matters because the check would be
much weaker if they were: the group bits carry the ACL **mask** once a directory
has an ACL, so an entry granting another user write makes this fire. Verified
rather than assumed — on a 0755 directory, adding `u:65534:rwx` moves `st_mode`
to 0775.

macOS is the case it cannot cover. NFSv4-style ACLs there grant rights such as
`delete_child` without appearing in `st_mode` at all, and Node exposes no way to
read them, so `system-install` is **refused outright on darwin** rather than
checked with a test known to be blind. Managed bundles are unaffected: their
whole tree is digest-verified.

### A dangling symlink is a link, not an absence

`realpath` fails on a symlink whose target does not exist, so an ancestor walk
built only on it classifies such a link as "a name that is not there yet" and
re-attaches it literally — landing back inside the root and passing. The link
still redirects the write, and `open(…, "w")` follows it and creates the
target. No race is involved: the model can plant
`<workspace>/x -> ~/.ssh/authorized_keys` itself and then ask the Inspector
file API to write `x`. Every not-yet-resolved segment is therefore `lstat`ed,
and one that exists as a symlink is followed explicitly, with a hop cap so a
chain or a cycle cannot spin.

This is distinct from the TOCTOU race described in `confine.ts`'s own header
and in the invariant table below, which remains open.

### "Gone" and "cannot tell" are different answers

A liveness probe can fail three ways, and collapsing them is a safety bug in
both directions. `probeProcess` returns `alive` / `gone` / `unknown`: only
`gone` authorizes dropping a durable record or reporting a session stopped, and
only a supervisor we can PROVE exited leaves its trees for the janitor. A `ps`
timeout, an unreadable `/proc`, or a platform with no primitive answers
`unknown`, which authorizes nothing. An earlier draft returned `null` for both,
which meant a probe failure could report a live tree as stopped and let a second
Inspector window reclaim a healthy instance's sessions.

### A zombie is a dead process

`/proc/<pid>/stat` still exists after a process exits, until something reaps it.
A liveness check built on "can I read the stat file" therefore reports a
**dead** process as alive — and then a tree we successfully killed is reported
as having escaped, `stopSession` refuses to say the session stopped, and the
janitor never reclaims the record.

Whether that is ever _observed_ depends on the environment. When PID 1 reaps
orphans, a killed descendant vanishes at once and nothing looks wrong. Inside a
container whose PID 1 is an application rather than a real init — which is where
CI runs — orphaned zombies persist indefinitely. `process-identity.ts` reads the
state field and treats `Z`/`X`/`x` as gone, on both the Linux `/proc` path and
the macOS `ps` path, and both parsers are pure and directly tested.

## Invariants, and where each is enforced

1. Local processes launch only through `LocalHarnessSupervisor` — `supervisor.ts`.
2. Absolute launcher path, structured argv, `shell: false`, sanitized env, registered owner — `supervisor.ts`, `argv-policy.ts`, `session-env.ts`.
3. Runtime identity resolved and verified before consent, and re-verified before spawn; no spawn-time `PATH` lookup — `runtime-identity.ts`, `availability.ts`.
4. No user, model, repository, or MCP input becomes a shell command string — `command-translation.ts`.
5. Workspace canonicalized and bound to a grant; symlink checks at the boundary — `grants.ts`, `confine.ts`.
6. Native is never labelled sandboxed or isolated — `targets.ts`.
7. Isolated starts only after backend verification, and never degrades to native — `compatibility.ts`.
8. Permission mode always explicit; the SDK's `allow-all` default is never inherited — `compatibility.ts`, `availability.ts`.
9. Nothing is installed during a session — `command-translation.ts`.
10. Secrets stay out of argv, persisted state, and logs — `session-env.ts`, `grants.ts`.
11. Every terminal path kills the whole owned tree — `supervisor.ts`, `process-identity.ts`. `stopped` is reported only on a proven `gone`; an `unknown` probe counts with `escaped`.
12. A pid alone never proves ownership — `process-identity.ts`, `process-registry.ts`. A supervisor _nonce_ alone does not prove its owner exited either: the janitor requires the owning Inspector's pid and birth identity to be provably gone, so a second window cannot reclaim the first's live sessions.
13. Unsupported tuples fail closed with actionable diagnostics — `compatibility.ts`, `availability.ts`.
14. Attended, explicitly scoped consent — `grants.ts`, `availability.ts`.

## Enabling it

`MCPJAM_LOCAL_HARNESS_ENABLED=true`, and only on a non-hosted server. Default
off, unlike the local computer engine's flag: a local bash command is discrete
and separately approved, a local harness is a long-lived agent process.

The flag alone is not enough, and deliberately so. Every shipped manifest entry
carries an empty `lifecycleConformanceVersion`, so
`resolveLocalHarnessAvailability` refuses with `conformance-missing` before it
ever looks at a runtime; the all-zero bundle digests are a second closed door
behind it (a real bundle can never hash to zeroes), surfaced as
`runtime-unavailable` carrying the underlying `bundle-digest-mismatch`. The flag
enables the feature; it does not certify it.

## What is not here yet

Deliberately out of scope for this change, and none of it is faked:

- **B1** the proof-bound local broker capability, and the scoped model gateway
  (`scopedEnv` is the seam it plugs into);
- **I1's** UI: the Electron directory picker and loopback consent routes that
  call `registerWorkspaceGrant` / `grantLocalHarnessConsent`;
- **I2's** CI bundle build, SBOM, signing, and license review — until it lands,
  the manifest digests are placeholders that cannot match a real tree;
- **I5's** turn integration, suspend/continue, and staged materialization with
  diff-based apply-back;
- **I6's** isolation backends (bubblewrap, Seatbelt);
- **I7's** consent and diagnostics UI;
- **I8's** rollout gating and the full cross-platform conformance run.
