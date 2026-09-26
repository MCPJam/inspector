---
"@mcpjam/inspector": patch
---

Suite runs of an environment that pins plugins now hand the model the plugin servers' tools. The run snapshot keeps plugin servers out of its host config, and the runner built the model's tool set from that snapshot alone, so a plugin-only environment ran with no tools and a mixed one with only its server group's, while the plugin servers sat connected and unused. The execution selection is now the frozen server group plus the plugin servers re-gated just before the run.
