---
"@mcpjam/sdk": minor
---

Add `computer` as a HostConfig v2 dimension. A host config can now declare a personal cloud workstation (the chat `bash` tool + a web terminal) via `computer?: null | { kind: "personal"; toolset: "bash"; workdir?: string }`. The canonicalizer collapses `null` and an absent value to the same "no computer" shape (key omitted), so every existing host config keeps a byte-identical `configHash`; it validates the `kind`/`toolset` literals, rejects unknown keys, and trims `workdir`. The field is stripped from the SDK→backend eval wire config, because a personal computer is mutable per-user state that an eval can't reproduce. Part of Project Computers (plan: mcpjam-backend `docs/project-computers.md`).
