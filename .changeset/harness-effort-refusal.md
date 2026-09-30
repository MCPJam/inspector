---
"@mcpjam/inspector": patch
---

A reasoning effort saved on a harness host (Claude Code, Codex, Cursor) is now refused before any spend instead of being silently dropped. Every harness turn used to build its runtime from the model and credential alone, so the effort was ignored while the record claimed it. Each harness adapter now declares the efforts it is verified to apply (none yet), and the pre-flight, the dispatch and `runHarnessTurn` share one refusal (`setting-unsupported`). Eval and swarm admission and the v1 chat-session gate read the host's saved effort (and a case's own model-entry effort) too. Hosts with a saved effort on a harness will see "can't apply a reasoning effort yet" until an adapter's mapping is verified.
