---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

Tasks conformance: `tasks-input-required-update-completes` is now `tasks-update-ack-shape`, and it counts toward the score (`mcp-tasks` profile `2026-11-01.1`). It checks only what the extension requires of the `tasks/update` reply: an empty result with `resultType: "complete"`. It no longer fails a task that hasn't finished by the poll timeout, because the extension lets an answered task keep working or ask for more input. Without `--input-responses` the check is not applicable instead of could not run. A server that rejects the update now reads as could not run instead of failed, because the answers come from the user. The app hides this check for now, since it can't send input answers. Compatibility: pass the new id to `--check-id`.
