---
"@mcpjam/inspector": patch
"@mcpjam/cli": patch
---

Agents and the CLI can propose, start, and read a two-arm description experiment

**A rewrite had a contract and no way to launch it.** `POST /projects/:p/eval-runs/:r/description-experiments`, `POST /projects/:p/eval-description-experiments/:e/start`, and `GET /projects/:p/eval-description-experiments/:e` land the inspector half: propose a rewrite, launch original + rewrite as one grouped intent, and read the document (502 if a present report fails the published schema). The emulated runner applies `{ experimentId }` only — never caller-supplied description text — and stamps `metadata.descriptionExperiment.applied` as a nested object. CLI (`cloud eval description-experiment`) and MCP catalog pick up the three operations.
