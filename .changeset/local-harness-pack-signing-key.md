---
"@mcpjam/inspector": patch
---

Trust the local-harness runtime pack release key. `PACK_SIGNING_KEYS` shipped
empty, which refused every network-sourced pack — the correct default before a
key existed, and a hard blocker on publishing packs at all. The public half of
the Ed25519 release key is now committed; the private half lives only in CI.
