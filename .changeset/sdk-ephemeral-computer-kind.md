---
"@mcpjam/sdk": minor
---

Host config: accept the runtime-minted `ephemeral` computer kind on the canonical side.

`canonicalizeComputer` took a closed union of exactly one value, `"personal"`, and hard-threw on anything else. That made a whole class of platform-minted host config unrepresentable: an eval run pins one box per iteration and boots it from the run's frozen environment image, so the computer attached to that run's pinned host config is a per-run box, not the author's personal cloud workstation. There was no legal shape for it, so the run's snapshot had to drop the field — and a host that asked for a computer (or a harness, which needs one) silently reproduced as a host without one.

`kind` is now the closed union `"personal" | "ephemeral"`:

- `"personal"` — the per-(project, user) cloud workstation. Unchanged.
- `"ephemeral"` — a per-run box the platform mints at a snapshot boundary.

The legacy `toolset` key is accepted-and-dropped for **both** kinds, so `{ kind, toolset: "bash" }` and `{ kind }` remain one identity. The image never rides this field — it comes from the run's frozen environment pin.

`workdir` is canonicalized identically for both kinds. A per-run box takes its working directory from provisioning, so the platform's minting site emits none — but that is a rule about what gets written, enforced there rather than here: canonicalization stays pure content-addressing, and nothing can author an ephemeral computer in the first place.

`ephemeral` is **output-only**: it appears on canonical and persisted rows and can come back when you read a snapshot, but it is not authorable. Every authoring input stays personal-only — `HostComputerInput` is now its own personal-only type rather than an alias of the canonical shape, and `HostInit.computer` is typed to it. Treat an ephemeral computer as read-only snapshot data.

Hashing is unaffected for existing rows: every pre-existing golden vector canonicalizes to byte-identical JSON with an unchanged sha256. The parity fixture gains two vectors (`computer-ephemeral`, `computer-ephemeral-with-toolset-dropped`) that pin the new bytes, which is what lets the backend prove its own canonicalizer agrees.
