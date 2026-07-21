---
"@mcpjam/sdk": patch
---

Validate declared draft-07 tool schemas instead of rejecting them. The upstream v2 client's default validator is 2020-12-only and hard-fails `tools/call` for any tool whose `outputSchema` declares `"$schema": ".../draft-07/schema#"` — which is every MCP TypeScript SDK v1 server built with zod. The spec permits an explicitly declared draft-07 dialect on all protocol versions (2020-12 is only the default when `$schema` is absent), so the SDK now dispatches on the declared `$schema`: absent/2020-12 → Ajv 2020-12, draft-07 → Ajv draft-07, unknown dialects → skipped (reported via `onUnknownDialect`) rather than failing the call. Wired into `MCPClientManager`, `createManagedMcpClient`, and the browser HTTP doctor; exported as `DialectAwareJsonSchemaValidator`.
