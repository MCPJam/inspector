---
"@mcpjam/sdk": minor
---

Export `assertCallToolResult` and `isCallToolResult` so a TypeScript caller can
narrow what `executeTool` returns, and fix the README's first example, which did
not type-check and asserted a result the everything server never sends.
