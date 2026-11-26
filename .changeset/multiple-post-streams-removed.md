---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

Removed the Multiple POST Streams protocol check (`server-accepts-multiple-post-streams`). The only rule behind it, "The client MAY remain connected to multiple SSE streams simultaneously", binds the client, so the check failed servers for a requirement the 2025 revisions do not state. The `mcp-protocol` profile is now `2026-11-25.1` and scores 43 checks. A config or `--check-id` list that still names the check runs its other checks; a list that names only this check is refused with the reason, before any suite of a `conformance run` starts. `REMOVED_MCP_CHECK_IDS` lists removed ids. Functional SSE Streams no longer fails a server for refusing one of its three concurrent POSTs: it grades only the streams that came back, and could not run when none did.
