---
"@mcpjam/inspector": minor
---

Serve server variants (beta). A connection to a variant's server ID dials its base with the caller's own credentials and changes only the edited tool descriptions in `tools/list`. A run on a variant whose base changed an edited tool is refused with `VARIANT_BASE_DRIFTED`, naming the tools, instead of running without them. `POST /api/v1/projects/{projectId}/variant-servers` creates a variant, and an eval run read lists the variants the run served as `variants`.
