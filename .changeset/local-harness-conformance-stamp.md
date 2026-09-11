---
"@mcpjam/inspector": patch
---

Record the local-harness lifecycle conformance evidence for claude-code
(`local-1f3f53f38f40`). Until now the manifest carried no evidence, which
`resolveLocalCompatibility` treats as expired — so every platform refused with
`conformance-missing` regardless of packs, digests or flags. Codex stays empty:
it is native nowhere and the suite does not run for it.
