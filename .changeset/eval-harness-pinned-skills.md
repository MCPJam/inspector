---
"@mcpjam/inspector": minor
---

Harness evals deliver the run's PINNED skills, not the live project pool.

A harness turn materializes skills on the sandbox and picks its source through a strict precedence — `pinned` → `environment` → `live` — where only the top rank promises that nothing live is consulted. Selection is by PRESENCE, not length: passing nothing falls through to a project-wide fetch resolved at turn time.

An eval run had nothing to pass, so every harness eval turn took that fall-through. Two consequences, both silent:

- **A frozen run wasn't frozen.** The run pins its skills at start precisely so a re-run is byte-identical; the harness turn re-read whatever the project held at that moment, so editing a project skill mid-run changed what a running iteration saw.
- **The "without skills" A/B arm ran with skills.** `skillsOverride: "exclude"` pins an empty set — which, sent as "nothing", is indistinguishable from an unpinned run and drew the entire project pool.

The run's pins now reach the harness as `PinnedSkillArtifact[]`, adapted at the run boundary where the pin rows and their signed file URLs are in hand. Every runId-bearing run passes an explicit list, empty included.

The adapter synthesizes nothing. Identity, preserved frontmatter and channel provenance carry straight off the pin, and `contentHash` takes the pin's `aggregateHash` when present — the complete-envelope fingerprint, which is what on-box reconcile compares. Using the body-only hash there would make a skill whose supporting FILES changed look unchanged, so a reused sandbox would keep the previous run's scripts.

Supporting-file bodies are downloaded during run preparation rather than per iteration: once instead of N times, and before any model call, so a failure fails the run cleanly and names the skill and path — the same discipline as the existing pinned-blob reachability check. A file that cannot be fetched stops the run instead of shipping a skill without its scripts.

The delivery rides `pinnedHarnessSkills` (the frozen-run channel), not `runtimeSkillsOverride` (the live-environment channel one rank below it). The two behave alike in the happy case and differ in exactly the case that matters here.
