---
"@mcpjam/inspector": patch
---

Hosted Codex turns no longer start with "Codex is ignoring 1 unrecognized configuration setting" in their trace. The session config dropped `preferred_auth_method`, which Codex 0.163.0 does not read; the model proxy's key still comes from the provider's `env_key`.
