---
"@mcpjam/inspector": patch
---

Eval runs refuse what they can't deliver, instead of running a different configuration and reporting on it.

**A computer-backed built-in with no computer is now a refusal.** `resolveHostTools` warn-and-skips `bash` when no computer is attached, so a `bash`-granting host with no pinned environment image ran with the shell silently absent: cases that needed one failed as if the model had chosen badly, and a suite that didn't need one reported green for a host configuration that never existed. A server log is not a result — nobody reading the run sees it. This is checked for **every** eval run, harness or emulated; it deliberately cannot live in the harness admission checks, which return admitted on their first line when no harness is selected — exactly the runs the rule is about.

**A harness run with no project is refused at pre-flight.** An org-level suite has no project, and `runHarnessTurn` discovers that only when it tries to resolve the box — mid-iteration, after the sandbox has been booted and charged. It now fails before any spending, and names the project rather than the pinned image (an org-level suite has neither, and "pin a computer image" points at a setting that can't fix it).

**A runner capability declaration at run creation.** Run creates now declare `runnerCapabilities: ["harness-execution"]`. The backend pins a run's host config at start and stamps its `executionEngine` from it; without a declaration it would stamp `harness:*` for runs created by older desktop or local inspectors that talk to the same hosted Convex and still emulate. A false stamp is worse than the silent emulation being fixed — silent emulation is at least unlabelled. Undeclared runners keep today's behavior, honestly labelled `emulated`. Temporary, retired once old runner versions age out.

**An ephemeral computer is read-only snapshot data.** The client hydrator rewrote every computer's `kind` to `"personal"` on read. With the platform now minting `kind: "ephemeral"` for per-run boxes, that laundering would let a run's pinned config be read and saved onto a live host — turning a disposable per-run box into a claim on the member's own machine. The kind is carried through unchanged, editor drafts drop a non-personal attachment rather than converting it, and draft-equality compares `kind` (two attachments differing only by kind previously compared equal).
