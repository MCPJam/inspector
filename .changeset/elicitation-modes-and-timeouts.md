---
"@mcpjam/sdk": minor
---

Elicitation mode/serverId passthrough and elicitation-aware tool timeouts. Additive: existing callbacks and call sites are unaffected.

- `ElicitationCallbackRequest` gains optional `serverId`, `mode` (`"form" | "url"`, absent ⇒ form), `url`, and `elicitationId`, so a global elicitation callback can tell which server asked, render URL-mode consent (MCP 2025-11-25), and correlate the server-chosen elicitation id. Form mode keeps reading `requestedSchema ?? schema`.
- `ElicitationManager.applyToClient` takes an optional third argument carrying the `elicitation` client capability actually advertised on the wire, and rejects elicitations whose mode was not declared with JSON-RPC `-32602` per spec (bare `{}` ≡ form-only; `{form:{},url:{}}` allows both). Mode-vs-declaration semantics come from upstream's own `getSupportedElicitationModes`, so they cannot drift from what the upstream `Client` enforces. New `hasPendingForServer(serverId)` reports whether an elicitation handler is currently in flight.
- New `MCPClientManagerOptions.elicitationTimeoutExtensionMs` (default 10 minutes, exported as `DEFAULT_ELICITATION_TIMEOUT_EXTENSION_MS`). When a server has an elicitation handler, `executeTool` no longer lets the per-request timeout kill a tool call that is merely blocked on a human: the base timeout is enforced by a watchdog that only accumulates time while no elicitation is pending, while total time spent suspended across all elicitations in the call is capped by the extension. A genuinely hung server still dies at its base timeout. Aborts are timeout-shaped (`SdkError` / `SdkErrorCode.RequestTimeout`) and never classified as retryable. Servers without an elicitation handler are a pure passthrough.
- New `ElicitationMode` and `DeclaredElicitationCapability` type exports.
