---
"@mcpjam/sdk": patch
---

Unsupported Envelope Version (`modern-unsupported-version-error`) now reads the `-32022` error's `data` as the 2026-07-28 schema defines it: `supported` and `requested` are both required. It used to accept the list under `supportedVersions` and never read `requested`, so an error missing either member passed. The failure message names the member, and says so when the list is under `supportedVersions`. The check's details gain `requestedVersion`.
