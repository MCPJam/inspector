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
| `local-state-lock.ts`    | Reusable cross-process lock for security-sensitive local state mutations                                                     |
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

Every Inspector file operation is capped at 16 MiB by default. Reads stream
through the cap (and detect a file that grows after its initial `stat`), while
writes are bounded before an owner-only temporary file is atomically renamed
over the target. An oversized or aborted adapter stream therefore cannot grow
the Inspector heap without bound or leave a partially written workspace file.

The SDK's `restricted()` view is also a real capability object, not a type cast
over the full session. It contains only file and process methods and is frozen;
port mutation, endpoint resolution, stop, and destroy are absent at runtime.

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

### A gone root is not a gone tree

A descendant that ignores `SIGTERM` keeps running while the leader exits, so
"the root's pid is gone" does not mean "the tree is gone" — and reporting a
graceful stop on the root's own disappearance announces a stopped session over
a live vendor process. Every path that would report the tree terminated checks
the process GROUP first, escalates to `SIGKILL` if anything is still there, and
reports `escaped` if it survives that.

The direct child's `close` event does not discard ownership either. Its entry
becomes a non-live tombstone that no longer consumes a concurrency slot, but it
stays attached to the session until `stopSession` proves the process group
empty. This covers a bridge that crashes or exits naturally before cleanup,
not only a leader that exits in response to the supervisor's own signal.

The group check cannot be `kill(-pgid, 0)`, for the same reason the single
process probe cannot be "`/proc/<pid>/stat` exists": a ZOMBIE still belongs to
its group, so signal-0 succeeds over a group whose every member has already
exited. That answered "the tree survived" for a tree that was entirely dead —
turning a completed stop into a reported escape and stopping the janitor ever
reclaiming the record. Members are enumerated and their states read instead.

And that enumeration is itself tri-state, `live` / `empty` / `unknown`, for the
same reason the single-process probe is. The first version returned a boolean
and mapped every failure to `false`, reasoning that the value "only gates
escalation, never a kill" — which was simply wrong about its own callers:
`false` is what reports the tree gone and what makes the janitor DROP a record.
An unreadable `/proc` or a `ps` timeout therefore announced a stopped session
over live descendants and discarded the only handle on them. Worth stating
because it has now been the same mistake four times in this directory: **a
check that could not look must never answer "nothing there".**

The fourth was inside the fix for the third — the member scan skipped any
`/proc/<pid>/stat` it could not read and still concluded `empty`, so a process
it never examined could have been the live one. Finding a live member is still a
sound `live`; concluding `empty` claims "no member of this group is alive", and
that claim is not available if a candidate went unread. The scan tracks that and
answers `unknown` instead.

`EACCES` does **not** get an exemption, and the reasoning that nearly gave it
one is worth keeping. These files are world-readable (checked: as uid 65534, all
79 entries on this machine read fine), so a refusal means the process belongs to
another user — and every member of our group is one we forked. That argument is
sound right up to the case it misses: a supervised descendant that changes uid
becomes exactly such an entry under a `hidepid` mount, and exempting the error
then reports the tree gone while it is running.

The trade is a fail-OPEN safety hole against a fail-CLOSED functional one. On a
`hidepid` mount the probe answers `unknown` often, so stops report unproven and
the janitor retains records rather than reclaiming them. Given that this file
exists because the same trade kept being made the wrong way round, it is made
the other way here.

An unprovable group is **not** force-killed either, and the reason is narrow.
Every caller of `settleGroup` has already proven the ROOT is gone, so its pid is
free for reuse; what makes `kill(-pid)` safe anyway is that a pid serving as a
process-GROUP id is not reissued _while that group has members_ — a guarantee
about a non-empty group, and `unknown` is exactly the failure to establish it.
So the general rule that `unknown` gates reporting rather than action does not
reach this signal: the action needs the very fact `unknown` is missing.

`live` is necessary but not sufficient, and the first version of this paragraph
got that wrong — it read the rule as making a non-empty group's id proof that
the group was ours. It is not. The rule is about the FUTURE of a group that
still has a member: from that moment its id cannot be reissued underneath us. It
says nothing about a group that emptied. Once ours emptied its id went free, and
any unrelated process could have taken that pid, made itself a group leader and
exited, leaving a live group wearing our recorded id with nothing of ours in it
— which is what an ordinary shell pipeline whose first stage exits early, or a
double-forking daemon, leaves behind. So `live` says a group with this id
exists, not that it is ours.

What makes it ours is an **anchor**: a moment at which the group was known to be
ours _and_ non-empty. A stranger's group carrying our id can only have been
created after ours emptied, so it cannot predate the anchor. Inside a single
termination call there is one — the root was verified alive and carrying its
recorded birth identity just before being signalled, and a leader belongs to its
own group — and only the grace window separates it from the probe.

Two paths have no anchor at all, and neither signals now:

- `settleGroup` reached with the root already gone on its FIRST look. Nothing in
  that call ever saw the tree; the group is reported, not signalled.
- The janitor's dead-root branch. It only runs for a record whose owning
  supervisor has provably exited, so arbitrary time has passed since anything of
  ours was in that group. It reports `escaped` and keeps the record.

That costs a real capability: a stray left behind by a harness that exited on
its own is no longer swept at `stopSession`. It is reported and its record
retained instead, which an operator can act on — the trade being that an
unswept survivor you can see beats a `SIGKILL` delivered to whoever now holds
the id. Restoring the sweep soundly needs per-MEMBER identity rather than a
group signal: enumerate the group once at the instant the root exits, while its
id provably still belongs to us, record each member's pid and birth identity,
and then verify each with `isSameProcess` before signalling it individually.
That is immune to pid reuse; it is also a new platform primitive plus supervisor
plumbing, and is not implemented yet.

Even the anchored signal is bounded rather than airtight: our group could empty
and its id be reissued inside the grace window. That needs the pid space to wrap
within a few seconds, and ruling it out needs the same per-member identity proof.
It is stated here rather than papered over.

These lines have been written both ways, so every direction is pinned by tests,
and each was checked to fail against the opposite behaviour rather than merely
to pass against the current one.

### "Gone" and "cannot tell" are different answers

A liveness probe can fail three ways, and collapsing them is a safety bug in
both directions. `probeProcess` returns `alive` / `gone` / `unknown`: only
`gone` authorizes dropping a durable record or reporting a session stopped, and
only a supervisor we can PROVE exited leaves its trees for the janitor. A `ps`
timeout, an unreadable `/proc`, or a platform with no primitive answers
`unknown`, which authorizes nothing. An earlier draft returned `null` for both,
which meant a probe failure could report a live tree as stopped and let a second
Inspector window reclaim a healthy instance's sessions.

The distinction has to survive into what the janitor REPORTS, too, which is a
step it kept skipping. An unsettled termination was announced as `not-owned`
whether the pid genuinely belonged to somebody else or the answer was merely
unprovable — and the two want opposite follow-ups: a real mismatch is terminal
and the record should sit there for a human to look at, while an unprovable one
is transient and the next sweep should just try again. `skipped-unprovable`,
which every other blind spot in the file already used, now covers it. Gating the
group signal on an ownership anchor is what made this bite: `unknown` went from
a rare probe failure to the routine answer for a tree whose root exited on its
own.

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
14. Attended, explicitly scoped consent, with mutations serialized across Inspector processes and unreadable state never treated as empty — `grants.ts`, `local-state-lock.ts`, `availability.ts`.
15. The tool-facing restricted session is a separate runtime capability, and file transfers are bounded and atomically replaced — `supervised-provider.ts`.

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
