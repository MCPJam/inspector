---
"@mcpjam/inspector": patch
---

Add the supervised-native foundation for running an official vendor harness locally, without Docker

A local harness runs as a supervised host process, not in a sandbox. The
distinction is the whole design: `local-native` has no outer containment, so its
authority is the OS user's, narrowed only by the vendor harness's own permission
controls, an explicit consent grant, process supervision, and the selected
workspace. `targetHasHostContainment()` is the single predicate every surface
agrees on and `executionTargetLabel()` the only place a mode is named, so
"native" can never be rendered as "sandboxed" by a call site that forgot.

Two properties of the pinned adapters drove the shape. They emit shell command
*strings* — in a cloud sandbox those go to a shell inside the box; on a host they
must not — so the translator recognizes only the exact pinned shapes, turns them
into structured operations, and rejects everything else. There is no shell
parser and no `shell: true`. It also remaps the adapters' `.harness-bootstrap`
directory, which the framework resolves inside the user's workspace, onto a
digest-verified managed bundle — both the commands and the recipe *files*, which
the framework writes through the session's file API — so a vendor CLI's
dependency graph never lands in somebody's checkout. Separately, the vendor bridges bind `0.0.0.0`; on a
laptop that publishes an agent control channel to the local network, so the
provider waits for the bridge to listen on loopback and then proves it is not
also reachable through a non-loopback address, stopping the session if it is.

Codex is barred from native mode structurally rather than by comment: empty
`nativePlatforms`, no permission-profile mapping, and `unrestricted` refused for
a native target regardless of what a manifest says. Windows is absent because
whole-tree cleanup cannot be guaranteed there yet.

Disabled by default behind `MCPJAM_LOCAL_HARNESS_ENABLED`, forced off hosted,
and not yet wired into the turn path. The flag alone cannot enable anything:
every manifest entry ships without conformance evidence and with a placeholder
bundle digest, so resolution fails closed until both exist.
