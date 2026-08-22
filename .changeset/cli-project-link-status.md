---
"@mcpjam/cli": major
---

Add `mcpjam cloud link` and `mcpjam cloud status`. Project-scoped Cloud commands resolve `--project`, then a `--file`/`--json` input document, then `MCPJAM_PROJECT`, then `.mcpjam/project.json`, then automatic selection (most recently updated). `MCPJAM_PROJECT_ID` does not select a Cloud CLI project.
