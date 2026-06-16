---
"@mcpjam/inspector": patch
---

Restore the cross-matrix-isolation guard's coverage after 3d-ii-b. The
`useToolInputStreaming` source-text assertion was reading the inspector path,
which became a re-export shim when the module relocated to `@mcpjam/widget-react`
— so the guard no longer scanned the real implementation. Repointed it at
`widget-react/src/useToolInputStreaming.ts` so the two-matrix architecture
defense keeps inspecting the actual code. Test-only.
